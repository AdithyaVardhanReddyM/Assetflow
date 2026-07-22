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
import type { Catalog } from "@/lib/studio/catalog";
import { findModel, visiblePorts } from "@/lib/studio/catalog";
import {
  type AssetPreview,
  type Graph,
  type StudioEdge,
  type StudioNode,
  MAX_NODES,
  fromFlow,
  newId,
  toFlow,
} from "@/lib/studio/graph";
import {
  type CreateToolId,
  NODE_BLUEPRINTS,
  NODE_SIZE,
  avoidOverlap,
  blueprintData,
  modalitiesCompatible,
  outputModality,
} from "@/lib/studio/node-ui";
import { StudioProvider, type RunScope } from "./studio-context";
import { NODE_TYPES } from "./nodes";

export type CanvasApi = {
  /** Places a node for a toolbar tool. Returns its id, or null when full. */
  addNode: (tool: CreateToolId, opts?: { prompt?: string; at?: { x: number; y: number } }) => string | null;
  uploadFiles: (files: File[], at?: { x: number; y: number }) => void;
  /** Opens the file picker; chosen files each land as a new upload node. */
  openFilePicker: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fitView: () => void;
  isEmpty: () => boolean;
};

export type CanvasProps = {
  catalog: Catalog;
  initialGraph: Graph;
  initialAssets: Record<string, AssetPreview>;
  /** Reset key — remounting on workflow change avoids stale graph state. */
  apiRef: React.RefObject<CanvasApi | null>;
  onGraphChange: (graph: Graph) => void;
  onZoomChange: (zoom: number) => void;
  onInteract: () => void;
  onUpload: (file: File) => Promise<AssetPreview | null>;
  onRun: (nodeId: string, scope: RunScope) => void;
  panMode: boolean;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

/**
 * The dot grid, drawn once for both studio modes. Home fades the viewport
 * rather than the whole canvas, so this survives the morph at full strength
 * and reads identically either side of it.
 */
export const DOT_GAP = 26;
export const DOT_COLOR = "rgba(31,33,28,0.34)";

function CanvasInner({
  catalog,
  initialGraph,
  initialAssets,
  apiRef,
  onGraphChange,
  onZoomChange,
  onInteract,
  onUpload,
  onRun,
  panMode,
}: CanvasProps) {
  const seed = React.useMemo(() => toFlow(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>(seed.edges);
  const [assets, setAssets] = React.useState(initialAssets);
  const rf = useReactFlow();

  const container = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  /** Which node a pending file picker is filling; null means "make a new one". */
  const uploadTarget = React.useRef<string | null>(null);

  // Rehydrate upload previews onto their nodes. Kept out of the wire data so
  // the graph stores only `asset_id` — the URLs are short-lived presigned ones.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        if (n.data.kind !== "input.upload") return n;
        const assetId = n.data.wire.asset_id;
        const asset = typeof assetId === "string" ? assets[assetId] : undefined;
        if (n.data.asset === asset) return n;
        return { ...n, data: { ...n.data, asset } };
      }),
    );
  }, [assets, setNodes]);

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
      opts: { prompt?: string; at?: { x: number; y: number } } = {},
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
          wire: blueprintData(catalog, blueprint, { prompt: opts.prompt }),
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
      if (asset) setAssets((current) => ({ ...current, [asset.id]: asset }));
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
      });
    },
    [placeNode, attachUpload, viewportCentre],
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
      const port = visiblePorts(catalog, targetNode.data.kind, model).find(
        (p) => p.id === targetHandle,
      );
      if (!port) return false;

      const from = outputModality(
        sourceNode.data.kind,
        sourceNode.data.wire,
        catalog,
        sourceNode.data.asset?.modality,
      );
      return modalitiesCompatible(from, port.modality);
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
        ? visiblePorts(catalog, targetNode.data.kind, model).find(
            (p) => p.id === connection.targetHandle,
          )
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
      zoomIn: () => rf.zoomIn({ duration: 180 }),
      zoomOut: () => rf.zoomOut({ duration: 180 }),
      resetZoom: () => rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 220 }),
      fitView: () => rf.fitView({ duration: 260, padding: 0.25, maxZoom: 1 }),
      isEmpty: () => nodes.length === 0,
    }),
    [placeNode, uploadFiles, rf, nodes.length],
  );

  // --- drag and drop ------------------------------------------------------

  const onDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      uploadFiles(files, rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [uploadFiles, rf],
  );

  const studio = React.useMemo(
    () => ({
      catalog,
      assets,
      updateNode,
      deleteNode,
      duplicateNode,
      pickFileFor,
      runFrom: onRun,
    }),
    [catalog, assets, updateNode, deleteNode, duplicateNode, pickFileFor, onRun],
  );

  return (
    <StudioProvider value={studio}>
      <div
        ref={container}
        className="studio-canvas absolute inset-0"
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
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // Scroll pans and ⌘/ctrl-scroll zooms, matching the rest of the app
          // and every canvas tool the user already knows.
          panOnScroll
          zoomOnScroll={false}
          selectionOnDrag={!panMode}
          panOnDrag={panMode ? true : [1, 2]}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Shift"]}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={!panMode}
          connectionRadius={30}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          className={cn(panMode && "cursor-grab active:cursor-grabbing")}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={DOT_GAP}
            size={1}
            color={DOT_COLOR}
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
