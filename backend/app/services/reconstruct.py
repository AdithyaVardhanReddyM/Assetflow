"""Rebuild the graph that produced an asset, across runs.

Every run stores the graph that actually ran, so walking one snapshot's edges
backwards from a node gives the true derivation of what that node produced.
One snapshot is rarely the whole story, though:

- A take edit (camera, relight) is its own two-node run — the take being edited
  fed back in as a synthetic upload, then a generate step on the *same node id*
  (`lib/studio/camera-edit.ts`). Its snapshot knows nothing about how the take
  it started from was made.
- A library asset dropped onto a canvas arrives as an upload node, which is
  where the graph that generated it stops being visible.

Both are the same shape — an upload node holding an asset that was itself
generated — so both are followed the same way: resolve the asset, jump into the
run that made it, and keep walking. The upload node is not emitted; the edge
that fed it is rewired to the node that produced it, which is what turns a
chain of edits back into the single canvas node the user was looking at.
"""

from __future__ import annotations

import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from app.db.models import Asset, AssetKind, Run
from app.graph.schema import MAX_EDGES, MAX_NODES, Graph
from app.logging import get_logger
from app.services.results import (
    RESULTS_PER_NODE,
    origin_generations,
    serialize_generation,
)

log = get_logger(__name__)

#: Suffix `buildTakeEditGraph` gives the synthetic upload node in a take-edit
#: run. A take edit is stored as an ordinary run, so this naming is the only
#: thing that distinguishes one from a graph the user actually drew — and the
#: distinction matters, because the generate node in an edit run carries the
#: hidden edit model rather than the model the node really uses.
EDIT_SOURCE_SUFFIX = "-editsrc"

#: Runs the walk will open. A chain of edits adds one per edit, so this is
#: generous; it exists so a pathological history cannot walk forever.
MAX_RUNS_WALKED = 64

#: Kinds that carry an `origin` pointer — the ones that produce takes. Mirrors
#: which data models declare the field in `graph/schema.py`.
_ORIGIN_KINDS = {"generate", "transform.composite"}


def upstream_closure(
    graph: dict[str, Any], start: str
) -> tuple[dict[str, dict[str, Any]], dict[str, int], list[str]] | None:
    """Nodes reachable upstream of `start` in a graph snapshot.

    Returns (nodes_by_id, node_id -> depth, BFS order starting at `start`),
    or None when the start node is not in the snapshot.
    """
    nodes = {n.get("id"): n for n in graph.get("nodes", []) if n.get("id")}
    if start not in nodes:
        return None

    parents: dict[str, list[str]] = {}
    for edge in graph.get("edges", []):
        src, dst = edge.get("source"), edge.get("target")
        if src in nodes and dst in nodes:
            parents.setdefault(dst, []).append(src)

    depth = {start: 0}
    order = [start]
    frontier = [start]
    while frontier:
        step_out: list[str] = []
        for nid in frontier:
            for src in parents.get(nid, []):
                if src not in depth:
                    depth[src] = depth[nid] + 1
                    order.append(src)
                    step_out.append(src)
        frontier = step_out
    return nodes, depth, order


def is_edit_run(graph: dict[str, Any] | None) -> bool:
    """Was this run one of the expand modal's take edits?

    Structural rather than a flag on the row: the shape is unmistakable (two
    nodes, one of them a synthetic upload named after the other) and reading it
    off the snapshot costs no schema change.
    """
    nodes = (graph or {}).get("nodes", [])
    if len(nodes) != 2:
        return False
    by_id = {n.get("id"): n for n in nodes}
    for node in nodes:
        node_id = node.get("id") or ""
        if node.get("kind") != "input.upload" or not node_id.endswith(EDIT_SOURCE_SUFFIX):
            continue
        base = by_id.get(node_id[: -len(EDIT_SOURCE_SUFFIX)])
        if base is not None and base.get("kind") == "generate":
            return True
    return False


@dataclass(slots=True)
class _Emitted:
    """One node of the rebuilt graph, and where it was taken from."""

    node: dict[str, Any]
    workflow_id: str | None
    #: True when this copy came out of a take-edit run, whose generate node
    #: carries the hidden edit model instead of the node's real one.
    from_edit: bool


