"""Compiler tests — the highest-value suite in the backend.

No credentials, no database, no network: `plan_graph` is pure, so these run in
milliseconds and cover the logic most likely to break a user's canvas.
"""

from __future__ import annotations

import pytest

from app.catalog.registry import get_catalog
from app.graph.compile import plan_graph
from app.graph.errors import ErrorCode, WarningCode
from app.graph.schema import AssetRef, Graph, PlanLimits, audio_port_id


@pytest.fixture
def catalog():
    return get_catalog()


#: A composite node's audio handles are named per lane, and a fresh node starts
#: with the single lane `a1` — see `audio_port_id` and `_default_tracks`.
AUDIO_LANE = audio_port_id("a1")


def node(node_id, kind, *, x=0.0, y=0.0, **data):
    return {"id": node_id, "kind": kind, "position": {"x": x, "y": y}, "data": data}


def track(track_id, *clips, gain=1.0, muted=False, label=None):
    """A composition lane. Clips are `(source_node_id, start_sec, duration_sec)`."""
    return {
        "id": track_id,
        "label": label,
        "gain": gain,
        "muted": muted,
        "clips": [
            {"source": src, "start_sec": start, "duration_sec": dur}
            for src, start, dur in clips
        ],
    }


def comp(video=None, tracks=None, timeline_sec=30.0):
    """Composite node data. Defaults match `default_data` in node_types.yaml."""
    return {
        "op": "mux",
        "timeline_sec": timeline_sec,
        "video": video or track("video"),
        "tracks": tracks or [track("a1")],
    }


def lanes(*track_ids):
    """Shorthand for a node with empty lanes under the given ids."""
    return comp(tracks=[track(t) for t in track_ids])


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
    assert result.valid, result.errors
    # Visual order puts the image step first, and the video step consumes it by
    # index rather than by node id.
    assert [s.node_id for s in result.plan.steps] == ["img", "vid"]
    assert result.plan.step_for_node("vid").input_from == [0]


