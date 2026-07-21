"""End-to-end demo — the acceptance gate for the backend foundation.

Seeds a workflow, enqueues a run, tails the SSE stream, and prints what the
canvas would render. Requires no provider keys and no B2 bucket: mock providers
generate, and local storage materializes real playable files.

    uv run python -m app.scripts.demo

Assumes the API is already running (`uv run uvicorn app.main:create_app
--factory --port 8000`) with AUTH_DEV_BYPASS=true.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

import httpx

BASE_URL = "http://localhost:8000"
HEADERS = {"X-Dev-User": "demo_user"}

DIM = "\033[2m"
BOLD = "\033[1m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
RESET = "\033[0m"


def build_graph(*, with_composite: bool) -> dict[str, Any]:
    """Text -> video and text -> audio in parallel, optionally muxed together.

    Node positions are meaningful: the compiler orders steps by visual position
    (top-to-bottom), so indices match how the graph reads on the canvas.
    """
    nodes: list[dict[str, Any]] = [
        {
            "id": "prompt_video",
            "kind": "input.text",
            "position": {"x": 0, "y": 0},
            "data": {"text": "a drone shot soaring over a coastal city at golden hour"},
        },
        {
            "id": "prompt_audio",
            "kind": "input.text",
            "position": {"x": 0, "y": 200},
            "data": {"text": "warm ambient synth pad with distant waves"},
        },
        {
            "id": "gen_video",
            "kind": "generate",
            "position": {"x": 320, "y": 0},
            "data": {
                "provider": "mock",
                "model": "mock-video-v1",
                "modality": "video",
                "params": {"duration": 6, "aspect_ratio": "16:9"},
            },
        },
        {
            "id": "gen_audio",
            "kind": "generate",
            "position": {"x": 320, "y": 200},
            "data": {
                "provider": "mock",
                "model": "mock-audio-v1",
                "modality": "audio",
                "params": {"duration": 6},
            },
        },
    ]
    edges: list[dict[str, Any]] = [
        {"id": "e1", "source": "prompt_video", "target": "gen_video", "target_handle": "prompt"},
        {"id": "e2", "source": "prompt_audio", "target": "gen_audio", "target_handle": "prompt"},
    ]

    if with_composite:
        nodes.append(
            {
                "id": "mux",
                "kind": "transform.composite",
                "position": {"x": 640, "y": 100},
                "data": {"op": "mux"},
            }
        )
        edges += [
            {"id": "e3", "source": "gen_video", "target": "mux", "target_handle": "video"},
            {"id": "e4", "source": "gen_audio", "target": "mux", "target_handle": "audio"},
        ]
        final = "mux"
    else:
        final = "gen_video"

    nodes.append(
        {"id": "out", "kind": "output", "position": {"x": 900, "y": 100}, "data": {}}
    )
    edges.append({"id": "e5", "source": final, "target": "out", "target_handle": "in"})

    return {"version": 1, "nodes": nodes, "edges": edges}


def _fmt_event(event: dict[str, Any]) -> str:
    etype = event.get("type", "?")
    node = event.get("node_id") or ""
    seq = event.get("seq")

    colour = {
        "run.started": CYAN, "run.queued": CYAN,
        "run.completed": GREEN, "run.failed": RED,
        "node.completed": GREEN, "node.failed": RED, "node.skipped": YELLOW,
    }.get(etype, "")

    detail = ""
    if etype == "node.progress" and event.get("progress_pct") is not None:
        detail = f"{event['progress_pct'] * 100:.0f}%"
    elif etype == "node.started":
        detail = f"{event.get('provider')}/{event.get('model')}"
    elif etype == "node.completed":
        assets = event.get("assets") or []
        detail = f"{len(assets)} asset(s)"
        if assets:
            detail += f"  {DIM}{assets[0].get('media_type')}{RESET}"
    elif etype == "node.failed":
        detail = str(event.get("error") or "")[:70]
    elif etype == "run.completed":
        detail = f"status={event.get('status')} assets={len(event.get('assets') or [])}"
    elif etype == "run.failed":
        detail = str(event.get("message") or event.get("status") or "")[:70]

    return f"  {DIM}{seq!s:>3}{RESET}  {colour}{etype:<16}{RESET} {node:<12} {detail}"


async def stream_run(client: httpx.AsyncClient, run_id: str) -> list[dict[str, Any]]:
    """Consume the SSE feed the way the canvas will — a fetch-style reader, not
    EventSource, because EventSource cannot send an Authorization header."""
    seen: list[dict[str, Any]] = []
    url = f"/v1/runs/{run_id}/events"

    async with client.stream("GET", url, headers={**HEADERS, "Accept": "text/event-stream"},
                             timeout=httpx.Timeout(300.0)) as response:
        response.raise_for_status()
        buffer = ""
        async for chunk in response.aiter_text():
            # SSE frames are CRLF-delimited on the wire, so splitting on "\n\n"
            # silently never matches and the buffer grows forever. Normalize
            # first — the canvas's reader must do the same.
            buffer += chunk.replace("\r\n", "\n")
            while "\n\n" in buffer:
                raw, buffer = buffer.split("\n\n", 1)
                data_lines = [
                    line[5:].strip()
                    for line in raw.splitlines()
                    if line.startswith("data:")
                ]
                if not data_lines:
                    continue
                try:
                    event = json.loads("".join(data_lines))
                except json.JSONDecodeError:
                    continue
                if event.get("type") is None:
                    continue  # keepalive
                seen.append(event)
                print(_fmt_event(event), flush=True)
    return seen


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument(
        "--composite",
        action="store_true",
        help="include an ffmpeg mux node (needs real media, so it will fail with mocks)",
    )
    args = parser.parse_args()

    async with httpx.AsyncClient(base_url=args.base_url, timeout=30.0) as client:
        ready = (await client.get("/readyz")).json()
        print(f"{BOLD}readiness{RESET}  db={ready['db']['connected']} "
              f"storage={ready['storage']['mode']} genblaze={ready['genblaze_mode']} "
              f"providers_ready={ready['providers'].get('ready')}")
        if not ready["db"]["connected"]:
            print(f"{RED}Database is not reachable — set DATABASE_URL.{RESET}")
            return 1

        graph = build_graph(with_composite=args.composite)

        print(f"\n{BOLD}1. validate{RESET}")
        validation = (
            await client.post("/v1/workflows/validate", json={"graph": graph}, headers=HEADERS)
        ).json()
        print(f"   valid={validation['valid']} "
              f"errors={len(validation['errors'])} warnings={len(validation['warnings'])}")
        for diag in validation["errors"]:
            print(f"   {RED}{diag['code']}{RESET} {diag.get('node_id') or ''}: {diag['message']}")
        if not validation["valid"]:
            return 1
        plan = validation["plan"]
        print(f"   steps={[s['node_id'] for s in plan['steps']]} "
              f"concurrency={plan['max_concurrency']} "
              f"eta={plan['estimates']['duration_sec']}s")

        print(f"\n{BOLD}2. save workflow{RESET}")
        workflow = (
            await client.post(
                "/v1/workflows",
                json={"name": "Demo — parallel video + audio", "graph": graph},
                headers=HEADERS,
            )
        ).json()
        print(f"   workflow_id={workflow['id']}")

        print(f"\n{BOLD}3. enqueue run{RESET}")
        created = await client.post(
            "/v1/runs", json={"workflow_id": workflow["id"]}, headers=HEADERS
        )
        if created.status_code >= 400:
            print(f"   {RED}{created.status_code}{RESET} {created.text[:400]}")
            return 1
        run = created.json()
        run_id = run["id"]
        print(f"   run_id={run_id} status={run['status']}")

        print(f"\n{BOLD}4. stream progress{RESET}")
        await stream_run(client, run_id)

        print(f"\n{BOLD}5. final state{RESET}")
        final = (await client.get(f"/v1/runs/{run_id}", headers=HEADERS)).json()
        status = final["status"]
        colour = GREEN if status == "succeeded" else (YELLOW if status == "partial" else RED)
        print(f"   status={colour}{status}{RESET} duration={final.get('duration_sec')}s")
        print(f"   manifest={final['manifest']}")
        for step in final.get("steps", []):
            mark = {"succeeded": f"{GREEN}✓{RESET}", "failed": f"{RED}✗{RESET}"}.get(
                step["status"], f"{YELLOW}·{RESET}"
            )
            print(f"   {mark} {step['node_id']:<12} {step['provider']}/{step['model']}"
                  f"  {step['status']}"
                  + (f"  {RED}{step['error']}{RESET}" if step.get("error") else ""))
        for asset in final.get("assets", []):
            print(f"   {CYAN}asset{RESET} {asset['media_type']:<12} "
                  f"{(asset.get('size_bytes') or 0) / 1024:.0f}KB  "
                  f"sha={(asset.get('sha256') or '')[:12]}…")
            print(f"         {asset['url']}")

        replay = (
            await client.get(f"/v1/runs/{run_id}/events/history", headers=HEADERS)
        ).json()
        print(f"\n   {DIM}event log: {len(replay['events'])} events, "
              f"last_seq={replay['last_seq']} (replayable){RESET}")

        return 0 if status in ("succeeded", "partial") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
