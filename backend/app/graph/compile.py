"""Compile a canvas graph into an executable plan.

Pure: no GenBlaze import, no database, no network. That is what lets the riskiest
logic in the backend be covered by a unit suite that runs in milliseconds and
needs no credentials.

`plan_graph` never raises on user error. Diagnostics come back as data so the
same function powers both `POST /v1/workflows/validate` (live canvas underlines)
and the run path (final gate before spending money on a provider).
"""

from __future__ import annotations

import heapq
from collections import defaultdict
from typing import Any

from app.catalog.models import ModelDescriptor, ParamDescriptor, ProviderStatus
from app.catalog.registry import Catalog, PortSpec
from app.graph.errors import Diagnostic, ErrorCode, WarningCode, error, warning
from app.graph.plan import ExecutionPlan, PlanEstimates, PlannedStep, PlanResult
from app.graph.schema import (
    AssetRef,
    Edge,
    Graph,
    Node,
    NodeKind,
    PlanLimits,
)

#: Pseudo-provider for the ffmpeg mux step; resolved by the engine, not the catalog.
FFMPEG_PROVIDER = "__ffmpeg__"

_ANY = "any"


class _Ctx:
    """Mutable accumulator, so each phase can append diagnostics and bail cleanly."""

    def __init__(self) -> None:
        self.errors: list[Diagnostic] = []
        self.warnings: list[Diagnostic] = []

    def fail(self, code: ErrorCode, message: str, **kw: Any) -> None:
        self.errors.append(error(code, message, **kw))

    def warn(self, code: WarningCode, message: str, **kw: Any) -> None:
        self.warnings.append(warning(code, message, **kw))

    def result(self, plan: ExecutionPlan | None = None) -> PlanResult:
        return PlanResult(
            plan=None if self.errors else plan, errors=self.errors, warnings=self.warnings
        )


def _modalities_compatible(source: str, target: str) -> bool:
    return source in (_ANY, target) or target == _ANY


