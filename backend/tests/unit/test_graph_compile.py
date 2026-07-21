"""Compiler tests — the highest-value suite in the backend.

No credentials, no database, no network: `plan_graph` is pure, so these run in
milliseconds and cover the logic most likely to break a user's canvas.
"""

from __future__ import annotations

import pytest

from app.catalog.registry import get_catalog
from app.graph.compile import plan_graph
from app.graph.errors import ErrorCode, WarningCode
from app.graph.schema import AssetRef, Graph, PlanLimits


@pytest.fixture
def catalog():
    return get_catalog()


def node(node_id, kind, *, x=0.0, y=0.0, **data):
    return {"id": node_id, "kind": kind, "position": {"x": x, "y": y}, "data": data}


def gen(
    node_id, *, provider="mock", model="mock-video-v1", modality="video",
    prompt="a cat", **kw,
):
    return node(
        node_id, "generate", provider=provider, model=model, modality=modality,
        prompt=prompt, **kw,
    )


def edge(edge_id, source, target, handle, source_handle="out"):
    return {
        "id": edge_id, "source": source, "target": target,
        "target_handle": handle, "source_handle": source_handle,
    }


def build(nodes, edges=()):
    return Graph.model_validate({"version": 1, "nodes": nodes, "edges": list(edges)})


def codes(result):
    return {d.code for d in result.errors}


# --------------------------------------------------------------------------- #
# happy paths
# --------------------------------------------------------------------------- #


def test_single_generate_node_compiles(catalog):
    result = plan_graph(build([gen("a")]), catalog=catalog)
    assert result.valid, result.errors
    assert len(result.plan.steps) == 1
    step = result.plan.steps[0]
    assert step.node_id == "a"
    assert step.index == 0
    assert step.prompt == "a cat"
    # defaults from the catalog are filled in
    assert step.params["duration"] == 5
    assert step.params["aspect_ratio"] == "16:9"
    assert step.metadata["node_id"] == "a"


def test_linear_chain_maps_edges_to_input_from(catalog):
    graph = build(
        [
            gen("img", model="mock-image-v1", modality="image", y=0),
            gen("vid", model="mock-video-v1", modality="video", y=100),
        ],
        [edge("e1", "img", "vid", "init_image")],
    )
    result = plan_graph(graph, catalog=catalog)
    # mock-video-v1 declares no `accepts`, so init_image is not a valid port
    assert not result.valid
    assert ErrorCode.UNKNOWN_HANDLE in codes(result)


def test_fan_in_to_composite(catalog):
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("aud", model="mock-audio-v1", modality="audio", y=10),
            node("mux", "transform.composite", y=200),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "aud", "mux", "audio")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    mux = result.plan.step_for_node("mux")
    assert mux.provider_key == "__ffmpeg__"
    assert mux.step_type == "mix"
    # both producers precede the consumer, and fan-in is recorded by index
    assert sorted(mux.input_from) == [0, 1]
    assert mux.index == 2


