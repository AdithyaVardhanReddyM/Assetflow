"use client";

/**
 * `output` — marks a result to surface in the run summary. It carries no model
 * settings, so it is just a port rail and a label.
 *
 * The composition node used to live here too, back when it was as simple; it
 * grew a mixer and moved to `composition-node.tsx`.
 */

import * as React from "react";
import { type NodeProps, useNodeConnections } from "@xyflow/react";
import { TrashIcon } from "@phosphor-icons/react";

import { visiblePorts } from "@/lib/studio/catalog";
import type { OutputNodeData, StudioNode } from "@/lib/studio/graph";
import { useStudio } from "../studio-context";
import { PortRail } from "./ports";
import { BarButton, FloatingBar, NodeCaption, NodeCard } from "./node-chrome";

function useConnectedHandles() {
  const incoming = useNodeConnections({ handleType: "target" });
  return React.useMemo(
    () => new Set(incoming.map((c) => c.targetHandle).filter(Boolean) as string[]),
    [incoming],
  );
}

export function OutputNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { catalog, updateNode, deleteNode } = useStudio();
  const wire = data.wire as unknown as OutputNodeData;
  const ports = visiblePorts(catalog, "output");
  const connected = useConnectedHandles();

  return (
    <div style={{ width: 240 }}>
      <NodeCaption
        value={wire.label ?? ""}
        placeholder="Output"
        onChange={(v) => updateNode(id, { label: v || null })}
      />

      <NodeCard selected={selected}>
        <PortRail
          ports={ports}
          connectedHandles={connected}
          className="inset-y-0 justify-center"
        />
        <div className="px-5 py-4">
          <p className="text-[12px] leading-5 text-[#4c4a41]">
            {connected.size
              ? "Surfaced in the run summary and your asset library."
              : "Connect a result to mark it as an output."}
          </p>
        </div>
      </NodeCard>

      <div className="flex justify-center">
        <FloatingBar>
          <BarButton label="Delete" icon={TrashIcon} danger onClick={() => deleteNode(id)} />
        </FloatingBar>
      </div>
    </div>
  );
}
