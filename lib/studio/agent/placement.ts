/**
 * Where an agent-built fragment lands: centred under everything already on the
 * canvas, with clear air between. `insertGraph` centres the fragment on the
 * point it is given (and then frames it), so this returns the fragment's
 * intended *centre*, not its top-left.
 */

import type { Graph } from "../graph";
import { NODE_SIZE } from "../node-ui";

const CLEARANCE = 160;

export function belowContentAt(
  graph: Graph,
  fragment: { w: number; h: number },
): { x: number; y: number } | undefined {
  if (!graph.nodes.length) return undefined; // empty canvas: viewport centre

  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const node of graph.nodes) {
    const size = NODE_SIZE[node.kind];
    bottom = Math.max(bottom, node.position.y + size.height);
    left = Math.min(left, node.position.x);
    right = Math.max(right, node.position.x + size.width);
  }
  return {
    x: Math.round((left + right) / 2),
    y: Math.round(bottom + CLEARANCE + fragment.h / 2),
  };
}
