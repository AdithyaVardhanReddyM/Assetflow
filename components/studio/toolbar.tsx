"use client";

import CommentAdd01Icon from "@hugeicons/core-free-icons/CommentAdd01Icon";
import Cursor02Icon from "@hugeicons/core-free-icons/Cursor02Icon";
import HandIcon from "@hugeicons/core-free-icons/HandIcon";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconWeight } from "@phosphor-icons/react";
import {
  SpeakerHifiIcon,
  TextTIcon,
  UploadSimpleIcon,
  UserFocusIcon,
  UserSoundIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  CompositionIcon,
  ImageGenIcon,
  LlmIcon,
  MusicGenIcon,
  TextToSpeechIcon,
  VideoGenIcon,
} from "./asset-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ToolId =
  | "move"
  | "hand"
  | "comment"
  | "image"
  | "video"
  | "lipsync"
  | "music"
  | "speech"
  | "sfx"
  | "character"
  | "text"
  | "composition"
  | "upload"
  | "llm";

/** Phosphor icons and the masked brand icons both satisfy this. */
type ToolIcon = React.ComponentType<{
  className?: string;
  weight?: IconWeight;
}>;

type ToolDef = { id: ToolId; label: string; icon: ToolIcon; shortcut?: string };

/**
 * Hugeicons ships icon *data* rather than components, so wrap it to land in the
 * same slot as a Phosphor `Icon`. The free set is stroke-only, and `weight` is
 * accepted and ignored: the active tool is already marked by the filled chip
 * behind it, so the glyph itself holds still.
 */
function hugeIcon(icon: IconSvgElement, name: string): ToolIcon {
  function HugeToolIcon({ className }: { className?: string }) {
    return <HugeiconsIcon icon={icon} className={className} />;
  }
  HugeToolIcon.displayName = name;
  return HugeToolIcon;
}

export const POINTER_TOOLS: ToolDef[] = [
  {
    id: "move",
    label: "Move",
    icon: hugeIcon(Cursor02Icon, "Cursor02Icon"),
    shortcut: "V",
  },
  {
    id: "hand",
    label: "Hand",
    icon: hugeIcon(HandIcon, "HandIcon"),
    shortcut: "H",
  },
  {
    id: "comment",
    label: "Comment",
    icon: hugeIcon(CommentAdd01Icon, "CommentAdd01Icon"),
    shortcut: "C",
  },
];

export const CREATE_TOOLS: ToolDef[] = [
  { id: "image", label: "Image", icon: ImageGenIcon },
  { id: "video", label: "Video", icon: VideoGenIcon },
  { id: "lipsync", label: "Lip sync", icon: UserSoundIcon },
  { id: "music", label: "Music", icon: MusicGenIcon },
  { id: "speech", label: "Text to speech", icon: TextToSpeechIcon },
  { id: "sfx", label: "Sound effects", icon: SpeakerHifiIcon },
  { id: "character", label: "Character sheet", icon: UserFocusIcon },
  { id: "llm", label: "LLM", icon: LlmIcon },
  { id: "text", label: "Text", icon: TextTIcon },
  { id: "composition", label: "Composition", icon: CompositionIcon },
  { id: "upload", label: "Upload media", icon: UploadSimpleIcon },
];

function ToolButton({
  tool,
  active,
  onSelect,
}: {
  tool: ToolDef;
  active: boolean;
  onSelect: (id: ToolId) => void;
}) {
  const IconComp = tool.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tool.label}
            aria-pressed={active}
            onClick={() => onSelect(tool.id)}
            className={cn(
              "grid size-9 place-items-center transition-colors duration-150",
              active
                ? "bg-primary text-primary-foreground shadow-[inset_0_-1px_0_rgba(31,33,28,0.14)]"
                : "text-[#4c4a41] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
            )}
          >
            <IconComp
              className="size-[19px]"
              weight={active ? "fill" : "regular"}
            />
          </button>
        }
      />
      <TooltipContent
        side="right"
        sideOffset={10}
        className="bg-[#1f211c] text-[#f7f4ee]"
      >
        {tool.label}
        {tool.shortcut ? (
          <span className="text-[#f7f4ee]/50">{tool.shortcut}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function Toolbar({
  activeTool,
  onSelect,
}: {
  activeTool: ToolId;
  onSelect: (id: ToolId) => void;
}) {
  const island =
    "flex flex-col gap-0.5 border border-primary bg-white/88 p-1.5 shadow-[0_18px_44px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md";

  return (
    <div
      className="fixed top-1/2 left-3 z-40 flex max-h-[92vh] -translate-y-1/2 flex-col gap-2.5 overflow-y-auto no-scrollbar animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]"
      role="toolbar"
      aria-label="Studio tools"
    >
      <div className={island}>
        {POINTER_TOOLS.map((tool) => (
          <ToolButton
            key={tool.id}
            tool={tool}
            active={activeTool === tool.id}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div className={island}>
        {CREATE_TOOLS.map((tool) => (
          <ToolButton
            key={tool.id}
            tool={tool}
            active={activeTool === tool.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
