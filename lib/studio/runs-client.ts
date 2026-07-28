/**
 * Browser-side run trigger and progress feed.
 *
 * A run is started with an *inline* subgraph — the node the user pressed Run
 * on plus everything it depends on (and, for "run from here", everything
 * downstream) — rather than the workflow id. Node ids are preserved, so every
 * event maps straight back onto the canvas, and running one island of a large
 * canvas never bills the others.
 *
 * Progress arrives over SSE from `GET /v1/runs/{id}/events`, consumed with
 * `fetch` rather than `EventSource` because the browser's EventSource cannot
 * carry the Authorization header. If the stream drops mid-run, the reader
 * falls back to polling `/events/history` from the last seq it saw — the
 * backend keeps every event in `run_events` precisely so a consumer can
 * resume without loss.
 */

import { API_URL } from "./catalog";
import { type ApiAuth, authHeaders } from "./assets-client";
import type { Graph, GraphNode, NodeGeneration } from "./graph";

export type RunEvent = {
  seq?: number;
  type: string;
  node_id?: string | null;
  [key: string]: unknown;
};

export type RunEventAsset = {
  asset_id?: string | null;
  node_id?: string | null;
  url?: string | null;
  /** Presigned by the worker on terminal events — render this when present. */
  preview_url?: string | null;
  media_type?: string | null;
  text?: string | null;
  width?: number | null;
  height?: number | null;
  ephemeral?: boolean;
};

export type RunAssetRow = {
  id: string;
  node_id: string | null;
  url: string;
  media_type: string;
  modality: string;
  width?: number | null;
  height?: number | null;
};

export type StartRunResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** Node kinds that become run steps — the ones worth painting run state on. */
export function isStepKind(kind: string): boolean {
  return kind === "generate" || kind === "transform.composite";
}

/** The last known result of a node, hydrated from prior runs. */
export type NodeResult = {
  assetId: string | null;
  url: string | null;
  mediaType: string | null;
  text: string | null;
};

/**
 * The graph one Run press means.
 *
 * "node" runs exactly the pressed node; "chain" runs it and everything
 * downstream — never upstream. A connection from outside that scope is fed by
 * the source node's *previous result*: an LLM's words become an inline text
 * node, media becomes an upload node referencing the stored asset, both under
 * the source's own id so the edges hold. A needed input with no result yet is
 * an error naming the node, not a silent re-run of it.
 */
export function buildRunGraph(
  graph: Graph,
  nodeId: string,
  scope: "node" | "chain",
  results: Record<string, NodeResult>,
): { ok: true; graph: Graph } | { ok: false; error: string } {
  const targets = new Map<string, string[]>();
  for (const e of graph.edges) {
    targets.set(e.source, [...(targets.get(e.source) ?? []), e.target]);
  }

  const scoped = new Set<string>([nodeId]);
  if (scope === "chain") {
    const stack = [nodeId];
    while (stack.length) {
      const current = stack.pop()!;
      for (const child of targets.get(current) ?? []) {
        if (!scoped.has(child)) {
          scoped.add(child);
          stack.push(child);
        }
      }
    }
  }

  return completeScopedGraph(graph, scoped, results);
}

/**
 * The whole point of an agent proposal is that it runs as ONE unit — every
 * proposed node in a single run, so the backend planner sequences the video
 * behind its start frame and the mix behind both. Same substitution rules as
 * `buildRunGraph`; only how the scope was chosen differs.
 */
export function buildRunGraphForNodes(
  graph: Graph,
  nodeIds: string[],
  results: Record<string, NodeResult>,
): { ok: true; graph: Graph } | { ok: false; error: string } {
  return completeScopedGraph(graph, new Set(nodeIds), results);
}

/** Closes a chosen scope over its inputs — see `buildRunGraph`'s doc comment. */
function completeScopedGraph(
  graph: Graph,
  scoped: Set<string>,
  results: Record<string, NodeResult>,
): { ok: true; graph: Graph } | { ok: false; error: string } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const included = new Map<string, GraphNode>();
  for (const id of scoped) {
    const node = byId.get(id);
    if (node) included.set(id, node);
  }

  for (const edge of graph.edges) {
    if (!scoped.has(edge.target) || included.has(edge.source)) continue;
    const source = byId.get(edge.source);
    if (!source) continue;

    // Data nodes carry their value with them — include as-is.
    if (source.kind === "input.text" || source.kind === "input.upload") {
      included.set(source.id, source);
      continue;
    }

    // A generate/composite node outside the scope: stand in its last result.
    const prior = results[source.id];
    if (prior?.text) {
      included.set(source.id, {
        id: source.id,
        kind: "input.text",
        position: source.position,
        data: { text: prior.text },
      });
    } else if (prior?.assetId) {
      included.set(source.id, {
        id: source.id,
        kind: "input.upload",
        position: source.position,
        data: { asset_id: prior.assetId, title: null },
      });
    } else {
      const title = typeof source.data.title === "string" ? source.data.title : null;
      return {
        ok: false,
        error: `"${title ?? "The connected node"}" hasn't been run yet — run it first, or use "Run from here" on it.`,
      };
    }
  }

  return {
    ok: true,
    graph: {
      version: graph.version,
      nodes: [...included.values()],
      edges: graph.edges.filter((e) => included.has(e.source) && included.has(e.target)),
    },
  };
}

/** The nodes of a subgraph that will exist as run steps. */
export function stepNodes(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => isStepKind(n.kind));
}

