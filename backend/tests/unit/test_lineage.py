"""The provenance chain — the walk, without a database.

What matters here is what makes it different from `reconstruct`, which walks the
same seams: the chain crosses out of a run to keep the picture whole, but must
*not* collapse the passes it crosses into. A take generated and then edited
twice is three hops in a history and one node on a canvas.
"""

from __future__ import annotations

import uuid

from app.db.models import Asset, AssetKind, Run, RunStep
from app.services.lineage import _ChainWalker, _key, _rank, build_chain
from app.services.reconstruct import EDIT_SOURCE_SUFFIX

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


def _asset(asset_id, run_id, node_id, kind=AssetKind.GENERATED) -> Asset:
    return Asset(
        id=asset_id,
        tenant_id=TENANT,
        kind=kind,
        run_id=run_id,
        node_id=node_id,
        url="https://example.invalid/a.png",
        media_type="image/png",
        modality="image",
    )


def _step(run_id, node_id, model) -> RunStep:
    return RunStep(
        run_id=run_id,
        node_id=node_id,
        provider="replicate",
        model=model,
        prompt="a lighthouse",
        step_type="generate",
        cost_usd=0.02,
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


def _serialize(asset: Asset) -> dict:
    return {"id": str(asset.id), "node_id": asset.node_id}


class FakeWalker(_ChainWalker):
    """The real walk over an in-memory world — only the lookups are replaced."""

    def __init__(self, runs, assets, steps=()) -> None:
        super().__init__(session=None, tenant_id=TENANT, serialize=_serialize)
        self._world_runs = runs
        self._world_assets = assets
        self._world_steps = list(steps)

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

    async def _run_steps(self, run):
        return {s.node_id: s for s in self._world_steps if s.run_id == run.id}

    async def _run_assets(self, run):
        by_node: dict[str, list[Asset]] = {}
        for asset in self._world_assets.values():
            if asset.run_id == run.id and asset.node_id:
                by_node.setdefault(asset.node_id, []).append(asset)
        return by_node


# --- ranking ---------------------------------------------------------------


def test_a_shared_source_is_ranked_by_its_longest_path():
    """A prompt feeding both the first step and the last one belongs above both.

    Ranked by its shortest hop it would sit one row up from the file, and its
    thread to the first step would be drawn upward through the tiles.
    """
    hops = {"prompt": {}, "a": {}, "b": {}}
    edges = {("prompt", "a"), ("a", "b"), ("prompt", "b")}
    assert _rank(hops, edges, "b") == {"b": 0, "a": 1, "prompt": 2}


def test_a_hop_that_lost_its_edge_still_gets_a_row():
    hops = {"a": {}, "orphan": {}}
    assert _rank(hops, edges=set(), root="a")["orphan"] == 1


# --- the walk --------------------------------------------------------------


async def test_an_uploaded_library_file_keeps_the_graph_that_made_it():
    """The complaint this whole thing exists for: a generated file dropped onto
    a second canvas arrived as `Upload` and the story stopped there."""
    made_in_a, used_in_b = uuid.uuid4(), uuid.uuid4()
    take = uuid.uuid4()
    result = uuid.uuid4()
    upload_node = "upload-1"

    run_a = _run(
        made_in_a,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", {"model": "google/nano-banana-pro"}),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    run_b = _run(
        used_in_b,
        WORKFLOW_B,
        [
            _node(upload_node, "input.upload", {"asset_id": str(take)}),
            _node(DOWNSTREAM_NODE, "generate", {"model": "bytedance/seedance"}),
        ],
        [_edge(upload_node, DOWNSTREAM_NODE, target_handle="init_image")],
    )
    assets = {
        take: _asset(take, made_in_a, GEN_NODE),
        result: _asset(result, used_in_b, DOWNSTREAM_NODE),
    }

    walker = FakeWalker(
        {made_in_a: run_a, used_in_b: run_b},
        assets,
        [
            _step(made_in_a, GEN_NODE, "google/nano-banana-pro"),
            _step(used_in_b, DOWNSTREAM_NODE, "bytedance/seedance"),
        ],
    )
    await walker.walk(run_b, DOWNSTREAM_NODE)
    chain = walker.finish(_key(used_in_b, DOWNSTREAM_NODE))

    ids = [h["id"] for h in chain["hops"]]
    # Three rows, oldest first — the prompt that was never on this canvas, the
    # image it made, and the video made from that image.
    assert ids == [
        _key(made_in_a, TEXT_NODE),
        _key(made_in_a, GEN_NODE),
        _key(used_in_b, DOWNSTREAM_NODE),
    ]
    assert [h["depth"] for h in chain["hops"]] == [2, 1, 0]
    # The upload node is not a source; it is the node that produced the file.
    assert _key(used_in_b, upload_node) not in ids
    assert {(e["source"], e["target"]) for e in chain["edges"]} == {
        (_key(made_in_a, TEXT_NODE), _key(made_in_a, GEN_NODE)),
        (_key(made_in_a, GEN_NODE), _key(used_in_b, DOWNSTREAM_NODE)),
    }
    # Each hop says which run and which model, and carries its own take.
    by_id = {h["id"]: h for h in chain["hops"]}
    assert by_id[_key(made_in_a, GEN_NODE)]["model"] == "google/nano-banana-pro"
    assert by_id[_key(made_in_a, GEN_NODE)]["workflow_id"] == str(WORKFLOW_A)
    assert by_id[_key(made_in_a, GEN_NODE)]["assets"] == [{"id": str(take), "node_id": GEN_NODE}]


async def test_every_take_edit_stays_its_own_hop():
    """Reconstruct folds a chain of edits back onto the node they share, because
    a canvas has one node. A history has three passes and must show three."""
    first, edit = uuid.uuid4(), uuid.uuid4()
    take_1, take_2 = uuid.uuid4(), uuid.uuid4()
    source_node = f"{GEN_NODE}{EDIT_SOURCE_SUFFIX}"

    original = _run(
        first,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", {"model": "google/nano-banana-pro"}),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    relight = _run(
        edit,
        WORKFLOW_A,
        [
            _node(source_node, "input.upload", {"asset_id": str(take_1)}),
            _node(GEN_NODE, "generate", {"model": "qwen/qwen-edit-multiangle"}),
        ],
        [_edge(source_node, GEN_NODE, target_handle="image_ref")],
    )

    walker = FakeWalker(
        {first: original, edit: relight},
        {take_1: _asset(take_1, first, GEN_NODE), take_2: _asset(take_2, edit, GEN_NODE)},
        [
            _step(first, GEN_NODE, "google/nano-banana-pro"),
            _step(edit, GEN_NODE, "qwen/qwen-edit-multiangle"),
        ],
    )
    await walker.walk(relight, GEN_NODE)
    chain = walker.finish(_key(edit, GEN_NODE))

    by_id = {h["id"]: h for h in chain["hops"]}
    assert set(by_id) == {
        _key(first, TEXT_NODE),
        _key(first, GEN_NODE),
        _key(edit, GEN_NODE),
    }
    # The pass that ran is the model each hop reports — the edit reports the
    # edit model, and the generation it started from reports its own.
    assert by_id[_key(first, GEN_NODE)]["model"] == "google/nano-banana-pro"
    assert by_id[_key(edit, GEN_NODE)]["model"] == "qwen/qwen-edit-multiangle"
    assert (_key(first, GEN_NODE), _key(edit, GEN_NODE)) in {
        (e["source"], e["target"]) for e in chain["edges"]
    }


async def test_the_hop_leads_with_the_take_that_was_actually_carried():
    """A node that ran four times produced four files. Only one of them is in
    this history, and it is the one the hop has to be drawn as."""
    made_in_a, used_in_b = uuid.uuid4(), uuid.uuid4()
    unused, carried = uuid.uuid4(), uuid.uuid4()
    upload_node = "upload-1"

    run_a = _run(made_in_a, WORKFLOW_A, [_node(GEN_NODE, "generate", {})], [])
    run_b = _run(
        used_in_b,
        WORKFLOW_B,
        [
            _node(upload_node, "input.upload", {"asset_id": str(carried)}),
            _node(DOWNSTREAM_NODE, "generate", {}),
        ],
        [_edge(upload_node, DOWNSTREAM_NODE, target_handle="init_image")],
    )
    walker = FakeWalker(
        {made_in_a: run_a, used_in_b: run_b},
        # Insertion order puts the take nobody used first.
        {
            unused: _asset(unused, made_in_a, GEN_NODE),
            carried: _asset(carried, made_in_a, GEN_NODE),
        },
    )
    await walker.walk(run_b, DOWNSTREAM_NODE)
    chain = walker.finish(_key(used_in_b, DOWNSTREAM_NODE))

    by_id = {h["id"]: h for h in chain["hops"]}
    assert [a["id"] for a in by_id[_key(made_in_a, GEN_NODE)]["assets"]] == [
        str(carried),
        str(unused),
    ]


async def test_a_real_upload_is_where_the_walk_stops():
    run_id = uuid.uuid4()
    uploaded, result = uuid.uuid4(), uuid.uuid4()
    upload_node = "upload-1"
    run = _run(
        run_id,
        WORKFLOW_A,
        [
            _node(upload_node, "input.upload", {"asset_id": str(uploaded)}),
            _node(GEN_NODE, "generate", {"model": "bytedance/seedance"}),
        ],
        [_edge(upload_node, GEN_NODE, target_handle="image_ref")],
    )
    walker = FakeWalker(
        {run_id: run},
        {
            uploaded: _asset(uploaded, None, None, kind=AssetKind.UPLOAD),
            result: _asset(result, run_id, GEN_NODE),
        },
    )
    await walker.walk(run, GEN_NODE)
    chain = walker.finish(_key(run_id, GEN_NODE))

    by_id = {h["id"]: h for h in chain["hops"]}
    upload = by_id[_key(run_id, upload_node)]
    assert upload["kind"] == "input.upload"
    # The file the user brought is the hop's own thumbnail.
    assert upload["assets"] == [{"id": str(uploaded), "node_id": None}]


async def test_an_edit_whose_take_is_gone_leaves_no_scaffolding():
    edit = uuid.uuid4()
    source_node = f"{GEN_NODE}{EDIT_SOURCE_SUFFIX}"
    run = _run(
        edit,
        WORKFLOW_A,
        [
            _node(source_node, "input.upload", {"asset_id": str(uuid.uuid4())}),
            _node(TEXT_NODE, "input.text", {"text": "warmer"}),
            _node(GEN_NODE, "generate", {"model": "qwen/qwen-edit-multiangle"}),
        ],
        [
            _edge(source_node, GEN_NODE, target_handle="image_ref"),
            _edge(TEXT_NODE, GEN_NODE),
        ],
    )
    walker = FakeWalker({edit: run}, {})
    await walker.walk(run, GEN_NODE)
    chain = walker.finish(_key(edit, GEN_NODE))

    assert {h["id"] for h in chain["hops"]} == {
        _key(edit, TEXT_NODE),
        _key(edit, GEN_NODE),
    }


async def test_a_run_with_no_graph_hands_the_story_to_one_that_has_it():
    """A Magic Text edit saves an empty snapshot. The hop that was pointing at
    it has to follow, or the graph comes back in two disconnected halves."""
    real_id, empty_id = uuid.uuid4(), uuid.uuid4()
    real = _run(
        real_id,
        WORKFLOW_A,
        [
            _node(TEXT_NODE, "input.text", {"text": "a lighthouse"}),
            _node(GEN_NODE, "generate", {"model": "google/nano-banana-pro"}),
        ],
        [_edge(TEXT_NODE, GEN_NODE)],
    )
    empty = _run(empty_id, WORKFLOW_A, [], [])

    walker = FakeWalker({real_id: real, empty_id: empty}, {})
    await walker.walk(empty, GEN_NODE)
    chain = walker.finish(_key(empty_id, GEN_NODE))

    assert {h["id"] for h in chain["hops"]} == {
        _key(real_id, TEXT_NODE),
        _key(real_id, GEN_NODE),
    }
    # The root followed its alias, so it is still the file's own hop.
    assert chain["hops"][-1]["depth"] == 0


async def test_a_lone_step_draws_no_picture():
    """One node is not a graph — the flat lineage block already tells it."""
    run_id = uuid.uuid4()
    run = _run(run_id, WORKFLOW_A, [_node(GEN_NODE, "generate", {})], [])
    asset_id = uuid.uuid4()
    walker = FakeWalker({run_id: run}, {asset_id: _asset(asset_id, run_id, GEN_NODE)})
    await walker.walk(run, GEN_NODE)
    assert walker.finish(_key(run_id, GEN_NODE)) is None


async def test_build_chain_needs_a_node_to_start_from():
    run_id = uuid.uuid4()
    run = _run(run_id, WORKFLOW_A, [], [])
    orphan = _asset(uuid.uuid4(), run_id, None)
    assert await build_chain(
        None, run=run, asset=orphan, tenant_id=TENANT, serialize=_serialize
    ) is None
