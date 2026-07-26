"""Rebuilding a graph from run history — the walk, without a database.

The walk's three interesting behaviours are all about crossing *out* of a single
run's snapshot: collapsing a chain of take edits back onto the one canvas node
they all share, following a library asset into the run that generated it, and
recovering when a run saved no graph at all. Each is exercised here against
in-memory runs; the SQL that finds them is the trivial part.
"""

from __future__ import annotations

import uuid

from app.db.models import Asset, AssetKind, Run
from app.services.reconstruct import (
    EDIT_SOURCE_SUFFIX,
    _build_graph,
    _remap_clips,
    _Walker,
    is_edit_run,
    upstream_closure,
)

TENANT = "user_test"

WORKFLOW_A = uuid.uuid4()
WORKFLOW_B = uuid.uuid4()

TEXT_NODE = "text-1"
GEN_NODE = "gen-1"
DOWNSTREAM_NODE = "gen-2"


def _run(run_id, workflow_id, nodes, edges) -> Run:
    return Run(
        id=run_id,
        tenant_id=TENANT,
        owner_user_id="u",
        workflow_id=workflow_id,
        graph_snapshot={"version": 1, "nodes": nodes, "edges": edges},
        plan_snapshot={},
    )


def _asset(asset_id, run_id, node_id) -> Asset:
    return Asset(
        id=asset_id,
        tenant_id=TENANT,
        kind=AssetKind.GENERATED,
        run_id=run_id,
        node_id=node_id,
        url="https://example.invalid/a.png",
        media_type="image/png",
        modality="image",
    )


def _node(node_id, kind, data=None, x=0, y=0):
    return {"id": node_id, "kind": kind, "position": {"x": x, "y": y}, "data": data or {}}


def _edge(source, target, target_handle="prompt"):
    return {
        "id": f"{source}->{target}",
        "source": source,
        "target": target,
        "source_handle": "out",
        "target_handle": target_handle,
    }


def _generate_data(model: str) -> dict:
    return {
        "provider": "replicate",
        "model": model,
        "modality": "image",
        "prompt": "a lighthouse",
        "params": {},
        "fallback_models": [],
        "title": None,
    }


class FakeWalker(_Walker):
    """The real walk over an in-memory world.

    Only the three lookups are replaced. Everything that decides what the graph
    ends up being — the closure, the upload replacement, the edge rewiring, the
    edit-run preference — is the production code.
    """

    def __init__(self, runs: dict[uuid.UUID, Run], assets: dict[uuid.UUID, Asset]) -> None:
        super().__init__(session=None, tenant_id=TENANT)
        self._world_runs = runs
        self._world_assets = assets

    async def _asset(self, raw):
        try:
            return self._world_assets.get(uuid.UUID(str(raw)))
        except (ValueError, TypeError):
            return None

    async def _run(self, run_id):
        return self._world_runs.get(run_id)

    async def _run_holding(self, workflow_id, node_id, exclude):
        for run in self._world_runs.values():
            if str(run.id) == exclude or run.workflow_id != workflow_id:
                continue
            if any(n.get("id") == node_id for n in (run.graph_snapshot or {}).get("nodes", [])):
                return run
        return None


# --- pure helpers ----------------------------------------------------------


def test_upstream_closure_walks_backwards_only():
    graph = {
        "nodes": [_node(TEXT_NODE, "input.text"), _node(GEN_NODE, "generate"),
                  _node(DOWNSTREAM_NODE, "generate")],
        "edges": [_edge(TEXT_NODE, GEN_NODE), _edge(GEN_NODE, DOWNSTREAM_NODE)],
    }
    _, depth, order = upstream_closure(graph, GEN_NODE)
    assert order == [GEN_NODE, TEXT_NODE]
    assert depth == {GEN_NODE: 0, TEXT_NODE: 1}
    # The node downstream of the one we asked about is not part of how it
    # was made, so it must not be dragged along.
    assert DOWNSTREAM_NODE not in depth


def test_upstream_closure_returns_none_for_a_missing_node():
    assert upstream_closure({"nodes": [], "edges": []}, GEN_NODE) is None