class _Walker:
    """One reconstruction. Holds the caches the walk needs to stay cheap."""

    def __init__(self, session: Any, tenant_id: str) -> None:
        self._session = session
        self._tenant_id = tenant_id
        self._assets: dict[str, Asset | None] = {}
        self._runs: dict[str, Run | None] = {}
        self.emitted: dict[str, _Emitted] = {}
        #: Keyed so the same edge contributed by two runs lands once.
        self.edges: set[tuple[str, str, str, str]] = set()
        self.missing_assets: list[str] = []

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
        cannot say what fed the node. Rather than special-casing that service,
        any run that has lost its graph falls back to the workflow's own history
        for one that still holds the node.
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

    def _emit(self, node_id: str, node: dict[str, Any], run: Run, from_edit: bool) -> None:
        """Record a node, preferring the copy that is not from an edit run.

        The same canvas node appears in every run that touched it. An edit
        run's copy names the hidden edit model, so it is only ever a fallback
        for a node we have not seen anywhere else.
        """
        existing = self.emitted.get(node_id)
        if existing is not None and (not existing.from_edit or from_edit):
            return
        self.emitted[node_id] = _Emitted(
            node=node,
            workflow_id=str(run.workflow_id) if run.workflow_id else None,
            from_edit=from_edit,
        )

    async def walk(self, run: Run, node_id: str) -> None:
        visited: set[tuple[str, str]] = set()
        queue: list[tuple[Run, str]] = [(run, node_id)]
        opened = 0

        while queue and opened < MAX_RUNS_WALKED:
            current, nid = queue.pop(0)
            key = (str(current.id), nid)
            if key in visited:
                continue
            visited.add(key)
            opened += 1

            snapshot = current.graph_snapshot or {}
            closure = upstream_closure(snapshot, nid)
            if closure is None:
                substitute = await self._run_holding(current.workflow_id, nid, str(current.id))
                if substitute is not None:
                    queue.append((substitute, nid))
                continue

            nodes, depth, order = closure
            from_edit = is_edit_run(snapshot)
            #: Within this snapshot: upload node id -> the node that produced
            #: its asset. Per-snapshot because ids are only unique within one.
            replaced: dict[str, str] = {}

            for current_id in order:
                node = nodes[current_id]
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
                            replaced[current_id] = source.node_id
                            queue.append((producing, source.node_id))
                            continue
                    if current_id.endswith(EDIT_SOURCE_SUFFIX):
                        # Scaffolding, not a document node: it exists only to
                        # carry a take into its own edit. When it cannot be
                        # followed — the take has been deleted from the
                        # library — it is dropped rather than placed on a
                        # canvas as a node the user never drew. Its edge goes
                        # with it, having lost an endpoint.
                        continue
                    if raw and source is None:
                        self.missing_assets.append(str(raw))
                self._emit(current_id, node, current, from_edit)

            for edge in snapshot.get("edges", []):
                src, dst = edge.get("source"), edge.get("target")
                if src not in depth or dst not in depth:
                    continue
                src = replaced.get(src, src)
                dst = replaced.get(dst, dst)
                # An edit's source resolves to the node it feeds — the take and
                # the node that made it are the same node. That is a self-edge
                # here and simply not an edge on the canvas.
                if src == dst:
                    continue
                target_handle = edge.get("target_handle") or ""
                if not target_handle:
                    continue
                self.edges.add((src, dst, edge.get("source_handle") or "out", target_handle))


def _remap_clips(data: dict[str, Any], id_map: dict[str, str]) -> None:
    """Point a composition's clips at the rebuilt node ids.

    Clips key on the node id that feeds them, so a composition whose clips were
    not remapped would come back with an empty timeline and no way to tell why.
    A clip whose source did not come along loses its edge too, so it is dropped
    rather than left pointing at nothing.
    """
    tracks = [data.get("video"), *(data.get("tracks") or [])]
    for track in tracks:
        if not isinstance(track, dict) or not isinstance(track.get("clips"), list):
            continue
        track["clips"] = [
            {**clip, "source": id_map[clip["source"]]}
            for clip in track["clips"]
            if isinstance(clip, dict) and clip.get("source") in id_map
        ]


