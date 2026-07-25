/**
 * Camera-angle regeneration — the run behind the expand modal's Camera tab.
 *
 * A camera edit is a one-off run, not a document edit: the node on the canvas
 * keeps its own model and params, and what we send is a synthetic two-node
 * subgraph — the displayed take fed back in as an upload, and a generate step
 * on the *same node id* running the hidden multi-angle model. Reusing the id
 * is what makes everything downstream free: run events paint this node's
 * beam, the result prepends into this node's carousel, and
 * `GET /v1/workflows/{id}/results` re-hydrates it under this node on reopen.
 */

import { GRAPH_VERSION, type Graph, type Position } from "./graph";

/** The provider/model pair this feature runs on — hidden from every picker. */
export const CAMERA_EDIT_PROVIDER = "replicate";
export const CAMERA_EDIT_MODEL = "qwen/qwen-edit-multiangle";

/**
 * The widget's pose, in its own vocabulary: `azimuth` degrees left(-)/right(+)
 * of centre, `elevation` degrees below(-)/above(+) the subject, `zoom` percent
 * pushed in. Kept apart from the model's params so the UI never has to think
 * in upstream sign conventions.
 */
export type CameraPose = {
  azimuth: number;
  elevation: number;
  zoom: number;
  wideAngle: boolean;
};

export const NEUTRAL_POSE: CameraPose = {
  azimuth: 0,
  elevation: 0,
  zoom: 0,
  wideAngle: false,
};

export const AZIMUTH_LIMIT = 90;
export const ELEVATION_LIMIT = 70;

/** Where `elevation` stops reading as "level" and becomes a tilt. */
const TILT_THRESHOLD = 25;

export function poseIsNeutral(pose: CameraPose): boolean {
  return (
    Math.round(pose.azimuth) === 0 &&
    tiltOf(pose.elevation) === 0 &&
    Math.round(pose.zoom / 10) === 0 &&
    !pose.wideAngle
  );
}

/**
 * The model's `vertical_tilt` is three states, not a dial: -1 bird's-eye,
 * 0 level, 1 worm's-eye. The widget's continuous elevation buckets here —
 * and the panel shows the bucket, so what is displayed is what is asked.
 */
export function tiltOf(elevation: number): -1 | 0 | 1 {
  if (elevation >= TILT_THRESHOLD) return -1;
  if (elevation <= -TILT_THRESHOLD) return 1;
  return 0;
}

/**
 * The pose in the model's own vocabulary. No sign flip on rotation: the
 * schema says positive "rotates left", but that describes the lens turning —
 * on screen, positive `rotate_degrees` orbits the camera to the *viewer's
 * right* (verified against the model's published example predictions:
 * front-facing input + rotate 90 → the subject's left profile, nose
 * frame-right). That matches the widget's positive-right azimuth directly.
 */
export function poseParams(pose: CameraPose): Record<string, unknown> {
  return {
    rotate_degrees: Math.round(pose.azimuth),
    vertical_tilt: tiltOf(pose.elevation),
    move_forward: Math.round(pose.zoom / 10),
    use_wide_angle: pose.wideAngle,
  };
}

/** What one take-edit runs: the hidden model and its steering. */
export type TakeEditSpec = {
  provider: string;
  model: string;
  /** The directive, for models steered by words (relight); null otherwise. */
  prompt: string | null;
  /** Model params, for models steered numerically (camera); may be empty. */
  params: Record<string, unknown>;
};

/**
 * The inline subgraph one take edit runs — camera, relight, and whatever
 * joins them. `nodeId` is the canvas node the take belongs to; the upload
 * node is synthetic and exists only for this run.
 */
export function buildTakeEditGraph(
  node: { id: string; position: Position; title: string | null },
  assetId: string,
  spec: TakeEditSpec,
): Graph {
  // Node ids allow 64 chars of [A-Za-z0-9_-]; a UUID plus this suffix fits.
  const sourceId = `${node.id}-editsrc`;
  return {
    version: GRAPH_VERSION,
    nodes: [
      {
        id: sourceId,
        kind: "input.upload",
        position: { x: node.position.x - 240, y: node.position.y },
        data: { asset_id: assetId, title: null },
      },
      {
        id: node.id,
        kind: "generate",
        position: node.position,
        data: {
          provider: spec.provider,
          model: spec.model,
          modality: "image",
          prompt: spec.prompt,
          params: spec.params,
          fallback_models: [],
          title: node.title,
        },
      },
    ],
    edges: [
      {
        id: `${node.id}-editedge`,
        source: sourceId,
        target: node.id,
        source_handle: "out",
        target_handle: "image_ref",
      },
    ],
  };
}