def test_edit_run_is_recognised_by_shape():
    edit = {
        "nodes": [
            _node(f"{GEN_NODE}{EDIT_SOURCE_SUFFIX}", "input.upload"),
            _node(GEN_NODE, "generate"),
        ],
        "edges": [],
    }
    assert is_edit_run(edit) is True
    # A two-node graph the user actually drew is not an edit.
    assert is_edit_run({"nodes": [_node("a", "input.upload"), _node("b", "generate")],
                        "edges": []}) is False
    assert is_edit_run({"nodes": [], "edges": []}) is False
    assert is_edit_run(None) is False


def test_clips_follow_their_nodes_to_the_new_ids():
    data = {
        "video": {"id": "video", "clips": [{"source": "old-a", "start_sec": 0}]},
        "tracks": [
            {"id": "a1", "clips": [
                {"source": "old-b", "start_sec": 1},
                {"source": "dropped", "start_sec": 2},
            ]}
        ],
    }
    _remap_clips(data, {"old-a": "new-a", "old-b": "new-b"})
    assert data["video"]["clips"] == [{"source": "new-a", "start_sec": 0}]
    # A clip whose source did not come along has no edge either.
    assert data["tracks"][0]["clips"] == [{"source": "new-b", "start_sec": 1}]


# --- the walk --------------------------------------------------------------


