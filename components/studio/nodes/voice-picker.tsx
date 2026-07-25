"use client";

/**
 * The TTS node's voice control — what `ui: voice` on an enum param renders.
 *
 * A select full of names ("Alice", "Brian", "Will") asks the user to pick a
 * voice on no information at all. This shows what each one actually is: the
 * character sketch ElevenLabs ships with it, the gender/age/accent tags, and a
 * sample they can play without leaving the canvas or spending a generation.
 *
 * The catalog's `options` remain the source of which voices exist — metadata
 * only decorates them, so an unreachable ElevenLabs degrades this to the plain
 * names it replaced rather than an empty list.
 */

import * as React from "react";
import { CaretDownIcon, MagnifyingGlassIcon, MicrophoneIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ParamDescriptor } from "@/lib/studio/catalog";
import { fetchVoices, voiceHaystack, voiceTags, type VoiceMeta } from "@/lib/studio/voices-client";
import { cn } from "@/lib/utils";

/**
 * One sample plays at a time, canvas-wide.
 *
 * Previews are transient — starting one always stops whatever was playing,
 * including a preview in a different node. A module-level element (rather than
 * one per row) is what makes that true without any cross-node wiring.
 */
let previewAudio: HTMLAudioElement | null = null;
let previewObjectUrl: string | null = null;
const previewListeners = new Set<(playing: string | null) => void>();
let previewing: string | null = null;

function setPreviewing(next: string | null) {
  previewing = next;
  for (const listener of previewListeners) listener(next);
}