def plan_graph(
    graph: Graph,
    *,
    catalog: Catalog,
    assets: dict[str, AssetRef] | None = None,
    limits: PlanLimits | None = None,
    allow_mock_fallback: bool = False,
    name: str = "workflow",
) -> PlanResult:
    assets = assets or {}
    limits = limits or PlanLimits()
    ctx = _Ctx()

    if not graph.nodes:
        ctx.fail(ErrorCode.EMPTY_GRAPH, "This workflow has no nodes yet.")
        return ctx.result()

    # --- 1. structural ------------------------------------------------------
    by_id: dict[str, Node] = {}
    for node in graph.nodes:
        if node.id in by_id:
            ctx.fail(
                ErrorCode.DUPLICATE_NODE_ID,
                f"Node id {node.id!r} is used more than once.",
                node_id=node.id,
            )
            continue
        by_id[node.id] = node

    edges: list[Edge] = []
    for edge in graph.edges:
        if edge.source not in by_id:
            ctx.fail(
                ErrorCode.UNKNOWN_NODE,
                f"Edge {edge.id!r} starts at unknown node {edge.source!r}.",
                edge_id=edge.id,
            )
            continue
        if edge.target not in by_id:
            ctx.fail(
                ErrorCode.UNKNOWN_NODE,
                f"Edge {edge.id!r} ends at unknown node {edge.target!r}.",
                edge_id=edge.id,
            )
            continue
        edges.append(edge)

    if ctx.errors:
        return ctx.result()

    # --- 2. cycles ----------------------------------------------------------
    # Checked before any port or input validation: a node inside a loop will
    # also look like it is missing inputs, and reporting that instead of the
    # loop sends the user chasing the wrong problem.
    cycle = _find_cycle(by_id, edges)
    if cycle:
        ctx.fail(
            ErrorCode.CYCLE,
            "These nodes form a loop: " + " → ".join(cycle) + ".",
            node_ids=cycle,
            hint="Remove one of the connections in the loop.",
        )
        return ctx.result()

    # --- 3. resolve per-node ports from the catalog -------------------------
    models: dict[str, ModelDescriptor] = {}
    in_ports: dict[str, dict[str, PortSpec]] = {}
    out_modality: dict[str, str] = {}

    for node in graph.nodes:
        node_type = catalog.node_type(node.kind.value)
        if node_type is None:
            ctx.fail(
                ErrorCode.UNKNOWN_KIND,
                f"Unknown node kind {node.kind.value!r}.",
                node_id=node.id,
            )
            continue

        ports = {p.id: p.model_copy() for p in node_type.inputs}
        modality = node_type.outputs[0].modality if node_type.outputs else _ANY

        if node.kind is NodeKind.GENERATE:
            data = node.typed_data()
            provider = catalog.provider(data.provider)
            model = catalog.model(data.provider, data.model)
            if provider is None:
                ctx.fail(
                    ErrorCode.UNKNOWN_PROVIDER,
                    f"Unknown provider {data.provider!r}.",
                    node_id=node.id,
                )
            elif model is None:
                ctx.fail(
                    ErrorCode.UNKNOWN_MODEL,
                    f"{provider.label} has no model {data.model!r}.",
                    node_id=node.id,
                    hint="Pick a model from GET /v1/catalog/models.",
                )
            else:
                models[node.id] = model
                modality = model.modality.value
                if data.modality != modality:
                    ctx.fail(
                        ErrorCode.MODALITY_UNSUPPORTED,
                        f"{model.label} produces {modality}, but this node is set "
                        f"to {data.modality}.",
                        node_id=node.id,
                        hint=f"Set the node modality to {modality!r}.",
                    )
                # Model-gated ports exist only when the model declares them.
                for port_id, port in list(ports.items()):
                    if port.model_gated and model.accepts_port(port_id) is None:
                        del ports[port_id]

        elif node.kind is NodeKind.UPLOAD:
            data = node.typed_data()
            if not data.asset_id:
                ctx.fail(
                    ErrorCode.ASSET_NOT_SET,
                    "This upload node has no file attached.",
                    node_id=node.id,
                    hint="Upload a file, or delete the node.",
                )
            elif data.asset_id not in assets:
                ctx.fail(
                    ErrorCode.UNKNOWN_ASSET,
                    f"Upload {data.asset_id!r} was not found in your library.",
                    node_id=node.id,
                )
            else:
                modality = assets[data.asset_id].modality

        in_ports[node.id] = ports
        out_modality[node.id] = modality

    if ctx.errors:
        return ctx.result()

    # --- 3. port typing and arity ------------------------------------------
    incoming: dict[str, list[Edge]] = defaultdict(list)
    for edge in edges:
        ports = in_ports.get(edge.target, {})
        port = ports.get(edge.target_handle)
        if port is None:
            known = ", ".join(sorted(ports)) or "none"
            ctx.fail(
                ErrorCode.UNKNOWN_HANDLE,
                f"{by_id[edge.target].kind.value} has no input {edge.target_handle!r} "
                f"(available: {known}).",
                edge_id=edge.id,
                node_id=edge.target,
                port=edge.target_handle,
            )
            continue
        src_modality = out_modality.get(edge.source, _ANY)
        if not _modalities_compatible(src_modality, port.modality):
            ctx.fail(
                ErrorCode.MODALITY_MISMATCH,
                f"{by_id[edge.source].id} outputs {src_modality}, but "
                f"{edge.target_handle!r} expects {port.modality}.",
                edge_id=edge.id,
                node_id=edge.target,
                port=edge.target_handle,
            )
            continue
        incoming[edge.target].append(edge)

    if ctx.errors:
        return ctx.result()

    for node_id, ports in in_ports.items():
        grouped: dict[str, list[Edge]] = defaultdict(list)
        for edge in incoming[node_id]:
            grouped[edge.target_handle].append(edge)
        for port_id, port in ports.items():
            connected = grouped.get(port_id, [])
            if len(connected) > 1 and not port.multi:
                ctx.fail(
                    ErrorCode.PORT_ARITY,
                    f"Input {port_id!r} accepts one connection but has {len(connected)}.",
                    node_id=node_id,
                    port=port_id,
                )
            if port.required and not connected:
                ctx.fail(
                    ErrorCode.MISSING_REQUIRED_INPUT,
                    f"Input {port_id!r} is required but nothing is connected.",
                    node_id=node_id,
                    port=port_id,
                    hint=f"Connect a {port.modality} source to {port_id!r}.",
                )

    if ctx.errors:
        return ctx.result()

    # --- 5. asset dependencies (text edges carry values, not assets) --------
    step_ids = {n.id for n in graph.nodes if n.is_step}
    upload_ids = {n.id for n in graph.nodes if n.kind is NodeKind.UPLOAD}

    step_preds: dict[str, list[str]] = defaultdict(list)
    upload_preds: dict[str, list[tuple[str, str]]] = defaultdict(list)  # (port, node_id)
    for edge in edges:
        if edge.target not in step_ids:
            continue
        if edge.source in step_ids:
            step_preds[edge.target].append(edge.source)
        elif edge.source in upload_ids:
            upload_preds[edge.target].append((edge.target_handle, edge.source))

    if not step_ids:
        ctx.fail(
            ErrorCode.NO_STEPS,
            "This workflow has nothing to run — add a generate node.",
        )
        return ctx.result()

    # --- 6. deterministic topological order over step nodes -----------------
    order = _topo_order(by_id, step_ids, step_preds)
    index_of = {node_id: i for i, node_id in enumerate(order)}

    if len(order) > limits.max_steps:
        ctx.fail(
            ErrorCode.LIMIT_STEPS,
            f"This workflow has {len(order)} steps; the limit is {limits.max_steps}.",
        )
        return ctx.result()

    # --- 7. build steps -----------------------------------------------------
    steps: list[PlannedStep] = []
    for index, node_id in enumerate(order):
        node = by_id[node_id]
        step = _build_step(
            node=node,
            index=index,
            ctx=ctx,
            models=models,
            assets=assets,
            incoming=incoming[node_id],
            by_id=by_id,
            step_preds=step_preds[node_id],
            upload_preds=upload_preds[node_id],
            index_of=index_of,
            catalog=catalog,
            allow_mock_fallback=allow_mock_fallback,
        )
        if step is not None:
            steps.append(step)

    if ctx.errors:
        return ctx.result()

    # --- 8. warnings + estimates -------------------------------------------
    output_sources = [
        e.source for e in edges if by_id[e.target].kind is NodeKind.OUTPUT and e.source in step_ids
    ]
    if not output_sources:
        ctx.warn(
            WarningCode.NO_OUTPUT_NODE,
            "No output node is connected — results will still be saved to your library.",
        )

    consumed = {src for e in edges for src in (e.source,)}
    for node_id in step_ids:
        if node_id not in consumed:
            ctx.warn(
                WarningCode.UNUSED_OUTPUT,
                "This node's result is not connected to anything.",
                node_id=node_id,
            )

    duration = _critical_path(steps)
    costs = [s.est_cost_usd for s in steps if s.est_cost_usd is not None]
    estimates = PlanEstimates(
        duration_sec=duration,
        cost_usd=round(sum(costs), 4) if len(costs) == len(steps) else None,
    )

    if duration and duration > limits.max_duration_sec:
        ctx.fail(
            ErrorCode.LIMIT_DURATION,
            f"Estimated runtime {duration:.0f}s exceeds the {limits.max_duration_sec:.0f}s limit.",
        )
    if (
        limits.max_cost_usd is not None
        and estimates.cost_usd is not None
        and estimates.cost_usd > limits.max_cost_usd
    ):
        ctx.fail(
            ErrorCode.LIMIT_COST,
            f"Estimated cost ${estimates.cost_usd:.2f} exceeds the "
            f"${limits.max_cost_usd:.2f} limit.",
        )

    plan = ExecutionPlan(
        name=name,
        steps=steps,
        max_concurrency=_max_concurrency(steps, limits.max_concurrency),
        estimates=estimates,
        output_node_ids=sorted(set(output_sources)),
    )
    return ctx.result(plan)