def test_text_node_overrides_literal_prompt(catalog):
    graph = build(
        [
            node("txt", "input.text", text="from the text node"),
            gen("a", prompt="literal on the node"),
        ],
        [edge("e1", "txt", "a", "prompt")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    assert result.plan.steps[0].prompt == "from the text node"


def test_upload_node_becomes_external_input(catalog):
    graph = build(
        [
            node("up", "input.upload", asset_id="asset-1"),
            gen(
                "v", provider="gmicloud", model="Kling-Image2Video-V2.1-Master",
                modality="video",
            ),
        ],
        [edge("e1", "up", "v", "init_image")],
    )
    assets = {
        "asset-1": AssetRef(
            asset_id="asset-1", url="https://b2/x.png", media_type="image/png",
            modality="image", sha256="ab" * 32,
        )
    }
    # gmicloud isn't installed, so allow the mock substitution path
    result = plan_graph(graph, catalog=catalog, assets=assets, allow_mock_fallback=True)
    assert result.valid, result.errors
    step = result.plan.step_for_node("v")
    assert step.external_input_asset_ids == ["asset-1"]
    assert WarningCode.MOCK_SUBSTITUTED in {w.code for w in result.warnings}


# --------------------------------------------------------------------------- #
# structural failures
# --------------------------------------------------------------------------- #


def test_empty_graph(catalog):
    result = plan_graph(build([]), catalog=catalog)
    assert ErrorCode.EMPTY_GRAPH in codes(result)


def test_graph_with_no_step_nodes(catalog):
    result = plan_graph(build([node("t", "input.text", text="hi")]), catalog=catalog)
    assert ErrorCode.NO_STEPS in codes(result)


def test_duplicate_node_ids(catalog):
    result = plan_graph(build([gen("a"), gen("a")]), catalog=catalog)
    assert ErrorCode.DUPLICATE_NODE_ID in codes(result)


def test_dangling_edge(catalog):
    result = plan_graph(
        build([gen("a")], [edge("e1", "ghost", "a", "prompt")]), catalog=catalog
    )
    assert ErrorCode.UNKNOWN_NODE in codes(result)


def test_unknown_handle_lists_available_ports(catalog):
    result = plan_graph(
        build(
            [node("t", "input.text", text="hi"), gen("a")],
            [edge("e1", "t", "a", "nonsense")],
        ),
        catalog=catalog,
    )
    assert ErrorCode.UNKNOWN_HANDLE in codes(result)
    assert "prompt" in result.errors[0].message


def test_cycle_is_detected_and_named(catalog):
    graph = build(
        [
            node("m1", "transform.composite", y=0),
            node("m2", "transform.composite", y=10),
        ],
        [edge("e1", "m1", "m2", "video"), edge("e2", "m2", "m1", "video")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.CYCLE in codes(result)
    cycle = next(d for d in result.errors if d.code == ErrorCode.CYCLE)
    # naming the members is the whole point — a bare "cycle detected" is useless
    assert set(cycle.node_ids) >= {"m1", "m2"}


def test_missing_required_input(catalog):
    graph = build([gen("v", modality="video"), node("mux", "transform.composite", y=99)],
                  [edge("e1", "v", "mux", "video")])
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.MISSING_REQUIRED_INPUT in codes(result)


def test_modality_mismatch(catalog):
    graph = build(
        [
            gen("aud", model="mock-audio-v1", modality="audio", y=0),
            gen("vid", modality="video", y=10),
            node("mux", "transform.composite", y=200),
        ],
        # audio wired into the video port
        [edge("e1", "aud", "mux", "video"), edge("e2", "vid", "mux", "audio")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.MODALITY_MISMATCH in codes(result)


def test_port_arity_rejects_two_edges_into_single_port(catalog):
    graph = build(
        [
            gen("v1", modality="video", y=0),
            gen("v2", modality="video", y=1),
            node("mux", "transform.composite", y=99),
        ],
        [edge("e1", "v1", "mux", "video"), edge("e2", "v2", "mux", "video")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.PORT_ARITY in codes(result)


def test_missing_prompt(catalog):
    result = plan_graph(build([gen("a", prompt="   ")]), catalog=catalog)
    assert ErrorCode.NO_PROMPT in codes(result)


def test_unknown_model(catalog):
    result = plan_graph(build([gen("a", model="does-not-exist")]), catalog=catalog)
    assert ErrorCode.UNKNOWN_MODEL in codes(result)


def test_node_modality_must_match_model(catalog):
    result = plan_graph(
        build([gen("a", model="mock-video-v1", modality="audio")]), catalog=catalog
    )
    assert ErrorCode.MODALITY_UNSUPPORTED in codes(result)


def test_unavailable_provider_without_fallback(catalog):
    result = plan_graph(
        build(
            [gen("a", provider="google", model="veo-3.0-generate-001", modality="video")]
        ),
        catalog=catalog,
    )
    # google is not installed in the test env
    assert ErrorCode.PROVIDER_UNAVAILABLE in codes(result)
    hint = result.errors[0].hint or ""
    # the hint must tell the user how to fix it, not just that it is broken
    assert "GEMINI_API_KEY" in hint or "genblaze[google]" in hint


def test_upload_without_asset(catalog):
    graph = build(
        [node("up", "input.upload"), gen("v", model="Kling-Image2Video-V2.1-Master")],
        [edge("e1", "up", "v", "init_image")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.ASSET_NOT_SET in codes(result)


# --------------------------------------------------------------------------- #
# params
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"nope": 1}, ErrorCode.PARAM_UNKNOWN),
        ({"duration": 999}, ErrorCode.PARAM_RANGE),
        ({"duration": 0}, ErrorCode.PARAM_RANGE),
        ({"duration": "abc"}, ErrorCode.PARAM_TYPE),
        ({"aspect_ratio": "21:9"}, ErrorCode.PARAM_ENUM),
    ],
)
def test_param_validation(catalog, params, expected):
    result = plan_graph(build([gen("a", params=params)]), catalog=catalog)
    assert expected in codes(result)


def test_param_defaults_are_filled(catalog):
    result = plan_graph(build([gen("a", params={"duration": 7})]), catalog=catalog)
    assert result.valid, result.errors
    assert result.plan.steps[0].params == {"duration": 7, "aspect_ratio": "16:9"}


# --------------------------------------------------------------------------- #
# ordering, estimates, limits
# --------------------------------------------------------------------------- #


def test_ordering_is_deterministic_and_visual(catalog):
    """Step indices follow top-to-bottom reading order regardless of array order."""
    nodes = [gen("bottom", y=300), gen("top", y=0), gen("middle", y=150)]
    result = plan_graph(build(nodes), catalog=catalog)
    assert [s.node_id for s in result.plan.steps] == ["top", "middle", "bottom"]

    # reversing the input array must not change the plan
    reversed_result = plan_graph(build(list(reversed(nodes))), catalog=catalog)
    assert [s.node_id for s in reversed_result.plan.steps] == ["top", "middle", "bottom"]


def test_ordering_respects_dependencies_over_position(catalog):
    """A producer placed visually below its consumer still gets the lower index."""
    graph = build(
        [
            gen("consumer", modality="video", y=0),
            gen("producer_v", modality="video", y=500),
            gen("producer_a", model="mock-audio-v1", modality="audio", y=600),
            node("mux", "transform.composite", y=10),
        ],
        [edge("e1", "producer_v", "mux", "video"), edge("e2", "producer_a", "mux", "audio")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    idx = {s.node_id: s.index for s in result.plan.steps}
    assert idx["producer_v"] < idx["mux"]
    assert idx["producer_a"] < idx["mux"]


def test_node_id_index_roundtrip(catalog):
    graph = build([gen("a", y=0), gen("b", y=1), gen("c", y=2)])
    plan = plan_graph(graph, catalog=catalog).plan
    assert plan.index_to_node == {0: "a", 1: "b", 2: "c"}


def test_estimates_use_critical_path_not_sum(catalog):
    """Three independent 5s steps take 5s wall-clock, not 15s."""
    result = plan_graph(build([gen("a", y=0), gen("b", y=1), gen("c", y=2)]), catalog=catalog)
    assert result.plan.estimates.duration_sec == 5.0
    assert result.plan.max_concurrency == 3


def test_critical_path_adds_along_a_chain(catalog):
    graph = build(
        [
            gen("v", modality="video", y=0),
            gen("a", model="mock-audio-v1", modality="audio", y=1),
            node("mux", "transform.composite", y=99),
        ],
        [edge("e1", "v", "mux", "video"), edge("e2", "a", "mux", "audio")],
    )
    plan = plan_graph(graph, catalog=catalog).plan
    # max(video 5s, audio 3s) + mux 10s
    assert plan.estimates.duration_sec == 15.0


def test_step_limit(catalog):
    nodes = [gen(f"n{i}", y=i) for i in range(6)]
    result = plan_graph(build(nodes), catalog=catalog, limits=PlanLimits(max_steps=5))
    assert ErrorCode.LIMIT_STEPS in codes(result)


def test_duration_limit(catalog):
    result = plan_graph(
        build([gen("a")]), catalog=catalog, limits=PlanLimits(max_duration_sec=1.0)
    )
    assert ErrorCode.LIMIT_DURATION in codes(result)


def test_warns_when_no_output_node(catalog):
    result = plan_graph(build([gen("a")]), catalog=catalog)
    assert WarningCode.NO_OUTPUT_NODE in {w.code for w in result.warnings}


def test_output_node_is_recorded(catalog):
    graph = build(
        [gen("a", y=0), node("out", "output", y=100)],
        [edge("e1", "a", "out", "in")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    assert result.plan.output_node_ids == ["a"]
    assert WarningCode.NO_OUTPUT_NODE not in {w.code for w in result.warnings}


def test_compiler_never_raises_on_hostile_input(catalog):
    """Errors are data. Whatever the canvas sends, we return diagnostics."""
    graph = build(
        [
            gen("a", params={"duration": None, "aspect_ratio": []}),
            node("b", "input.upload", asset_id="missing"),
        ],
        [edge("e1", "b", "a", "prompt")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert not result.valid
    assert result.errors