function stopPreview() {
  previewAudio?.pause();
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

/**
 * Play `url` as a typed blob.
 *
 * ElevenLabs serves most premade samples from GCS with `content-type:
 * text/plain`. Chrome sniffs the bytes and plays them anyway; stricter browsers
 * refuse. The CDN sends `access-control-allow-origin: *`, so re-fetching and
 * re-labelling the bytes as audio/mpeg is available as a fallback.
 */
async function playAsBlob(voiceId: string, url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const blob = new Blob([await res.arrayBuffer()], { type: "audio/mpeg" });
  // The user may have hit stop, or started another voice, while this was in
  // flight — in that case the fetch result is stale, so drop it.
  if (previewing !== voiceId) return;
  previewObjectUrl = URL.createObjectURL(blob);
  if (!previewAudio) return;
  previewAudio.src = previewObjectUrl;
  await previewAudio.play();
}

function togglePreview(voiceId: string, url: string | null) {
  if (!url) return;
  if (previewing === voiceId) {
    stopPreview();
    setPreviewing(null);
    return;
  }
  stopPreview();
  previewAudio = new Audio(url);
  previewAudio.addEventListener("ended", () => setPreviewing(null));
  setPreviewing(voiceId);
  void previewAudio.play().catch(() => {
    void playAsBlob(voiceId, url).catch(() => setPreviewing(null));
  });
}

function usePreviewing(): string | null {
  const [value, setValue] = React.useState<string | null>(previewing);
  React.useEffect(() => {
    previewListeners.add(setValue);
    return () => {
      previewListeners.delete(setValue);
    };
  }, []);
  return value;
}

function useVoiceIndex() {
  const [byId, setById] = React.useState<Record<string, VoiceMeta>>({});
  React.useEffect(() => {
    let live = true;
    void fetchVoices().then((index) => {
      if (live) setById(index.byId);
    });
    return () => {
      live = false;
    };
  }, []);
  return byId;
}

function PreviewButton({
  voiceId,
  url,
  className,
}: {
  voiceId: string;
  url: string | null;
  className?: string;
}) {
  const playing = usePreviewing() === voiceId;
  if (!url) return null;
  return (
    <button
      type="button"
      aria-label={playing ? "Stop sample" : "Play sample"}
      onClick={(e) => {
        // The row behind this is the select — previewing is not choosing.
        e.stopPropagation();
        togglePreview(voiceId, url);
      }}
      className={cn(
        "nodrag grid size-6 shrink-0 place-items-center rounded-full transition-colors",
        playing
          ? "bg-[#1f211c] text-[#f7f4ee]"
          : "bg-[#1f211c]/8 text-[#1f211c] hover:bg-[#1f211c]/16",
        className,
      )}
    >
      {playing ? (
        <PauseIcon weight="fill" className="size-3" />
      ) : (
        <PlayIcon weight="fill" className="size-3 translate-x-[0.5px]" />
      )}
    </button>
  );
}

export function VoicePicker({
  param,
  value,
  onChange,
}: {
  param: ParamDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const byId = useVoiceIndex();

  const effective =
    value === undefined || value === null || value === "" ? param.default : value;
  const selectedId = String(effective ?? "");
  const options = param.options ?? [];
  const selected = options.find((o) => o.value === selectedId);
  const selectedMeta = byId[selectedId];

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter((o) => voiceHaystack(o.label ?? o.value, byId[o.value]).includes(needle))
    : options;

  const selectedTags = voiceTags(selectedMeta).slice(0, 3);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening with a stale query would hide most of the list for no
        // visible reason.
        if (!next) setQuery("");
      }}
    >
      {/* The preview control sits *beside* the trigger, not inside it: one
          button inside another is invalid HTML, and previewing the current
          voice should not also open the list. */}
      <div className="nodrag flex w-full items-center border border-[#1f211c]/14 bg-[#f7f4ee]/60 transition-colors focus-within:border-[#1f211c]/30 hover:border-[#1f211c]/30">
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left outline-none"
            >
              <MicrophoneIcon className="size-3.5 shrink-0 text-[#8a8271]" weight="fill" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-[#1f211c]">
                    {selectedMeta?.name ?? selected?.label ?? selected?.value ?? "Select…"}
                  </span>
                  {selectedMeta?.tagline ? (
                    <span className="truncate text-[11px] text-[#a09a88]">
                      {selectedMeta.tagline}
                    </span>
                  ) : null}
                </span>
                {selectedTags.length ? (
                  <span className="mt-0.5 block truncate text-[10.5px] tracking-[0.01em] text-[#a09a88]">
                    {selectedTags.join(" · ")}
                  </span>
                ) : null}
              </span>
              <CaretDownIcon className="size-3 shrink-0 text-[#a09a88]" />
            </button>
          }
        />
        <span className="shrink-0 pr-2 pl-1">
          <PreviewButton voiceId={selectedId} url={selectedMeta?.preview_url ?? null} />
        </span>
      </div>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        // Deliberately wider than the node it hangs off — a name, a tagline and
        // three tags per row need the room, and the popover is portalled so it
        // is not clipped by the card.
        className="nodrag nowheel w-80 gap-0 border border-[#1f211c]/10 bg-white/97 p-0 shadow-[0_24px_60px_-16px_rgba(31,33,28,0.35)] ring-0 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 border-b border-[#1f211c]/8 px-2.5 py-2">
          <MagnifyingGlassIcon className="size-3.5 shrink-0 text-[#a09a88]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tone, accent, age…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1f211c] outline-none placeholder:text-[#a09a88]"
          />
        </div>

        <div
          role="listbox"
          aria-label="Voices"
          className="thin-scrollbar max-h-72 overflow-y-auto p-1"
        >
          {visible.length ? (
            visible.map((option) => {
              const meta = byId[option.value];
              const tags = voiceTags(meta);
              const isSelected = option.value === selectedId;
              return (
                // A div, not a button: the preview control is a real button and
                // nesting one inside another is invalid HTML (React says so at
                // hydration). `option` carries the semantics the element lost.
                <div
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 px-2 py-2 text-left transition-colors outline-none",
                    isSelected ? "bg-[#f7f4ee]" : "hover:bg-[#f7f4ee]/70 focus-visible:bg-[#f7f4ee]/70",
                  )}
                >
                  <PreviewButton voiceId={option.value} url={meta?.preview_url ?? null} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-[#1f211c]">
                        {meta?.name ?? option.label ?? option.value}
                      </span>
                      {meta?.tagline ? (
                        <span className="truncate text-[11px] text-[#a09a88]">{meta.tagline}</span>
                      ) : null}
                    </span>
                    {/* Tags carry the useful part of the description — tone,
                        accent, age — so the prose itself is redundant here. */}
                    {tags.length ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className="border border-[#1f211c]/10 bg-[#f7f4ee] px-1.5 py-px text-[10px] tracking-[0.01em] text-[#6f6a5c]"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="px-2 py-6 text-center text-[11.5px] text-[#a09a88]">
              No voice matches “{query}”
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
