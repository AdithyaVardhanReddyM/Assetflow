"use client";

/**
 * The two structural nodes: `transform.composite` muxes a video and an audio
 * track with ffmpeg, and `output` marks a result to surface in the run summary.
 * Neither carries model settings, so both are just a port rail and a label.
 */

import * as React from "react";
import { type NodeProps, useNodeConnections } from "@xyflow/react";
import { CopyIcon, TrashIcon } from "@phosphor-icons/react";

import { visiblePorts } from "@/lib/studio/catalog";
import type { CompositeNodeData, OutputNodeData, StudioNode } from "@/lib/studio/graph";
import { useStudio } from "../studio-context";
import { CompositionIcon } from "../asset-icons";
import { OutputPort, PortRail, portLabel, sortPorts } from "./ports";
import {
  BarButton,
  FloatingBar,
  MoreMenu,
  NodeCaption,
  NodeCard,
  menuItem,
} from "./node-chrome";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

const NODE_WIDTH = 300;

function useConnectedHandles() {
  const incoming = useNodeConnections({ handleType: "target" });
  return React.useMemo(
    () => new Set(incoming.map((c) => c.targetHandle).filter(Boolean) as string[]),
    [incoming],
  );
}

export function CompositeNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { catalog, deleteNode, duplicateNode } = useStudio();
  const wire = data.wire as unknown as CompositeNodeData;
  const ports = visiblePorts(catalog, "transform.composite");
  const connected = useConnectedHandles();

  return (
    <div style={{ width: NODE_WIDTH }}>
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[#8a8271]">
        <CompositionIcon className="size-3.5" />
        <span className="font-medium">Combine A/V</span>
      </div>

      <NodeCard selected={selected}>
        <PortRail
          ports={ports}
          connectedHandles={connected}
          className="inset-y-0 justify-center"
        />
        <OutputPort modality="video" className="top-1/2 -translate-y-1/2" />

        <div className="px-5 py-5">
          <p className="text-[12px] leading-5 text-[#4c4a41]">
            Muxes a video track and an audio track into one MP4.
          </p>
          <ul className="mt-3 space-y-1">
            {sortPorts(ports).map((port) => (
              <li
                key={port.id}
                className="flex items-center justify-between text-[11px] text-[#8a8271]"
              >
                <span>{portLabel(port.id)}</span>
                <span
                  className={
                    connected.has(port.id) ? "text-[#5d9468]" : "text-[#a9743f]"
                  }
                >
                  {connected.has(port.id) ? "connected" : "required"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </NodeCard>

      <div className="flex justify-center">
        <FloatingBar>
          <span className="px-1.5 text-[11px] font-medium text-[#8a8271]">{wire.op}</span>
          <BarButton label="Delete" icon={TrashIcon} danger onClick={() => deleteNode(id)} />
          <MoreMenu>
            <DropdownMenuItem onClick={() => duplicateNode(id)} className={menuItem}>
              <CopyIcon className="size-3.5" />
              Duplicate
            </DropdownMenuItem>
          </MoreMenu>
        </FloatingBar>
      </div>
    </div>
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