async def test_take_edit_collapses_onto_the_node_it_edited():
    """A camera edit is its own run, but it is not its own node.

    The edit reuses the node's id and feeds it the previous take, so rebuilding
    from the edited asset must produce the *original* node — real model, real
    upstream — not a second node running the hidden edit model.
    """
    original_id, edit_id = uuid.uuid4(), uuid.uuid4()
    take_1 = uuid.uuid4()

    original = _run(
        original_id,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", _generate_data("google/nano-banana-pro")),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    source_node = f"{GEN_NODE}{EDIT_SOURCE_SUFFIX}"
    edit = _run(
        edit_id,
        WORKFLOW_A,
        [
            _node(source_node, "input.upload", {"asset_id": str(take_1)}),
            _node(GEN_NODE, "generate", _generate_data("qwen/qwen-edit-multiangle")),
        ],
        [_edge(source_node, GEN_NODE, target_handle="image_ref")],
    )

    walker = FakeWalker(
        {original_id: original, edit_id: edit},
        {take_1: _asset(take_1, original_id, GEN_NODE)},
    )
    await walker.walk(edit, GEN_NODE)

    assert set(walker.emitted) == {TEXT_NODE, GEN_NODE}
    # The hidden edit model must not be what comes back on the canvas.
    assert walker.emitted[GEN_NODE].node["data"]["model"] == "google/nano-banana-pro"
    # The edit's own edge pointed the node at itself; only the real one survives.
    assert walker.edges == {(TEXT_NODE, GEN_NODE, "out", "prompt")}


async def test_a_library_asset_pulls_in_the_run_that_made_it():
    """An upload node is where the derivation stops being visible. Following it
    into the producing run is what makes this cross-workflow."""
    made_in_a, used_in_b = uuid.uuid4(), uuid.uuid4()
    take = uuid.uuid4()
    upload_node = "upload-1"

    run_a = _run(
        made_in_a,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", _generate_data("google/nano-banana-pro")),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    run_b = _run(
        used_in_b,
        WORKFLOW_B,
        [
            _node(upload_node, "input.upload", {"asset_id": str(take)}),
            _node(DOWNSTREAM_NODE, "generate", _generate_data("openai/sora-2")),
        ],
        [_edge(upload_node, DOWNSTREAM_NODE, target_handle="init_image")],
    )

    walker = FakeWalker(
        {made_in_a: run_a, used_in_b: run_b},
        {take: _asset(take, made_in_a, GEN_NODE)},
    )
    await walker.walk(run_b, DOWNSTREAM_NODE)

    # The upload node is replaced by the node that produced it, so the chain is
    # continuous rather than bottoming out at a file.
    assert set(walker.emitted) == {TEXT_NODE, GEN_NODE, DOWNSTREAM_NODE}
    assert upload_node not in walker.emitted
    assert (GEN_NODE, DOWNSTREAM_NODE, "out", "init_image") in walker.edges
    # Each node remembers the workflow whose runs hold its takes.
    assert walker.emitted[GEN_NODE].workflow_id == str(WORKFLOW_A)
    assert walker.emitted[DOWNSTREAM_NODE].workflow_id == str(WORKFLOW_B)


async def test_a_run_with_no_graph_falls_back_to_the_workflows_history():
    """A Magic Text edit registers a result against a node but saves an empty
    snapshot, so the walk has to find the run that still knows the graph."""
    real_id, empty_id = uuid.uuid4(), uuid.uuid4()
    real = _run(
        real_id,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", _generate_data("google/nano-banana-pro")),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    empty = _run(empty_id, WORKFLOW_A, [], [])

    walker = FakeWalker({real_id: real, empty_id: empty}, {})
    await walker.walk(empty, GEN_NODE)

    assert set(walker.emitted) == {TEXT_NODE, GEN_NODE}


async def test_a_deleted_upload_comes_back_empty_rather_than_broken():
    gone = uuid.uuid4()
    run_id = uuid.uuid4()
    upload_node = "upload-1"
    run = _run(
        run_id,
        WORKFLOW_A,
        [
            _node(upload_node, "input.upload", {"asset_id": str(gone), "title": "logo"}),
            _node(GEN_NODE, "generate", _generate_data("google/nano-banana-pro")),
        ],
        [_edge(upload_node, GEN_NODE, target_handle="image_ref")],
    )

    walker = FakeWalker({run_id: run}, {})
    await walker.walk(run, GEN_NODE)
    assert walker.missing_assets == [str(gone)]

    graph, id_map = _build_graph(walker)
    rebuilt = {n.id: n for n in graph.nodes}
    assert rebuilt[id_map[upload_node]].data["asset_id"] is None
    # The node is still there — the shape of the chain is the point.
    assert rebuilt[id_map[upload_node]].data["title"] == "logo"


async def test_an_edit_whose_base_take_is_gone_leaves_no_scaffolding():
    """The synthetic upload in an edit run is not a node the user drew.

    If the take it carried has been deleted, there is nothing to follow — and
    the node must still not end up on the canvas.
    """
    edit_id = uuid.uuid4()
    source_node = f"{GEN_NODE}{EDIT_SOURCE_SUFFIX}"
    edit = _run(
        edit_id,
        WORKFLOW_A,
        [
            _node(source_node, "input.upload", {"asset_id": str(uuid.uuid4())}),
            _node(GEN_NODE, "generate", _generate_data("qwen/qwen-edit-multiangle")),
        ],
        [_edge(source_node, GEN_NODE, target_handle="image_ref")],
    )

    walker = FakeWalker({edit_id: edit}, {})
    await walker.walk(edit, GEN_NODE)

    assert set(walker.emitted) == {GEN_NODE}
    assert walker.missing_assets == []
    graph, _ = _build_graph(walker)
    # The edge lost an endpoint with it.
    assert graph.edges == []


async def test_rebuilt_nodes_get_fresh_ids_and_a_normalized_position():
    run_id = uuid.uuid4()
    run = _run(
        run_id,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "hi"}, x=900, y=400),
            _node(GEN_NODE, "generate", _generate_data("google/nano-banana-pro"), x=1400, y=460),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )

    walker = FakeWalker({run_id: run}, {})
    await walker.walk(run, GEN_NODE)
    graph, id_map = _build_graph(walker)

    # Fresh ids, or reconstructing the same chain twice would collide.
    assert set(id_map.values()).isdisjoint({TEXT_NODE, GEN_NODE})
    assert {n.id for n in graph.nodes} == set(id_map.values())
    # Translated to the origin so the client can drop it anywhere.
    assert min(n.position.x for n in graph.nodes) == 0
    assert min(n.position.y for n in graph.nodes) == 0
    # Relative layout is preserved.
    rebuilt = {n.id: n for n in graph.nodes}
    assert rebuilt[id_map[GEN_NODE]].position.x == 500

    # The pointer home, which is what re-hydrates the carousel after a reload.
    assert rebuilt[id_map[GEN_NODE]].data["origin"] == {
        "workflow_id": str(WORKFLOW_A),
        "node_id": GEN_NODE,
    }
    # Only step kinds carry one — a text node has no takes to inherit.
    assert rebuilt[id_map[TEXT_NODE]].data.get("origin") is None
    assert graph.edges[0].source == id_map[TEXT_NODE]
    assert graph.edges[0].target == id_map[GEN_NODE]
