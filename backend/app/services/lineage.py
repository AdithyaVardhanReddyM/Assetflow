"""The whole derivation of one asset, walked across every run that touched it.

A run's snapshot only knows its own story. A file made in one run and dropped
onto another canvas arrives there as an upload node; a take edited in the expand
modal becomes its own two-node run. Either way the graph that actually led to a
file is spread over several snapshots, and reading only the last one bottoms the
history out at "Upload" — which says nothing about where the upload came from.

The seams are followed the same way `reconstruct` follows them: an upload node
holding a generated asset is not a source, it is the node that produced it. What
comes out the other end is shaped differently, though. Reconstruct is rebuilding
a canvas, so every run's copy of a node collapses onto the one node the user
drew. This is telling a history, so a hop is a *pass*, not a node: a take
generated once and edited twice is three hops, each with the model that ran and
the file it produced.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import select

from app.db.models import Asset, AssetKind, Run, RunStep
from app.services.reconstruct import EDIT_SOURCE_SUFFIX, upstream_closure

#: Runs the walk will open. One per edit in a long chain of edits, so this is
#: generous; it exists so a pathological history cannot walk forever.
MAX_RUNS_WALKED = 48

#: Hops the walk will collect. A graph past this is no longer readable as a
#: picture, and the panel says so rather than drawing half of one.
MAX_HOPS = 120


def _key(run_id: Any, node_id: str) -> str:
    """A hop's identity: the same canvas node in two runs is two passes.

    Node ids are only unique within a workflow, and an edit run deliberately
    reuses the id of the node it edits — so the run has to be part of the key or
    a chain of edits would fold into a single hop.
    """
    return f"{run_id}:{node_id}"


class _ChainWalker:
    """One derivation. Holds the caches the walk needs to stay cheap."""

    def __init__(
        self,
        session: Any,
        tenant_id: str,
        serialize: Callable[[Asset], dict[str, Any]],
    ) -> None:
        self._session = session
        self._tenant_id = tenant_id
        self._serialize = serialize
        self._assets: dict[str, Asset | None] = {}
        self._runs: dict[str, Run | None] = {}
        self._steps: dict[str, dict[str, RunStep]] = {}
        self._produced: dict[str, dict[str, list[Asset]]] = {}
        self.hops: dict[str, dict[str, Any]] = {}
        #: Raw endpoints — resolved through `_aliases` once the walk is done,
        #: because the alias for a key can be discovered after the edge is.
        self.edges: set[tuple[str, str]] = set()
        #: A key that turned out to be told by another run's snapshot.
        self._aliases: dict[str, str] = {}
        #: hop key -> the take of that hop that was actually carried onward. A
        #: node that ran four times produced four files, and only one of them is
        #: in this history.
        self._carried: dict[str, str] = {}
        self.truncated = False

    # --- lookups -----------------------------------------------------------

    async def _asset(self, raw: Any) -> Asset | None:
        if not isinstance(raw, str) or not raw:
            return None
        if raw in self._assets:
            return self._assets[raw]
        try:
            asset_id = uuid.UUID(raw)
        except ValueError:
            self._assets[raw] = None
            return None
        found = (
            await self._session.execute(
                select(Asset).where(
                    Asset.id == asset_id, Asset.tenant_id == self._tenant_id
                )
            )
        ).scalar_one_or_none()
        self._assets[raw] = found
        return found

    async def _run(self, run_id: Any) -> Run | None:
        key = str(run_id)
        if key in self._runs:
            return self._runs[key]
        found = await self._session.get(Run, run_id)
        if found is not None and found.tenant_id != self._tenant_id:
            found = None
        self._runs[key] = found
        return found

    async def _run_holding(self, workflow_id: Any, node_id: str, exclude: str) -> Run | None:
        """The newest other run of `workflow_id` whose snapshot has `node_id`.

        A Magic Text edit saves an empty snapshot — it composites in the browser
        and only registers the result — so following one lands on a run that
        cannot say what fed the node. Any run that has lost its graph falls back
        to the workflow's own history for one that still holds it.
        """
        if workflow_id is None:
            return None
        rows = (
            await self._session.execute(
                select(Run)
                .where(
                    Run.workflow_id == workflow_id,
                    Run.tenant_id == self._tenant_id,
                    Run.id != uuid.UUID(exclude),
                )
                .order_by(Run.created_at.desc())
                .limit(MAX_RUNS_WALKED)
            )
        ).scalars()
        for run in rows:
            snapshot = run.graph_snapshot or {}
            if any(n.get("id") == node_id for n in snapshot.get("nodes", [])):
                self._runs[str(run.id)] = run
                return run
        return None

    async def _run_steps(self, run: Run) -> dict[str, RunStep]:
        """What each node of `run` actually ran — provider, model, prompt, cost."""
        key = str(run.id)
        if key not in self._steps:
            rows = (
                await self._session.execute(
                    select(RunStep).where(RunStep.run_id == run.id)
                )
            ).scalars()
            self._steps[key] = {s.node_id: s for s in rows}
        return self._steps[key]

    async def _run_assets(self, run: Run) -> dict[str, list[Asset]]:
        """What each node of `run` produced, so every hop can show a thumbnail."""
        key = str(run.id)
        if key not in self._produced:
            rows = (
                await self._session.execute(select(Asset).where(Asset.run_id == run.id))
            ).scalars()
            by_node: dict[str, list[Asset]] = {}
            for row in rows:
                if row.node_id:
                    by_node.setdefault(row.node_id, []).append(row)
            self._produced[key] = by_node
        return self._produced[key]

    # --- the walk ----------------------------------------------------------

    def _emit(
        self,
        run: Run,
        node_id: str,
        node: dict[str, Any],
        step: RunStep | None,
        outputs: list[Asset],
    ) -> None:
        key = _key(run.id, node_id)
        if key in self.hops:
            return
        data = node.get("data") or {}
        kind = node.get("kind")
        position = node.get("position") or {}
        self.hops[key] = {
            "id": key,
            "node_id": node_id,
            "run_id": str(run.id),
            "workflow_id": str(run.workflow_id) if run.workflow_id else None,
            "kind": kind,
            "title": data.get("title") or data.get("label"),
            "text": data.get("text") if kind == "input.text" else None,
            "provider": step.provider if step else None,
            "model": step.model if step else None,
            "prompt": step.prompt if step else None,
            "step_type": step.step_type if step else None,
            "cost_usd": step.cost_usd if step else None,
            "assets": [self._serialize(a) for a in outputs],
            # Kept only to order siblings the way they sat on the canvas.
            "_x": float(position.get("x") or 0),
        }

    async def walk(self, run: Run, node_id: str) -> None:
        visited: set[tuple[str, str]] = set()
        queue: list[tuple[Run, str]] = [(run, node_id)]
        opened = 0

        while queue and opened < MAX_RUNS_WALKED and len(self.hops) < MAX_HOPS:
            current, nid = queue.pop(0)
            key = (str(current.id), nid)
            if key in visited:
                continue
            visited.add(key)
            opened += 1

            snapshot = current.graph_snapshot or {}
            closure = upstream_closure(snapshot, nid)
            if closure is None:
                substitute = await self._run_holding(
                    current.workflow_id, nid, str(current.id)
                )
                if substitute is not None:
                    # This pass is told by another snapshot; anything already
                    # pointing at it has to follow.
                    self._aliases[_key(current.id, nid)] = _key(substitute.id, nid)
                    queue.append((substitute, nid))
                continue

            nodes, depth, order = closure
            steps = await self._run_steps(current)
            produced = await self._run_assets(current)
            #: Within this snapshot: upload node id -> the hop that produced its
            #: asset. Per-snapshot, because ids are only unique within one.
            replaced: dict[str, str] = {}

            for cid in order:
                node = nodes[cid]
                outputs = produced.get(cid, [])
                if node.get("kind") == "input.upload":
                    raw = (node.get("data") or {}).get("asset_id")
                    source = await self._asset(raw)
                    if (
                        source is not None
                        and source.kind is AssetKind.GENERATED
                        and source.run_id is not None
                        and source.node_id
                    ):
                        producing = await self._run(source.run_id)
                        if producing is not None:
                            # Not a source at all: the file came from a graph,
                            # and that graph is the rest of this story.
                            made_by = _key(producing.id, source.node_id)
                            replaced[cid] = made_by
                            self._carried[made_by] = str(source.id)
                            queue.append((producing, source.node_id))
                            continue
                    if cid.endswith(EDIT_SOURCE_SUFFIX):
                        # Scaffolding, not a node the user drew: it exists only
                        # to carry a take into its own edit. With the take gone
                        # from the library there is nothing to follow and
                        # nothing worth drawing.
                        continue
                    # A genuine upload — the end of the line, and the file
                    # itself is the thumbnail.
                    if source is not None and not outputs:
                        outputs = [source]
                self._emit(current, cid, node, steps.get(cid), outputs)

            for edge in snapshot.get("edges", []):
                src, dst = edge.get("source"), edge.get("target")
                if src not in depth or dst not in depth:
                    continue
                self.edges.add(
                    (
                        replaced.get(src) or _key(current.id, src),
                        replaced.get(dst) or _key(current.id, dst),
                    )
                )

        # Whatever is still queued is history we chose not to open.
        self.truncated = bool(queue)

    # --- what comes out ----------------------------------------------------

    def _resolve(self, key: str) -> str:
        seen = 0
        while key in self._aliases and seen < MAX_RUNS_WALKED:
            key = self._aliases[key]
            seen += 1
        return key

    def finish(self, root: str, carried: str | None = None) -> dict[str, Any] | None:
        """The collected passes as a graph, ranked by distance from `root`."""
        root = self._resolve(root)
        if root not in self.hops:
            return None
        if carried:
            self._carried[root] = carried
        for key, asset_id in self._carried.items():
            hop = self.hops.get(self._resolve(key))
            if hop is not None:
                # The take this history actually went through leads, so the hop
                # is drawn as the file that was passed on rather than whichever
                # sibling take happened to come back first.
                hop["assets"].sort(key=lambda a, want=asset_id: a["id"] != want)

        edges = {
            (s, d)
            for s, d in ((self._resolve(a), self._resolve(b)) for a, b in self.edges)
            if s != d and s in self.hops and d in self.hops
        }
        rank = _rank(self.hops, edges, root)
        # Rows are read top-down, oldest first; siblings keep the left-to-right
        # order they had on the canvas, so the picture matches the workflow.
        ordered = sorted(
            self.hops.values(),
            key=lambda h: (-rank[h["id"]], h["_x"], h["id"]),
        )
        if len(ordered) < 2:
            return None
        hops = [
            {**{k: v for k, v in hop.items() if k != "_x"}, "depth": rank[hop["id"]]}
            for hop in ordered
        ]
        return {
            "hops": hops,
            "edges": [{"source": s, "target": d} for s, d in sorted(edges)],
            "truncated": self.truncated,
        }


def _rank(hops: dict[str, Any], edges: set[tuple[str, str]], root: str) -> dict[str, int]:
    """Distance from `root` along the *longest* path back to it.

    Longest rather than shortest so every edge points strictly downward: a
    prompt feeding both the first step and the last one belongs above both, and
    ranking it by its shortest hop would draw one of its threads upward through
    the tiles.
    """
    depth = {root: 0}
    for _ in range(len(hops)):
        changed = False
        for src, dst in edges:
            if dst not in depth:
                continue
            want = depth[dst] + 1
            if depth.get(src, -1) < want:
                depth[src] = want
                changed = True
        if not changed:
            break
    # Anything that never reached the root lost an edge somewhere; it is still
    # part of the history, so it sits above everything rather than vanishing.
    orphan = max(depth.values(), default=0) + 1
    return {key: depth.get(key, orphan) for key in hops}


async def build_chain(
    session: Any,
    *,
    run: Run,
    asset: Asset,
    tenant_id: str,
    serialize: Callable[[Asset], dict[str, Any]],
) -> dict[str, Any] | None:
    """The graph that led to `asset`, or None when there is nothing to draw.

    None means the file's own step is the whole story — the flat lineage block
    already says which model ran with which prompt, and a one-node picture of
    that is decoration.
    """
    if not asset.node_id:
        return None
    walker = _ChainWalker(session, tenant_id, serialize)
    await walker.walk(run, asset.node_id)
    return walker.finish(_key(run.id, asset.node_id), carried=str(asset.id))