# --------------------------------------------------------------------------- #
# phases
# --------------------------------------------------------------------------- #


def _find_cycle(by_id: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Kahn to detect, then DFS to *name* the members — a bare 'cycle detected'
    is useless on a canvas with 20 nodes."""
    succ: dict[str, list[str]] = defaultdict(list)
    indeg: dict[str, int] = dict.fromkeys(by_id, 0)
    for edge in edges:
        succ[edge.source].append(edge.target)
        indeg[edge.target] += 1

    queue = [n for n, d in indeg.items() if d == 0]
    seen = 0
    while queue:
        node_id = queue.pop()
        seen += 1
        for nxt in succ[node_id]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    if seen == len(by_id):
        return []

    remaining = {n for n, d in indeg.items() if d > 0}
    path: list[str] = []
    on_path: set[str] = set()
    visited: set[str] = set()

    def dfs(node_id: str) -> list[str]:
        visited.add(node_id)
        path.append(node_id)
        on_path.add(node_id)
        for nxt in succ[node_id]:
            if nxt not in remaining:
                continue
            if nxt in on_path:
                return [*path[path.index(nxt) :], nxt]
            if nxt not in visited:
                found = dfs(nxt)
                if found:
                    return found
        path.pop()
        on_path.discard(node_id)
        return []

    for node_id in sorted(remaining):
        if node_id not in visited:
            found = dfs(node_id)
            if found:
                return found
    return sorted(remaining)


def _topo_order(
    by_id: dict[str, Node], step_ids: set[str], step_preds: dict[str, list[str]]
) -> list[str]:
    """Kahn with a heap keyed by visual position, so ordering is stable and
    matches top-to-bottom reading order."""
    succ: dict[str, list[str]] = defaultdict(list)
    indeg = dict.fromkeys(step_ids, 0)
    for target, sources in step_preds.items():
        for source in sources:
            succ[source].append(target)
            indeg[target] += 1

    heap = [(by_id[n].sort_key(), n) for n, d in indeg.items() if d == 0]
    heapq.heapify(heap)
    order: list[str] = []
    while heap:
        _, node_id = heapq.heappop(heap)
        order.append(node_id)
        for nxt in succ[node_id]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                heapq.heappush(heap, (by_id[nxt].sort_key(), nxt))
    return order


def _build_step(
    *,
    node: Node,
    index: int,
    ctx: _Ctx,
    models: dict[str, ModelDescriptor],
    assets: dict[str, AssetRef],
    incoming: list[Edge],
    by_id: dict[str, Node],
    step_preds: list[str],
    upload_preds: list[tuple[str, str]],
    index_of: dict[str, int],
    catalog: Catalog,
    allow_mock_fallback: bool,
) -> PlannedStep | None:
    metadata: dict[str, Any] = {"node_id": node.id}

    if node.kind is NodeKind.COMPOSITE:
        if len(step_preds) < 2:
            ctx.fail(
                ErrorCode.MISSING_REQUIRED_INPUT,
                "Combine A/V needs both a video and an audio input.",
                node_id=node.id,
            )
            return None
        return PlannedStep(
            node_id=node.id,
            index=index,
            provider_key=FFMPEG_PROVIDER,
            model="mux",
            modality="video",
            step_type="mix",
            input_from=sorted(index_of[p] for p in step_preds),
            expected_duration_sec=10.0,
            est_cost_usd=0.0,
            metadata=metadata,
        )

    data = node.typed_data()
    model = models.get(node.id)
    if model is None:
        return None

    provider = catalog.provider(data.provider)
    provider_key = data.provider
    if provider is not None and provider.status is not ProviderStatus.READY:
        if allow_mock_fallback:
            ctx.warn(
                WarningCode.MOCK_SUBSTITUTED,
                f"{provider.label} is unavailable — running this node with a mock provider.",
                node_id=node.id,
            )
            provider_key = "mock"
        else:
            ctx.fail(
                ErrorCode.PROVIDER_UNAVAILABLE,
                f"{provider.label} is not available. {provider.unavailable_reason()}",
                node_id=node.id,
                hint=provider.unavailable_reason(),
            )
            return None

    # prompt: a connected text node wins over the literal typed on the node
    prompt = data.prompt
    for edge in incoming:
        source = by_id[edge.source]
        if source.kind is NodeKind.TEXT and edge.target_handle == "prompt":
            prompt = source.typed_data().text
    if not (prompt or "").strip():
        ctx.fail(
            ErrorCode.NO_PROMPT,
            "This node needs a prompt.",
            node_id=node.id,
            hint="Type a prompt on the node, or connect a Text node to its prompt input.",
        )
        return None

    params = _validate_params(node.id, data.params, model, ctx)

    # Uploads either ride GenBlaze's external_inputs, or — when the model exposes
    # a URL-typed parameter — go in as a param. The param path is what makes
    # "upload an image, animate it, and mux in generated audio" expressible,
    # since external_inputs and input_from are mutually exclusive.
    external_ids: list[str] = []
    for port, upload_node_id in upload_preds:
        asset_id = by_id[upload_node_id].typed_data().asset_id
        handoff = model.accepts_port(port)
        if handoff is not None and handoff.via == "param" and handoff.param:
            params[handoff.param] = assets[asset_id].url
        else:
            external_ids.append(asset_id)

    if external_ids and step_preds:
        ctx.fail(
            ErrorCode.MIXED_INPUTS,
            "This node combines an uploaded file with another node's output, which "
            f"{model.label} cannot accept in one step.",
            node_id=node.id,
            hint="Feed the upload into a separate generate node first, then connect "
            "that node here.",
        )
        return None

    if len(step_preds) > 1:
        ctx.fail(
            ErrorCode.FANIN_UNSUPPORTED,
            f"{model.label} accepts one input, but {len(step_preds)} nodes feed it.",
            node_id=node.id,
            hint="Use a Combine A/V node to merge multiple inputs.",
        )
        return None

    return PlannedStep(
        node_id=node.id,
        index=index,
        provider_key=provider_key,
        model=data.model if provider_key == data.provider else "mock-video-v1",
        modality=model.modality.value,
        step_type="generate",
        prompt=prompt,
        params=params,
        input_from=sorted(index_of[p] for p in step_preds),
        external_input_asset_ids=external_ids,
        fallback_models=data.fallback_models,
        expected_duration_sec=data.expected_duration_sec or model.expected_duration_sec,
        est_cost_usd=model.est_cost_usd,
        metadata=metadata,
    )


def _validate_params(
    node_id: str, raw: dict[str, Any], model: ModelDescriptor, ctx: _Ctx
) -> dict[str, Any]:
    known = {p.name: p for p in model.params}
    out: dict[str, Any] = {}

    for key, value in raw.items():
        spec = known.get(key)
        if spec is None:
            ctx.fail(
                ErrorCode.PARAM_UNKNOWN,
                f"{model.label} has no parameter {key!r}.",
                node_id=node_id,
                param=key,
                hint=f"Supported: {', '.join(sorted(known)) or 'none'}.",
            )
            continue
        coerced = _coerce_param(spec, value, node_id, ctx)
        if coerced is not _INVALID:
            out[key] = coerced

    for name, spec in known.items():
        if name in out:
            continue
        if spec.default is not None:
            out[name] = spec.default
        elif spec.required:
            ctx.fail(
                ErrorCode.PARAM_REQUIRED,
                f"{model.label} requires {spec.display_label()!r}.",
                node_id=node_id,
                param=name,
            )
    return out


class _Invalid:
    pass


_INVALID = _Invalid()


def _coerce_param(
    spec: ParamDescriptor, value: Any, node_id: str, ctx: _Ctx
) -> Any:
    if value is None:
        return None

    if spec.type in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, int | float | str):
            ctx.fail(
                ErrorCode.PARAM_TYPE,
                f"{spec.display_label()} must be a number.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        try:
            num = int(value) if spec.type == "integer" else float(value)
        except (TypeError, ValueError):
            ctx.fail(
                ErrorCode.PARAM_TYPE,
                f"{spec.display_label()} must be a number.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        if spec.min is not None and num < spec.min:
            ctx.fail(
                ErrorCode.PARAM_RANGE,
                f"{spec.display_label()} must be at least {spec.min:g}.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        if spec.max is not None and num > spec.max:
            ctx.fail(
                ErrorCode.PARAM_RANGE,
                f"{spec.display_label()} must be at most {spec.max:g}.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        return num

    if spec.type == "boolean":
        if not isinstance(value, bool):
            ctx.fail(
                ErrorCode.PARAM_TYPE,
                f"{spec.display_label()} must be true or false.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        return value

    if spec.type == "enum":
        allowed = [o.value for o in spec.options]
        if str(value) not in allowed:
            ctx.fail(
                ErrorCode.PARAM_ENUM,
                f"{spec.display_label()} must be one of: {', '.join(allowed)}.",
                node_id=node_id,
                param=spec.name,
            )
            return _INVALID
        return str(value)

    # string
    text = str(value)
    if spec.max_length is not None and len(text) > spec.max_length:
        ctx.fail(
            ErrorCode.PARAM_RANGE,
            f"{spec.display_label()} must be at most {spec.max_length} characters.",
            node_id=node_id,
            param=spec.name,
        )
        return _INVALID
    return text


def _critical_path(steps: list[PlannedStep]) -> float | None:
    """Longest dependency chain by duration — steps without a dependency run
    concurrently, so summing everything would badly overestimate."""
    if not steps:
        return None
    by_index = {s.index: s for s in steps}
    memo: dict[int, float] = {}

    def longest(index: int) -> float:
        if index in memo:
            return memo[index]
        step = by_index[index]
        own = step.expected_duration_sec or 0.0
        upstream = max((longest(i) for i in step.input_from if i in by_index), default=0.0)
        memo[index] = own + upstream
        return memo[index]

    total = max(longest(s.index) for s in steps)
    return round(total, 1) if total else None


def _max_concurrency(steps: list[PlannedStep], ceiling: int) -> int:
    """Width of the widest antichain — how many steps can genuinely run at once."""
    if not steps:
        return 1
    by_index = {s.index: s for s in steps}
    depth: dict[int, int] = {}

    def level(index: int) -> int:
        if index in depth:
            return depth[index]
        step = by_index[index]
        depth[index] = (
            1 + max((level(i) for i in step.input_from if i in by_index), default=-1)
        )
        return depth[index]

    counts: dict[int, int] = defaultdict(int)
    for step in steps:
        counts[level(step.index)] += 1
    return max(1, min(ceiling, max(counts.values())))
