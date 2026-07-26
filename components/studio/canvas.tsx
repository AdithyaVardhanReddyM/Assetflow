"use client";

/**
 * The node canvas.
 *
 * Owns the React Flow graph and exposes a small imperative API (`CanvasApi`) so
 * the surrounding shell — which renders the toolbar, prompt bar and zoom
 * controls outside the flow — can place nodes and drive the viewport without
 * lifting the whole graph into it.
 */

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import { cn } from "@/lib/utils";
import type { Catalog, CatalogModel } from "@/lib/studio/catalog";
import { findModel, visiblePorts } from "@/lib/studio/catalog";
import {
  type AssetPreview,
  type Graph,
  type NodeGeneration,
  type NodeRunState,
  type StudioEdge,
  type StudioNode,
  MAX_NODES,
  fromFlow,
  newId,
  toFlow,
} from "@/lib/studio/graph";
import {
  ASSET_DRAG_TYPE,
  type CreateToolId,
  DOT_COLOR,
  DOT_GAP,
  NODE_BLUEPRINTS,
  NODE_SIZE,
  avoidOverlap,
  avoidOverlapGroup,
  blueprintData,
  modalitiesCompatible,
  outputModality,
  outputRole,
  rolesCompatible,
} from "@/lib/studio/node-ui";
import { isStepKind } from "@/lib/studio/runs-client";
import {
  StudioProvider,
  type RunScope,
  type StudioContextValue,
} from "./studio-context";
import {
  CommentLayer,
  type CommentDraft,
  type CommentsApi,
} from "./comment-layer";
import { NODE_TYPES } from "./nodes";

export type CanvasApi = {
  /** Places a node for a toolbar tool. Returns its id, or null when full. */
  addNode: (
    tool: CreateToolId,
    opts?: {
      prompt?: string;
      at?: { x: number; y: number };
      /** Pre-decided by the prompt bar; overrides the blueprint's pick. */
      model?: CatalogModel;
      params?: Record<string, unknown>;
    },
  ) => string | null;
  uploadFiles: (files: File[], at?: { x: number; y: number }) => void;
  /** Opens the file picker; chosen files each land as a new upload node. */
  openFilePicker: () => void;
  /** Place an upload node pointing at a library asset. False when the canvas is full. */
  addLibraryAsset: (asset: AssetPreview, at?: { x: number; y: number }) => boolean;
  /**
   * Drop a whole graph onto the canvas — the chain Reconstruct rebuilt out of
   * another workflow's history. Its nodes arrive selected and framed, so what
   * just landed is obvious on a canvas that already had work on it. False when
   * it does not fit.
   */
  insertGraph: (graph: Graph, at?: { x: number; y: number }) => boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fitView: () => void;
  isEmpty: () => boolean;
};

