"use client";

/**
 * A free text value. It produces no GenBlaze step — the compiler treats it as
 * a virtual node whose text is inlined into whatever it feeds, and a text node
 * wired to a generate node's `prompt` overrides the prompt typed on that node.
 */

import { type NodeProps } from "@xyflow/react";
import { CopyIcon, TextTIcon, TrashIcon } from "@phosphor-icons/react";

import type { StudioNode, TextNodeData } from "@/lib/studio/graph";
import { useStudio } from "../studio-context";
import { OutputPort } from "./ports";
import {
  BarButton,
  FloatingBar,
  MoreMenu,
  NodeCard,
  menuItem,
} from "./node-chrome";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

const NODE_WIDTH = 300;
const MAX_LENGTH = 4000;

export function TextNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { updateNode, deleteNode, duplicateNode } = useStudio();
  const wire = data.wire as unknown as TextNodeData;
  const text = wire.text ?? "";

  return (
    <div style={{ width: NODE_WIDTH }}>
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[#8a8271]">
        <TextTIcon className="size-3.5" />
        <span className="font-medium">Text</span>
        {text.length > MAX_LENGTH * 0.9 ? (
          <span className="ml-auto tabular-nums">
            {text.length} / {MAX_LENGTH}
          </span>
        ) : null}
      </div>

      <NodeCard selected={selected}>
        <OutputPort modality="text" className="top-4" />
        <textarea
          value={text}
          maxLength={MAX_LENGTH}
          onChange={(e) => updateNode(id, { text: e.target.value })}
          placeholder="Enter your text…"
          // `nodrag` keeps a click from dragging the node; `nowheel` keeps the
          // canvas from swallowing the wheel to pan with (`panOnScroll`), which
          // otherwise leaves a long text scrollable only by its scrollbar.
          className="nodrag nowheel thin-scrollbar h-40 w-full resize-none overflow-y-auto bg-transparent p-3.5 text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88]"
        />
      </NodeCard>

      <div className="flex justify-center">
        <FloatingBar>
          <BarButton
            label="Copy text"
            icon={CopyIcon}
            disabled={!text}
            onClick={() => navigator.clipboard?.writeText(text)}
          />
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
