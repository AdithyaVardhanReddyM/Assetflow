import type { NodeTypes } from "@xyflow/react";

import { GenerateNode } from "./generate-node";
import { TextNode } from "./text-node";
import { UploadNode } from "./upload-node";
import { CompositionNode } from "./composition-node";
import { OutputNode } from "./simple-nodes";

/**
 * Keyed by the wire `kind`, which is also each node's React Flow `type` — one
 * vocabulary rather than a mapping to keep in sync. Defined at module scope
 * because React Flow re-mounts every node when this object's identity changes.
 */
export const NODE_TYPES: NodeTypes = {
  generate: GenerateNode,
  "input.text": TextNode,
  "input.upload": UploadNode,
  "transform.composite": CompositionNode,
  output: OutputNode,
};