export type CanvasProps = {
  catalog: Catalog;
  initialGraph: Graph;
  /**
   * Upload previews, merged as they arrive: the graph stores only `asset_id`,
   * and the presigned URLs behind them are minted after mount.
   */
  assets: Record<string, AssetPreview>;
  /** Per-node state of the run in flight, merged onto nodes as it changes. */
  runStates: Record<string, NodeRunState>;
  /** Recent generations per node (newest first) — the carousel entries. */
  histories: Record<string, NodeGeneration[]>;
  /**
   * The two things the graph does not store are still on their way. Nodes that
   * were on the document at open shimmer rather than show an empty state,
   * because whether they hold anything is exactly what is being fetched.
   */
  hydratingResults: boolean;
  hydratingUploads: boolean;
  /** Re-sign one asset's expired preview URL — see the note on the context. */
  onRefreshMedia: (nodeId: string, assetId: string) => Promise<boolean>;
  apiRef: React.RefObject<CanvasApi | null>;
  onGraphChange: (graph: Graph) => void;
  onZoomChange: (zoom: number) => void;
  onInteract: () => void;
  /** Something dropped on the canvas did not fit. The shell owns the message. */
  onCanvasFull: () => void;
  onUpload: (file: File) => Promise<AssetPreview | null>;
  onRun: (nodeId: string, scope: RunScope) => void;
  /** Re-generate a node's displayed take via a hidden edit model — see the context. */
  onEditTake: StudioContextValue["editTake"];
  /** Magic Text plumbing — see the context for what each one does. */
  onLayerize: StudioContextValue["layerizeAsset"];
  onFetchAssetBlob: StudioContextValue["fetchAssetBlob"];
  onRegisterTextEdit: StudioContextValue["registerTextEdit"];
  /** Save a node's generated result (a specific carousel take, or latest) to disk. */
  onDownload: (nodeId: string, generation?: NodeGeneration) => void;
  panMode: boolean;
  /** Frame the whole document on open, for a canvas that already has one. */
  fitOnMount: boolean;
  comments: CommentsApi;
  /** The comment tool is up: a click on empty canvas drops a pin. */
  commentMode: boolean;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function CanvasInner({
  catalog,
  initialGraph,
  assets,
  runStates,
  histories,
  hydratingResults,
  hydratingUploads,
  onRefreshMedia,
  apiRef,
  onGraphChange,
  onZoomChange,
  onInteract,
  onCanvasFull,
  onUpload,
  onRun,
  onEditTake,
  onLayerize,
  onFetchAssetBlob,
  onRegisterTextEdit,
  onDownload,
  panMode,
  fitOnMount,
  comments,
  commentMode,
}: CanvasProps) {
  const seed = React.useMemo(() => toFlow(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>(seed.edges);
  /**
   * Previews for files uploaded from inside the canvas, merged over the ones
   * the shell resolved. Kept apart rather than folded into a single store so
   * the prop can keep arriving — presigned URLs are minted after mount — with
   * nothing to synchronize.
   */
  const [uploaded, setUploaded] = React.useState<Record<string, AssetPreview>>({});
  const assetMap = React.useMemo(
    () => ({ ...assets, ...uploaded }),
    [assets, uploaded],
  );
  const rf = useReactFlow();

  const container = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  /** Which node a pending file picker is filling; null means "make a new one". */
  const uploadTarget = React.useRef<string | null>(null);

  const [commentDraft, setCommentDraft] = React.useState<CommentDraft | null>(null);
  const [openComment, setOpenComment] = React.useState<string | null>(null);

  /**
   * An unwritten note belongs to the tool that started it. Derived rather than
   * cleared when the tool changes, so putting the comment tool down hides the
   * composer without a render pass whose only job is to undo state — and
   * picking it back up hands the half-written note back.
   *
   * An *open* thread is not scoped this way: reading one is not an edit, and
   * it stays legible whichever tool you pick up next.
   */
  const draft = commentMode ? commentDraft : null;

  /**
   * One click, one action. A click on empty canvas dismisses whatever is open
   * before it will place anything new, so closing a thread never leaves a
   * stray draft behind it.
   */
  const onPaneClick = React.useCallback(
    (event: React.MouseEvent) => {
      if (openComment) return setOpenComment(null);
      if (draft) return setCommentDraft(null);
      if (!commentMode) return;
      setCommentDraft(
        rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [openComment, draft, commentMode, rf],
  );

  // Rehydrate upload previews onto their nodes. Kept out of the wire data so
  // the graph stores only `asset_id` — the URLs are short-lived presigned ones.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        if (n.data.kind !== "input.upload") return n;
        const assetId = n.data.wire.asset_id;
        const asset = typeof assetId === "string" ? assetMap[assetId] : undefined;
        if (n.data.asset === asset) return n;
        return { ...n, data: { ...n.data, asset } };
      }),
    );
  }, [assetMap, setNodes]);

  // Paint run progress onto nodes the same way upload previews arrive: state
  // lives with the shell (which owns the event stream), nodes read `data.run`.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const run = runStates[n.id];
        if (n.data.run === run) return n;
        return { ...n, data: { ...n.data, run } };
      }),
    );
  }, [runStates, setNodes]);

  // Generation history rides in the same way — nodes read `data.history` to
  // draw the carousel of earlier takes.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const history = histories[n.id];
        if (n.data.history === history) return n;
        return { ...n, data: { ...n.data, history } };
      }),
    );
  }, [histories, setNodes]);

  /**
   * The nodes this document opened with. Only they can be waiting on anything:
   * a node placed since was made here, and its well is empty because it *is*
   * empty — shimmering at it would promise a result that is not coming.
   */
  const openedWith = React.useMemo(
    () => new Set(initialGraph.nodes.map((n) => n.id)),
    [initialGraph],
  );

  // A node that already holds results must not read as an untouched one for
  // the length of the fetch that goes looking for them.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const waiting =
          openedWith.has(n.id) &&
          (isStepKind(n.data.kind)
            ? hydratingResults
            : n.data.kind === "input.upload"
              ? hydratingUploads && typeof n.data.wire.asset_id === "string"
              : false);
        // undefined rather than false, so an unchanged node keeps its identity
        // and React Flow does not re-render every card on the canvas.
        const hydrating = waiting || undefined;
        if (n.data.hydrating === hydrating) return n;
        return { ...n, data: { ...n.data, hydrating } };
      }),
    );
  }, [hydratingResults, hydratingUploads, openedWith, setNodes]);

  // Report the document upward on every change. React Flow mutates position
  // during a drag, so this fires often — the shell debounces before saving.
  const lastEncoded = React.useRef<string>("");
  React.useEffect(() => {
    const graph = fromFlow(nodes, edges);
    const encoded = JSON.stringify(graph);
    if (encoded === lastEncoded.current) return;
    lastEncoded.current = encoded;
    onGraphChange(graph);
  }, [nodes, edges, onGraphChange]);

  /**
   * The committed node list, readable synchronously.
   *
   * `setNodes` updaters run during a later render, so anything that has to
   * decide *and report back* in the same tick — "did this placement fit?" —
   * cannot read state from inside one.
   */
  const nodesRef = React.useRef(nodes);
  React.useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const nodeById = React.useCallback(
    (id: string) => nodes.find((n) => n.id === id),
    [nodes],
  );

  // --- node operations ----------------------------------------------------

  const updateNode = React.useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((current) =>
        current.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, wire: { ...n.data.wire, ...patch } } } : n,
        ),
      );
      onInteract();
    },
    [setNodes, onInteract],
  );

  const disconnectPort = React.useCallback(
    (id: string, handle: string) => {
      setEdges((current) =>
        current.filter((e) => !(e.target === id && e.targetHandle === handle)),
      );
      onInteract();
    },
    [setEdges, onInteract],
  );

  const deleteNode = React.useCallback(
    (id: string) => {
      setNodes((current) => current.filter((n) => n.id !== id));
      setEdges((current) => current.filter((e) => e.source !== id && e.target !== id));
      onInteract();
    },
    [setNodes, setEdges, onInteract],
  );

  const duplicateNode = React.useCallback(
    (id: string) => {
      setNodes((current) => {
        if (current.length >= MAX_NODES) return current;
        const source = current.find((n) => n.id === id);
        if (!source) return current;
        return [
          ...current.map((n) => ({ ...n, selected: false })),
          {
            ...source,
            id: newId(),
            position: { x: source.position.x + 48, y: source.position.y + 48 },
            selected: true,
            // Structured clone so the copy cannot share a params object with
            // the original and edit it by reference.
            data: { ...source.data, wire: structuredClone(source.data.wire) },
          },
        ];
      });
      onInteract();
    },
    [setNodes, onInteract],
  );

  const pickFileFor = React.useCallback((id: string) => {
    uploadTarget.current = id;
    fileInput.current?.click();
  }, []);

  // --- placement ----------------------------------------------------------

  /** Centre of the current viewport, in flow coordinates. */
  const viewportCentre = React.useCallback(() => {
    const rect = container.current?.getBoundingClientRect();
    return rf.screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
    });
  }, [rf]);

  const placeNode = React.useCallback(
    (
      tool: CreateToolId,
      opts: {
        prompt?: string;
        at?: { x: number; y: number };
        model?: CatalogModel;
        params?: Record<string, unknown>;
      } = {},
    ): string | null => {
      const blueprint = NODE_BLUEPRINTS[tool];
      if (!blueprint) return null;

      const current = nodesRef.current;
      if (current.length >= MAX_NODES) return null;

      const size = NODE_SIZE[blueprint.kind];
      const centre = opts.at ?? viewportCentre();
      // `at` is a pointer position or the viewport centre; offset so the node
      // is centred on it rather than starting there.
      const position = avoidOverlap(
        {
          x: Math.round(centre.x - size.width / 2),
          y: Math.round(centre.y - size.height / 2),
        },
        current.map((n) => n.position),
      );

      const id = newId();
      const node: StudioNode = {
        id,
        type: blueprint.kind,
        position,
        selected: true,
        data: {
          kind: blueprint.kind,
          wire: blueprintData(catalog, blueprint, {
            prompt: opts.prompt,
            model: opts.model,
            params: opts.params,
          }),
        },
      };

      // Mirror into the ref so a batch (a multi-file drop) sees this node when
      // placing the next one, instead of stacking them all on one spot.
      nodesRef.current = [...current.map((n) => ({ ...n, selected: false })), node];
      setNodes(nodesRef.current);
      onInteract();
      return id;
    },
    [catalog, setNodes, viewportCentre, onInteract],
  );

  // --- uploads ------------------------------------------------------------

  const attachUpload = React.useCallback(
    async (file: File, nodeId: string) => {
      setNodes((current) =>
        current.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, uploading: true } } : n,
        ),
      );

      const asset = await onUpload(file);

      setNodes((current) =>
        current.map((n) => {
          if (n.id !== nodeId) return n;
          if (!asset) return { ...n, data: { ...n.data, uploading: false } };
          return {
            ...n,
            data: {
              ...n.data,
              uploading: false,
              asset,
              wire: {
                ...n.data.wire,
                asset_id: asset.id,
                title: n.data.wire.title ?? asset.filename ?? null,
              },
            },
          };
        }),
      );
      if (asset) setUploaded((current) => ({ ...current, [asset.id]: asset }));
      onInteract();
    },
    [onUpload, setNodes, onInteract],
  );

  const uploadFiles = React.useCallback(
    (files: File[], at?: { x: number; y: number }) => {
      const base = at ?? viewportCentre();
      files.forEach((file, i) => {
        // Stagger so a multi-file drop fans out instead of stacking.
        const id = placeNode("upload", {
          at: { x: base.x + i * 40, y: base.y + i * 40 },
        });
        if (id) void attachUpload(file, id);
        else onCanvasFull();
      });
    },
    [placeNode, attachUpload, viewportCentre, onCanvasFull],
  );

  /**
   * An asset that is already in the library needs a node, not an upload — the
   * bytes are in B2 and the row exists, so this only points at it.
   */
  const addLibraryAsset = React.useCallback(
    (asset: AssetPreview, at?: { x: number; y: number }) => {
      const id = placeNode("upload", { at });
      if (!id) return false;
      // Into the same store canvas-side uploads use, so the preview survives
      // the effect that re-reads `assetMap` onto its node.
      setUploaded((current) => ({ ...current, [asset.id]: asset }));
      setNodes((current) =>
        current.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  asset,
                  wire: {
                    ...n.data.wire,
                    asset_id: asset.id,
                    title: asset.filename ?? null,
                  },
                },
              }
            : n,
        ),
      );
      onInteract();
      return true;
    },
    [placeNode, setNodes, onInteract],
  );

  // --- inserting a rebuilt graph ------------------------------------------

  const insertGraph = React.useCallback(
    (graph: Graph, at?: { x: number; y: number }) => {
      const current = nodesRef.current;
      if (!graph.nodes.length || current.length + graph.nodes.length > MAX_NODES) {
        return false;
      }

      const incoming = toFlow(graph);
      // The fragment arrives positioned relative to (0,0), so its extent is
      // read off the far edge of its widest node rather than assumed.
      const width = Math.max(
        ...incoming.nodes.map((n) => n.position.x + NODE_SIZE[n.data.kind].width),
      );
      const height = Math.max(
        ...incoming.nodes.map((n) => n.position.y + NODE_SIZE[n.data.kind].height),
      );
      const centre = at ?? viewportCentre();
      const base = {
        x: Math.round(centre.x - width / 2),
        y: Math.round(centre.y - height / 2),
      };
      const placed = incoming.nodes.map((n) => ({
        ...n,
        selected: true,
        position: {
          x: Math.round(base.x + n.position.x),
          y: Math.round(base.y + n.position.y),
        },
      }));
      const delta = avoidOverlapGroup(
        placed.map((n) => n.position),
        current.map((n) => n.position),
      );
      for (const node of placed) {
        node.position = { x: node.position.x + delta.x, y: node.position.y + delta.y };
      }

      nodesRef.current = [...current.map((n) => ({ ...n, selected: false })), ...placed];
      setNodes(nodesRef.current);
      setEdges((existing) => [...existing, ...incoming.edges]);
      onInteract();
      // Frame what just arrived. A rebuilt chain can be wider than the
      // viewport, and landing it off-screen would read as nothing happening.
      window.setTimeout(
        () =>
          rf.fitView({
            nodes: placed.map((n) => ({ id: n.id })),
            duration: 320,
            padding: 0.3,
            maxZoom: 1,
          }),
        0,
      );
      return true;
    },
    [setNodes, setEdges, viewportCentre, onInteract, rf],
  );

  const onFilesChosen = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      const target = uploadTarget.current;
      uploadTarget.current = null;
      // Reset so choosing the same file twice still fires a change event.
      event.target.value = "";
      if (!files.length) return;

      if (target) void attachUpload(files[0], target);
      else uploadFiles(files);
    },
    [attachUpload, uploadFiles],
  );

  // --- connections --------------------------------------------------------

  /** Does following edges from `from` ever reach `to`? Guards against cycles. */
  const reaches = React.useCallback(
    (from: string, to: string) => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const current = stack.pop()!;
        if (current === to) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const edge of edges) {
          if (edge.source === current) stack.push(edge.target);
        }
      }
      return false;
    },
    [edges],
  );

  const isValidConnection = React.useCallback(
    (connection: Connection | Edge) => {
      const { source, target, targetHandle } = connection;
      if (!source || !target || source === target || !targetHandle) return false;

      const sourceNode = nodeById(source);
      const targetNode = nodeById(target);
      if (!sourceNode || !targetNode) return false;

      // A new edge that closes a loop is rejected here rather than left for the
      // compiler: a cycle on the canvas is easier to prevent than to explain.
      if (reaches(target, source)) return false;

      const model =
        targetNode.data.kind === "generate"
          ? findModel(
              catalog,
              String(targetNode.data.wire.provider ?? ""),
              String(targetNode.data.wire.model ?? ""),
            )
          : undefined;
      // `data.wire` matters for a composition node: its audio handles exist
      // per lane, so the port list cannot be resolved from the kind alone.
      const port = visiblePorts(
        catalog,
        targetNode.data.kind,
        model,
        targetNode.data.wire,
      ).find((p) => p.id === targetHandle);
      if (!port) return false;

      const from = outputModality(
        sourceNode.data.kind,
        sourceNode.data.wire,
        catalog,
        sourceNode.data.asset?.modality,
      );
      if (!modalitiesCompatible(from, port.modality)) return false;

      // Some ports are narrower than their modality: lipsync's `speech` takes a
      // voice, and music is audio without being one. Refused here rather than
      // left to the compiler — the port rail already says what it wants, so a
      // handle that lights up and then errors would contradict it.
      return rolesCompatible(
        outputRole(sourceNode.data.kind, sourceNode.data.wire, catalog),
        port.roles,
      );
    },
    [catalog, nodeById, reaches],
  );

  const onConnect = React.useCallback(
    (connection: Connection) => {
      const targetNode = nodeById(connection.target);
      const model =
        targetNode?.data.kind === "generate"
          ? findModel(
              catalog,
              String(targetNode.data.wire.provider ?? ""),
              String(targetNode.data.wire.model ?? ""),
            )
          : undefined;
      const port = targetNode
        ? visiblePorts(
            catalog,
            targetNode.data.kind,
            model,
            targetNode.data.wire,
          ).find((p) => p.id === connection.targetHandle)
        : undefined;

      setEdges((current) => {
        // A single-connection port replaces rather than accumulates — two edges
        // into one port is a PORT_ARITY error, so never build that state.
        const base = port?.multi
          ? current
          : current.filter(
              (e) =>
                !(e.target === connection.target && e.targetHandle === connection.targetHandle),
            );
        return addEdge({ ...connection, id: newId() }, base);
      });
      onInteract();
    },
    [catalog, nodeById, setEdges, onInteract],
  );

  // --- imperative API -----------------------------------------------------

  React.useImperativeHandle(
    apiRef,
    () => ({
      addNode: placeNode,
      uploadFiles,
      openFilePicker: () => {
        uploadTarget.current = null;
        fileInput.current?.click();
      },
      addLibraryAsset,
      insertGraph,
      zoomIn: () => rf.zoomIn({ duration: 180 }),
      zoomOut: () => rf.zoomOut({ duration: 180 }),
      resetZoom: () => rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 220 }),
      fitView: () => rf.fitView({ duration: 260, padding: 0.25, maxZoom: 1 }),
      isEmpty: () => nodes.length === 0,
    }),
    [placeNode, uploadFiles, addLibraryAsset, insertGraph, rf, nodes.length],
  );

  // --- drag and drop ------------------------------------------------------

  const onDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const at = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      // A drag out of the library panel carries a row, not a file: the bytes
      // are already in B2, so this places a node that points at them.
      const dragged = event.dataTransfer?.getData(ASSET_DRAG_TYPE);
      if (dragged) {
        try {
          const asset = JSON.parse(dragged) as AssetPreview;
          if (asset?.id && !addLibraryAsset(asset, at)) onCanvasFull();
        } catch {
          // A malformed payload is not something the user can act on.
        }
        return;
      }

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      uploadFiles(files, at);
    },
    [uploadFiles, addLibraryAsset, onCanvasFull, rf],
  );

  const studio = React.useMemo(
    () => ({
      catalog,
      assets: assetMap,
      updateNode,
      disconnectPort,
      deleteNode,
      duplicateNode,
      pickFileFor,
      runFrom: onRun,
      editTake: onEditTake,
      layerizeAsset: onLayerize,
      fetchAssetBlob: onFetchAssetBlob,
      registerTextEdit: onRegisterTextEdit,
      downloadNode: onDownload,
      refreshMedia: onRefreshMedia,
    }),
    [
      catalog,
      assetMap,
      updateNode,
      disconnectPort,
      deleteNode,
      duplicateNode,
      pickFileFor,
      onRun,
      onEditTake,
      onLayerize,
      onFetchAssetBlob,
      onRegisterTextEdit,
      onDownload,
      onRefreshMedia,
    ],
  );

  return (
    <StudioProvider value={studio}>
      <div
        ref={container}
        className="studio-canvas absolute inset-0"
        // Drives the crosshair from globals.css. Not a Tailwind arbitrary
        // variant: `_` is Tailwind's escape for a space, so
        // `[&_.react-flow__pane]` compiles to `.react-flow pane` and matches
        // nothing — and the rule also has to out-specify base.css's
        // `.react-flow__pane.draggable { cursor: grab }`.
        data-comment-mode={commentMode}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <ReactFlow<StudioNode, StudioEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onMove={(_, viewport) => onZoomChange(viewport.zoom)}
          onNodeDragStop={onInteract}
          onPaneClick={onPaneClick}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // Scroll pans and ⌘/ctrl-scroll zooms, matching the rest of the app
          // and every canvas tool the user already knows.
          panOnScroll
          zoomOnScroll={false}
          selectionOnDrag={!panMode && !commentMode}
          panOnDrag={panMode ? true : [1, 2]}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Shift"]}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={!panMode}
          connectionRadius={30}
          // A document arrives from its own URL now, so nodes saved anywhere
          // in flow space have to be found for the user rather than left off
          // the edge of a fixed viewport. An empty canvas keeps the origin.
          fitView={fitOnMount}
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          className={cn(panMode && "cursor-grab active:cursor-grabbing")}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={DOT_GAP}
            size={1}
            color={DOT_COLOR}
          />
          <CommentLayer
            api={comments}
            draft={draft}
            openId={openComment}
            onOpen={setOpenComment}
            onCancelDraft={() => setCommentDraft(null)}
          />
        </ReactFlow>

        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={onFilesChosen}
        />
      </div>
    </StudioProvider>
  );
}

export function StudioCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
