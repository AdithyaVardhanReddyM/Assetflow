"use client";

/**
 * The sidebar's composer — the workflow prompt bar's visual language at
 * sidebar width: same border-beam frame, same white card and focus ring, the
 * same `+` attach button, with an amber up-arrow where Generate sits on the
 * big bar (there is no tab row here; the conversation *is* the mode).
 * Enter sends, Shift+Enter breaks.
 */

import * as React from "react";
import {
  ArrowUpIcon,
  GraphIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";

import { BorderBeam } from "border-beam";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export type TaggedNode = { id: string; title: string };

type PendingFile = { file: File; url: string };

export function AgentInput({
  onSend,
  disabled,
  busy,
  uploading,
  placeholder,
  taggedNode,
  onClearTag,
  inputRef,
}: {
  onSend: (text: string, files: File[], tagged: TaggedNode[]) => void;
  /** An unanswered questionnaire owns the turn — typing waits for it. */
  disabled: boolean;
  busy: boolean;
  uploading: boolean;
  placeholder: string;
  taggedNode: TaggedNode | null;
  onClearTag: () => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<PendingFile[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const ownRef = React.useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? ownRef;

  // Object URLs leak unless revoked; chips own their previews' lifetime.
  React.useEffect(
    () => () => files.forEach((f) => URL.revokeObjectURL(f.url)),
    [files],
  );

  const send = () => {
    if (busy || disabled || uploading) return;
    if (!text.trim() && !files.length) return;
    onSend(
      text,
      files.map((f) => f.file),
      taggedNode ? [taggedNode] : [],
    );
    setText("");
    setFiles([]);
    onClearTag();
  };

  return (
    <div className="shrink-0 p-3">
      <BorderBeam
        size="md"
        // Same tuning as the workflow prompt bar — see the notes there; the
        // two must read as the same instrument, docked in different places.
        colorVariant="sunset"
        theme="light"
        borderRadius={0}
        brightness={1.05}
        saturation={1.15}
        hueRange={10}
        duration={4}
        className="beam-colour-only w-full"
        style={
          {
            "--beam-stroke-opacity": 8.4,
            "--beam-inner-opacity": 3.4,
            "--beam-bloom-opacity": 0,
          } as React.CSSProperties
        }
      >
        <div
          className={cn(
            "w-full border border-[#1f211c]/8 bg-white/94 p-3 backdrop-blur-xl transition-shadow duration-300",
            "shadow-[0_20px_60px_-20px_rgba(31,33,28,0.35),0_2px_8px_rgba(31,33,28,0.05)]",
            "focus-within:border-[#1f211c]/18 focus-within:shadow-[0_20px_70px_-16px_rgba(31,33,28,0.42)]",
          )}
        >
          {taggedNode ? (
            <div className="mb-2 flex">
              <span className="flex items-center gap-1.5 border border-[#1f211c]/20 bg-[#f7f4ee] px-2 py-1 text-[11px] font-semibold text-[#1f211c]">
                <GraphIcon className="size-3.5 text-[#8a8271]" />
                <span className="max-w-44 truncate">{taggedNode.title}</span>
                <button
                  type="button"
                  aria-label="Clear tagged node"
                  onClick={onClearTag}
                  className="text-[#8a8271] hover:text-[#1f211c]"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            </div>
          ) : null}

          {files.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span
                  key={f.url}
                  className="flex items-center gap-1.5 border border-[#1f211c]/14 bg-[#f7f4ee]/80 py-1 pr-1.5 pl-1 text-[11px] font-medium text-[#4c4a41]"
                >
                  {f.file.type.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.url} alt="" className="size-6 object-cover" />
                  ) : null}
                  <span className="max-w-32 truncate">{f.file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.file.name}`}
                    onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                    className="text-[#8a8271] hover:text-[#1f211c]"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-start gap-2">
            {/* Top-aligned with the first line, same as the workflow bar. */}
            <button
              type="button"
              aria-label="Attach media"
              onClick={() => fileInput.current?.click()}
              className="mt-0.5 grid size-8 shrink-0 place-items-center border border-[#1f211c]/12 text-[#4c4a41] transition-colors hover:border-[#1f211c]/30 hover:bg-[#f7f4ee] hover:text-[#1f211c]"
            >
              <PlusIcon className="size-4" />
            </button>
            <textarea
              ref={textarea}
              rows={1}
              value={text}
              disabled={disabled}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = "";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={disabled ? "Answer the questions above first…" : placeholder}
              className="thin-scrollbar max-h-40 min-h-16 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88] disabled:opacity-60"
            />
            {/* The Generate button's amber, folded down to an arrow. */}
            <button
              type="button"
              aria-label="Send"
              onClick={send}
              disabled={busy || disabled || uploading || (!text.trim() && !files.length)}
              className={cn(
                "grid size-8 shrink-0 place-items-center self-end bg-primary text-primary-foreground",
                "shadow-[0_10px_24px_-8px_oklch(0.75_0.16_85_/_0.9),inset_0_1px_0_rgba(255,255,255,0.5)]",
                "transition-all duration-150 hover:brightness-[0.97] active:scale-[0.95]",
                "disabled:opacity-45 disabled:active:scale-100 disabled:hover:brightness-100",
              )}
            >
              {busy || uploading ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowUpIcon className="size-4" weight="bold" />
              )}
            </button>
          </div>
        </div>
      </BorderBeam>

      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!chosen.length) return;
          setFiles((all) => [
            ...all,
            ...chosen.map((file) => ({ file, url: URL.createObjectURL(file) })),
          ]);
        }}
      />
    </div>
  );
}