def test_port_is_gated_on_the_model_declaring_it(catalog):
    """`init_image` is model_gated, so it exists only for models whose catalog
    entry declares it in `accepts` — mock-audio-v1 does not."""
    graph = build(
        [
            gen("img", model="mock-image-v1", modality="image", y=0),
            gen("aud", model="mock-audio-v1", modality="audio", y=100),
        ],
        [edge("e1", "img", "aud", "init_image")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert not result.valid
    assert ErrorCode.UNKNOWN_HANDLE in codes(result)


def test_fan_in_to_composite(catalog):
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("aud", model="mock-audio-v1", modality="audio", y=10),
            node("mux", "transform.composite", y=200),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "aud", "mux", AUDIO_LANE)],
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
    # Force the unavailable state on a copy, like
    # `test_unavailable_provider_without_fallback` does: GMI_API_KEY lives in
    # backend/.env, and `get_settings()` exports that file into os.environ, so
    # whether gmicloud reads READY here comes down to whether some *other* test
    # module imported app.config during collection.
    from app.catalog.models import ProviderStatus

    catalog = catalog.model_copy(deep=True)
    gmi = catalog.provider("gmicloud")
    gmi.status = ProviderStatus.MISSING_KEY
    for m in gmi.models:
        m.status = ProviderStatus.MISSING_KEY

    graph = build(
        [
            node("up", "input.upload", asset_id="asset-1"),
            gen(
                "v", provider="gmicloud", model="kling-v3-image-to-video",
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
        [edge("e1", "aud", "mux", "video"), edge("e2", "vid", "mux", AUDIO_LANE)],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.MODALITY_MISMATCH in codes(result)


def test_lipsync_speech_port_refuses_audio_that_is_not_a_performance(catalog):
    """`speech` takes a voice or music (an avatar can sing) — sound effects
    drive no mouth, so sfx stays the rejected role."""
    graph = build(
        [
            gen("boom", model="mock-sfx-v1", modality="audio", y=0),
            gen("face", model="mock-image-v1", modality="image", y=100),
            gen("sync", model="mock-lipsync-v1", modality="video", prompt=None, y=200),
        ],
        [
            edge("e1", "face", "sync", "avatar"),
            edge("e2", "boom", "sync", "speech"),
        ],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.ROLE_MISMATCH in codes(result)
    # And the message has to name the way out, not just the refusal.
    diagnostic = next(d for d in result.errors if d.code == ErrorCode.ROLE_MISMATCH)
    assert "speech" in diagnostic.hint


@pytest.mark.parametrize("source_model", ["mock-speech-v1", "mock-audio-v1"])
def test_lipsync_speech_port_takes_a_voice_or_music(catalog, source_model):
    graph = build(
        [
            gen("track", model=source_model, modality="audio", y=0),
            gen("face", model="mock-image-v1", modality="image", y=100),
            gen("sync", model="mock-lipsync-v1", modality="video", prompt=None, y=200),
        ],
        [
            edge("e1", "face", "sync", "avatar"),
            edge("e2", "track", "sync", "speech"),
        ],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    # Two chained inputs, not a fan-in: the model declares a port for each, so
    # both upstream steps ride through GenBlaze's `input_from`.
    step = result.plan.step_for_node("sync")
    assert step.input_from == [0, 1]


def test_llm_node_writes_the_prompt_of_the_node_it_feeds(catalog):
    """An LLM edge is words, not an asset: it must not land in `input_from`,
    and it must satisfy the downstream node's prompt requirement."""
    graph = build(
        [
            gen("llm", model="mock-llm-v1", modality="text", prompt="a lighthouse", y=0),
            # No prompt of its own — the LLM node writes it.
            gen("img", model="mock-image-v1", modality="image", prompt=None, y=100),
        ],
        [edge("e1", "llm", "img", "prompt")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    step = result.plan.step_for_node("img")
    assert step.prompt_from == 0
    assert step.input_from == []
    assert step.prompt is None
    # No warning: the worker honors prompt chaining by splitting the run into
    # a text stage and a media stage.
    assert WarningCode.PROMPT_CHAIN_PENDING not in {w.code for w in result.warnings}


def test_llm_step_is_ordered_before_the_node_it_writes_for(catalog):
    """Position alone would put the image node first; the prompt edge is a
    dependency and has to win."""
    graph = build(
        [
            gen("img", model="mock-image-v1", modality="image", prompt=None, y=0),
            gen("llm", model="mock-llm-v1", modality="text", prompt="a lighthouse", y=500),
        ],
        [edge("e1", "llm", "img", "prompt")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    assert [s.node_id for s in result.plan.steps] == ["llm", "img"]
    assert result.plan.step_for_node("img").prompt_from == 0


def test_a_prompt_chained_plan_is_refused_by_the_builder(catalog):
    """The compiler allows it; the thing that would spend money must not."""
    from app.engine.builder import BuildContext, build_pipeline

    graph = build(
        [
            gen("llm", model="mock-llm-v1", modality="text", prompt="a lighthouse", y=0),
            gen("img", model="mock-image-v1", modality="image", prompt=None, y=100),
        ],
        [edge("e1", "llm", "img", "prompt")],
    )
    plan = plan_graph(graph, catalog=catalog).plan
    assert plan.prompt_chained_node_ids == ["img"]
    ctx = BuildContext(tenant_id="t", workflow_id=None, run_id="r", assets={})
    with pytest.raises(ValueError, match="prompt"):
        build_pipeline(plan, ctx)


def test_llm_node_still_needs_something_to_rewrite(catalog):
    graph = build([gen("llm", model="mock-llm-v1", modality="text", prompt=None)])
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.NO_PROMPT in codes(result)


def test_two_sources_through_one_port_is_still_a_fanin(catalog):
    """Relaxing fan-in for distinct declared ports must not relax it for a
    model asked to reconcile several inputs it cannot tell apart."""
    graph = build(
        [
            gen("a", model="mock-image-v1", modality="image", y=0),
            gen("b", model="mock-image-v1", modality="image", y=10),
            gen("v", modality="video", y=100),
        ],
        # image_ref is `multi`, so arity lets both through — fan-in is what stops it.
        [edge("e1", "a", "v", "image_ref"), edge("e2", "b", "v", "image_ref")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.FANIN_UNSUPPORTED in codes(result)


def test_lipsync_speech_port_takes_an_uploaded_track(catalog):
    """An upload carries no role, so it is not the compiler's place to guess
    that the file is not a voice."""
    graph = build(
        [
            node("up", "input.upload", asset_id="asset-1", y=0),
            gen("face", model="mock-image-v1", modality="image", y=100),
            gen("sync", model="mock-lipsync-v1", modality="video", prompt=None, y=200),
        ],
        [
            edge("e1", "face", "sync", "avatar"),
            edge("e2", "up", "sync", "speech"),
        ],
    )
    assets = {
        "asset-1": AssetRef(
            asset_id="asset-1", url="https://b2/x.mp3", media_type="audio/mpeg",
            modality="audio", sha256="cd" * 32,
        )
    }
    result = plan_graph(graph, catalog=catalog, assets=assets)
    assert ErrorCode.ROLE_MISMATCH not in codes(result)


def test_composition_orders_clips_by_track_then_time(catalog):
    """Clip order is the contract with the compositor: `input_from` and the
    edit are read together, positionally."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            gen("vo", model="mock-speech-v1", modality="audio", prompt="hello", y=20),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    video=track("video", ("vid", 0.0, 5.0)),
                    # `vo` sits earlier on the lane than `music`, so it plays —
                    # and is fed to the compositor — first, whatever order the
                    # edges happen to be in.
                    tracks=[track("a1", ("music", 4.0, 8.0), ("vo", 1.0, 3.0))],
                ),
            ),
        ],
        [
            edge("e1", "vid", "mux", "video"),
            edge("e2", "music", "mux", AUDIO_LANE),
            edge("e3", "vo", "mux", AUDIO_LANE),
        ],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    mux = result.plan.step_for_node("mux")
    idx = {s.node_id: s.index for s in result.plan.steps}
    assert mux.input_from == [idx["vid"], idx["vo"], idx["music"]]
    audio = mux.params["edit"]["tracks"][1]["clips"]
    assert [c["start_sec"] for c in audio] == [1.0, 4.0]


def test_composition_carries_several_clips_on_the_video_track(catalog):
    """Two shots on the picture track, cut one after the other."""
    graph = build(
        [
            gen("a", modality="video", y=0),
            gen("b", modality="video", y=10),
            gen("music", model="mock-audio-v1", modality="audio", y=20),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    video=track("video", ("a", 0.0, 5.0), ("b", 5.0, 5.0)),
                    tracks=[track("a1", ("music", 0.0, 8.0))],
                ),
            ),
        ],
        [
            edge("e1", "a", "mux", "video"),
            edge("e2", "b", "mux", "video"),
            edge("e3", "music", "mux", AUDIO_LANE),
        ],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    video = result.plan.step_for_node("mux").params["edit"]["tracks"][0]
    assert video["kind"] == "video"
    assert [c["start_sec"] for c in video["clips"]] == [0.0, 5.0]


def test_composition_timeline_grows_to_reach_the_last_clip(catalog):
    """A clip past the end of the stored timeline would be cut off, so the
    timeline follows the edit rather than the other way round."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    timeline_sec=10.0,
                    video=track("video", ("vid", 0.0, 5.0)),
                    tracks=[track("a1", ("music", 40.0, 8.0))],
                ),
            ),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "music", "mux", AUDIO_LANE)],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    assert result.plan.step_for_node("mux").params["edit"]["timeline_sec"] == 48.0


def test_composition_mute_and_gain_reach_the_edit(catalog):
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    video=track("video", ("vid", 0.0, 5.0), muted=True),
                    tracks=[
                        track("a1", ("music", 0.0, 8.0), gain=0.35, label="Score")
                    ],
                ),
            ),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "music", "mux", AUDIO_LANE)],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    tracks = result.plan.step_for_node("mux").params["edit"]["tracks"]
    # Muting is expressed to the compositor as a gain, so it needs no second
    # concept — but the fader position itself survives on the node.
    assert tracks[0]["gain"] == 0.0
    assert tracks[1]["gain"] == 0.35
    assert tracks[1]["clips"][0]["label"] == "Score"


def test_composition_takes_an_uploaded_clip_alongside_a_generated_video(catalog):
    """GenBlaze refuses `external_inputs` with `input_from`, so an uploaded clip
    travels as a URL inside the edit instead — and this graph stays legal."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            node("up", "input.upload", asset_id="asset-1", y=10),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    video=track("video", ("vid", 0.0, 5.0)),
                    tracks=[track("a1", ("up", 2.0, 6.0))],
                ),
            ),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "up", "mux", AUDIO_LANE)],
    )
    assets = {
        "asset-1": AssetRef(
            asset_id="asset-1", url="https://b2/track.mp3", media_type="audio/mpeg",
            modality="audio", sha256="ab" * 32,
        )
    }
    result = plan_graph(graph, catalog=catalog, assets=assets)
    assert result.valid, result.errors
    mux = result.plan.step_for_node("mux")
    assert ErrorCode.MIXED_INPUTS not in codes(result)
    clip = mux.params["edit"]["tracks"][1]["clips"][0]
    assert clip["url"] == "https://b2/track.mp3"
    assert clip["start_sec"] == 2.0
    # The upload rides the edit, so it must not also be claimed as a chain input.
    assert mux.input_from == [0]
    assert mux.external_input_asset_ids == []


def test_composition_needs_at_least_one_connected_lane(catalog):
    graph = build(
        [
            gen("vid", modality="video", y=0),
            node("mux", "transform.composite", y=200, **lanes("a1", "a2")),
        ],
        [edge("e1", "vid", "mux", "video")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.MISSING_REQUIRED_INPUT in codes(result)


def test_composition_empty_lane_is_not_an_error(catalog):
    """A half-wired node is a node being worked on, not a broken one."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node("mux", "transform.composite", y=200, **lanes("a1", "a2", "a3")),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "music", "mux", AUDIO_LANE)],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    tracks = result.plan.step_for_node("mux").params["edit"]["tracks"]
    assert [len(t["clips"]) for t in tracks] == [1, 1, 0, 0]


def test_composition_clip_for_a_source_that_is_no_longer_wired_is_ignored(catalog):
    """Disconnecting a clip leaves its stored position behind; it must not
    resurrect the source as an input."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node(
                "mux", "transform.composite", y=200,
                **comp(
                    video=track("video", ("vid", 0.0, 5.0)),
                    tracks=[track("a1", ("music", 0.0, 8.0), ("ghost", 3.0, 2.0))],
                ),
            ),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "music", "mux", AUDIO_LANE)],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    assert len(result.plan.step_for_node("mux").params["edit"]["tracks"][1]["clips"]) == 1


def test_composition_rejects_a_handle_for_a_lane_that_does_not_exist(catalog):
    """Deleting a lane has to invalidate its edge — otherwise a fader the user
    removed would still be mixing."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node("mux", "transform.composite", y=200, **lanes("a1")),
        ],
        [
            edge("e1", "vid", "mux", "video"),
            edge("e2", "music", "mux", audio_port_id("a9")),
        ],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.UNKNOWN_HANDLE in codes(result)


def test_composition_template_port_is_not_connectable(catalog):
    """`audio` describes the family of lane handles; it is never one itself."""
    graph = build(
        [
            gen("vid", modality="video", y=0),
            gen("music", model="mock-audio-v1", modality="audio", y=10),
            node("mux", "transform.composite", y=200),
        ],
        [edge("e1", "vid", "mux", "video"), edge("e2", "music", "mux", "audio")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert ErrorCode.UNKNOWN_HANDLE in codes(result)


def test_port_arity_rejects_two_edges_into_single_port(catalog):
    """`init_image` is one frame, not a set — unlike a composition track, which
    is a timeline and takes as many clips as fit on it."""
    graph = build(
        [
            gen("i1", model="mock-image-v1", modality="image", y=0),
            gen("i2", model="mock-image-v1", modality="image", y=1),
            gen("v", modality="video", y=99),
        ],
        [edge("e1", "i1", "v", "init_image"), edge("e2", "i2", "v", "init_image")],
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
    # Force the unavailable state on a copy rather than trusting the venv:
    # whether luma's extra/key happen to be present must not decide this test.
    # (google/veo was the specimen until that provider was dropped.)
    from app.catalog.models import ProviderStatus

    unavailable = catalog.model_copy(deep=True)
    luma = unavailable.provider("luma")
    luma.status = ProviderStatus.MISSING_KEY
    for m in luma.models:
        m.status = ProviderStatus.MISSING_KEY

    result = plan_graph(
        build([gen("a", provider="luma", model="ray-3.2", modality="video")]),
        catalog=unavailable,
    )
    assert ErrorCode.PROVIDER_UNAVAILABLE in codes(result)
    hint = result.errors[0].hint or ""
    # the hint must tell the user how to fix it, not just that it is broken
    assert "LUMAAI_API_KEY" in hint


def test_upload_without_asset(catalog):
    graph = build(
        [node("up", "input.upload"), gen("v", model="kling-v3-image-to-video")],
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
    assert result.plan.steps[0].params == {
        "duration": 7,
        "aspect_ratio": "16:9",
        "resolution": "720p",
    }


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
        [edge("e1", "producer_v", "mux", "video"), edge("e2", "producer_a", "mux", AUDIO_LANE)],
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
        [edge("e1", "v", "mux", "video"), edge("e2", "a", "mux", AUDIO_LANE)],
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


# --------------------------------------------------------------------------- #
# presets — the character sheet
# --------------------------------------------------------------------------- #


def sheet(node_id, **kw):
    return gen(
        node_id, model="mock-image-v1", modality="image",
        preset="character_sheet", **kw,
    )


def test_character_sheet_wraps_prompt_and_locks_ratio(catalog):
    """The node runs a collage instruction — face close-up, full-body front
    and back — with the user's words folded in, and always renders 16:9."""
    result = plan_graph(
        build([sheet("a", prompt="a knight in bronze armour",
                     params={"aspect_ratio": "1:1"})]),
        catalog=catalog,
    )
    assert result.valid, result.errors
    step = result.plan.steps[0]
    assert "full-body front view" in step.prompt
    assert "full-body back view" in step.prompt
    assert step.prompt.endswith("a knight in bronze armour")
    # The stored square is overridden, not honoured: sheets are wide.
    assert step.params["aspect_ratio"] == "16:9"


def test_character_sheet_rejects_non_image_model(catalog):
    result = plan_graph(
        build([gen("a", preset="character_sheet")]),  # mock-video-v1
        catalog=catalog,
    )
    assert ErrorCode.MODALITY_UNSUPPORTED in codes(result)


def test_character_sheet_runs_on_reference_image_alone(catalog):
    """No typed prompt is fine when a reference image describes the character —
    the template alone is a complete instruction."""
    graph = build(
        [
            node("up", "input.upload", asset_id="asset-1", y=0),
            sheet("a", prompt=None, y=100),
        ],
        [edge("e1", "up", "a", "image_ref")],
    )
    assets = {
        "asset-1": AssetRef(
            asset_id="asset-1", url="https://b2/ref.png", media_type="image/png",
            modality="image", sha256="ab" * 32,
        )
    }
    result = plan_graph(graph, catalog=catalog, assets=assets)
    assert result.valid, result.errors
    assert "Character reference sheet" in result.plan.steps[0].prompt


def test_character_sheet_with_nothing_to_describe_fails(catalog):
    result = plan_graph(build([sheet("a", prompt=None)]), catalog=catalog)
    assert ErrorCode.NO_PROMPT in codes(result)


def test_character_sheet_defers_llm_prompt_to_the_runner(catalog):
    """An LLM-written description cannot be wrapped at compile time — the
    marker tells the runner to wrap the words once they exist."""
    graph = build(
        [
            gen("llm", model="mock-llm-v1", modality="text", prompt="rough idea", y=0),
            sheet("a", prompt=None, y=100),
        ],
        [edge("e1", "llm", "a", "prompt")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    step = result.plan.step_for_node("a")
    assert step.prompt_from == 0
    assert step.metadata["prompt_preset"] == "character_sheet"


# --------------------------------------------------------------------------- #
# 3d generation
# --------------------------------------------------------------------------- #


def test_3d_with_wired_image_compiles_without_a_prompt(catalog):
    """Hunyuan's payload is prompt XOR image_url, so a wired reference image
    stands in for the prompt — `prompt_optional_with_inputs` licenses it."""
    graph = build(
        [
            gen("img", model="mock-image-v1", modality="image", y=0),
            gen("cube", model="mock-3d-v1", modality="3d", prompt=None, y=100),
        ],
        [edge("e1", "img", "cube", "image_ref")],
    )
    result = plan_graph(graph, catalog=catalog)
    assert result.valid, result.errors
    step = result.plan.step_for_node("cube")
    assert step.modality == "3d"
    assert step.input_from == [0]


def test_3d_with_nothing_to_drive_it_fails(catalog):
    """No prompt and no wired image leaves the model nothing to generate from."""
    result = plan_graph(
        build([gen("cube", model="mock-3d-v1", modality="3d", prompt=None)]),
        catalog=catalog,
    )
    assert ErrorCode.NO_PROMPT in codes(result)