def _build_graph(walker: _Walker) -> tuple[Graph, dict[str, str]] | None:
    """The rebuilt fragment, with fresh ids and positions normalized to (0,0).

    Fresh ids because reusing the originals would collide the moment the same
    chain is reconstructed twice onto one canvas. Normalized positions because
    the snapshot's coordinates are absolute in a canvas the user is not looking
    at — the client translates the fragment to wherever it is being dropped.
    """
    id_map = {old: str(uuid.uuid4()) for old in walker.emitted}

    xs = [float((e.node.get("position") or {}).get("x") or 0) for e in walker.emitted.values()]
    ys = [float((e.node.get("position") or {}).get("y") or 0) for e in walker.emitted.values()]
    origin_x, origin_y = (min(xs) if xs else 0.0), (min(ys) if ys else 0.0)

    nodes: list[dict[str, Any]] = []
    for old_id, entry in walker.emitted.items():
        kind = entry.node.get("kind")
        data = deepcopy(entry.node.get("data") or {})
        if kind == "transform.composite":
            _remap_clips(data, id_map)
        if kind == "input.upload" and str(data.get("asset_id") or "") in walker.missing_assets:
            # The bytes are still in B2 — the library row is what was deleted —
            # but nothing can resolve them for this node, so it comes back empty
            # rather than carrying an id that will not load.
            data["asset_id"] = None
        if kind in _ORIGIN_KINDS and entry.workflow_id:
            data["origin"] = {"workflow_id": entry.workflow_id, "node_id": old_id}
        position = entry.node.get("position") or {}
        nodes.append(
            {
                "id": id_map[old_id],
                "kind": kind,
                "position": {
                    "x": float(position.get("x") or 0) - origin_x,
                    "y": float(position.get("y") or 0) - origin_y,
                },
                "data": data,
            }
        )

    edges = [
        {
            "id": str(uuid.uuid4()),
            "source": id_map[src],
            "target": id_map[dst],
            "source_handle": source_handle,
            "target_handle": target_handle,
        }
        for src, dst, source_handle, target_handle in sorted(walker.edges)
        if src in id_map and dst in id_map
    ]

    try:
        # Through the same models the compiler uses, so a snapshot written
        # before a field existed comes back defaulted rather than malformed.
        return Graph.model_validate({"version": 1, "nodes": nodes, "edges": edges}), id_map
    except Exception as exc:  # noqa: BLE001 - an unrebuildable graph is not a 500
        log.warning("reconstruct.invalid_graph", error=f"{type(exc).__name__}: {exc}")
        return None


async def build_reconstruction(
    session: Any, *, asset: Asset, tenant_id: str
) -> dict[str, Any]:
    """The graph that made `asset`, ready to place on a canvas.

    `available` is false for anything with no run behind it — an upload has no
    graph to rebuild, only the file the user already has.
    """
    if asset.run_id is None or not asset.node_id:
        return {"available": False, "reason": "no_run"}

    run = await session.get(Run, asset.run_id)
    if run is None or run.tenant_id != tenant_id:
        return {"available": False, "reason": "no_run"}

    walker = _Walker(session, tenant_id)
    await walker.walk(run, asset.node_id)
    if not walker.emitted:
        return {"available": False, "reason": "no_graph"}

    node_count, edge_count = len(walker.emitted), len(walker.edges)
    if node_count > MAX_NODES or edge_count > MAX_EDGES:
        # Reported rather than truncated: half a derivation is not a derivation,
        # and the caller can say honestly how big the thing was.
        return {
            "available": True,
            "reason": "too_large",
            "graph": None,
            "node_count": node_count,
        }

    built = _build_graph(walker)
    if built is None:
        return {"available": False, "reason": "no_graph"}
    graph, id_map = built

    origins = {
        id_map[old]: (entry.workflow_id, old)
        for old, entry in walker.emitted.items()
        if entry.workflow_id and entry.node.get("kind") in _ORIGIN_KINDS
    }
    adopted = await origin_generations(session, tenant_id=tenant_id, origins=origins)

    return {
        "available": True,
        "graph": graph.model_dump(mode="json"),
        "node_count": node_count,
        # Deduped: one asset id can be reached twice when a chain of edits
        # collapses onto one node.
        "missing_assets": sorted(set(walker.missing_assets)),
        "results": {
            node_id: [
                serialize_generation(a, node_id=node_id) for a in assets[:RESULTS_PER_NODE]
            ]
            for node_id, assets in adopted.items()
        },
        "source": {
            "run_id": str(run.id),
            "workflow_id": str(run.workflow_id) if run.workflow_id else None,
        },
    }