export async function startRun(
  graph: Graph,
  workflowId: string | null,
  auth: ApiAuth,
): Promise<StartRunResult> {
  try {
    const res = await fetch(`${API_URL}/v1/runs`, {
      method: "POST",
      headers: {
        ...authHeaders(auth.token, auth.userId),
        "Content-Type": "application/json",
        // A double-clicked Run must not spend twice on a paid provider.
        "Idempotency-Key": crypto.randomUUID(),
      },
      // workflow_id rides along so results stay attached to this canvas and
      // can be re-hydrated when it is reopened.
      body: JSON.stringify({ graph, workflow_id: workflowId ?? undefined }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // RFC 9457 problem body; compiler diagnostics ride in `errors`.
      const diagnostics = Array.isArray(body.errors)
        ? (body.errors as { message?: string }[])
            .map((e) => e.message)
            .filter(Boolean)
            .join(" ")
        : "";
      return {
        ok: false,
        error:
          [body.detail, diagnostics].filter(Boolean).join(" ") ||
          "The run could not be started.",
      };
    }
    return { ok: true, id: String(body.id) };
  } catch {
    return { ok: false, error: "The backend is not reachable." };
  }
}

/**
 * Recent generations per node (newest first) from every prior run of this
 * workflow — what puts yesterday's image back in its node, and fills the
 * carousel of earlier takes, when the canvas is reopened.
 *
 * `null` means the request itself failed, which is not the same as a workflow
 * that has never been run: the caller retries the first and not the second. A
 * failure treated as "no results" is exactly the bug where a node with
 * generations reopens looking brand new.
 */
export async function fetchWorkflowResults(
  workflowId: string,
  auth: ApiAuth,
): Promise<Record<string, NodeGeneration[]> | null> {
  try {
    const res = await fetch(`${API_URL}/v1/workflows/${workflowId}/results`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results: {
        node_id: string;
        asset_id: string;
        url: string | null;
        media_type: string | null;
        text: string | null;
        width: number | null;
        height: number | null;
        created_at: string | null;
        captioned?: boolean;
      }[];
    };
    const out: Record<string, NodeGeneration[]> = {};
    // The endpoint orders newest-first within each node; push preserves it.
    for (const r of body.results) {
      (out[r.node_id] ??= []).push({
        assetId: r.asset_id,
        url: r.url,
        mediaType: r.media_type,
        text: r.text,
        width: r.width,
        height: r.height,
        createdAt: r.created_at,
        captioned: Boolean(r.captioned),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Save a node's result as a file. The bytes come through the API (which
 * attaches a download disposition) because B2 serves no CORS headers, so the
 * presigned URL itself cannot be `fetch`ed from the browser.
 */
export async function downloadResult(
  result: { assetId?: string | null; url?: string | null },
  filename: string,
  auth: ApiAuth,
): Promise<boolean> {
  try {
    let blob: Blob;
    if (result.assetId) {
      const res = await fetch(`${API_URL}/v1/assets/${result.assetId}/download`, {
        headers: authHeaders(auth.token, auth.userId),
      });
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } else if (result.url) {
      // Mid-run outputs have no asset row yet; provider CDNs usually do send
      // CORS headers, so try directly.
      const res = await fetch(result.url);
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } else {
      return false;
    }
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
    return true;
  } catch {
    // Last resort: let the browser handle the URL, even if it opens a tab.
    if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
    return false;
  }
}

/** The finished run's rows, for minting presigned preview URLs per asset. */
export async function fetchRunAssets(runId: string, auth: ApiAuth): Promise<RunAssetRow[]> {
  try {
    const res = await fetch(`${API_URL}/v1/runs/${runId}`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { assets?: RunAssetRow[] };
    return body.assets ?? [];
  } catch {
    return [];
  }
}

const TERMINAL_TYPES = new Set(["run.completed", "run.failed"]);

/**
 * Feed a run's events to `onEvent` until a terminal event lands. Returns an
 * abort function; after aborting, no further callbacks fire.
 */
export function streamRun(
  runId: string,
  auth: ApiAuth,
  onEvent: (event: RunEvent) => void,
): () => void {
  const controller = new AbortController();
  let lastSeq = 0;
  let done = false;

  const emit = (event: RunEvent) => {
    if (done || controller.signal.aborted) return;
    if (typeof event.seq === "number") lastSeq = Math.max(lastSeq, event.seq);
    if (TERMINAL_TYPES.has(event.type)) done = true;
    onEvent(event);
  };

  const stream = async () => {
    const res = await fetch(`${API_URL}/v1/runs/${runId}/events?after_seq=${lastSeq}`, {
      headers: { ...authHeaders(auth.token, auth.userId), Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events stream ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) return;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || type === "keepalive") continue;
        try {
          const payload = JSON.parse(data) as RunEvent;
          emit({ ...payload, type: payload.type ?? type });
        } catch {
          // A malformed frame is dropped; the history poll can replay it.
        }
        if (done) return;
      }
    }
  };

  const poll = async () => {
    while (!done && !controller.signal.aborted) {
      try {
        const res = await fetch(
          `${API_URL}/v1/runs/${runId}/events/history?after_seq=${lastSeq}`,
          { headers: authHeaders(auth.token, auth.userId), signal: controller.signal },
        );
        if (res.ok) {
          const body = (await res.json()) as {
            events: RunEvent[];
            terminal: boolean;
          };
          for (const event of body.events) emit(event);
          if (done || body.terminal) return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  void (async () => {
    try {
      await stream();
    } catch {
      // Stream failed or was cut — fall through to polling below.
    }
    if (!done && !controller.signal.aborted) await poll();
  })();

  return () => {
    done = true;
    controller.abort();
  };
}
