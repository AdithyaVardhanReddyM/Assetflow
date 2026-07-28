"use client";

/**
 * The sidebar's composer. Same keyboard contract as the prompt bar (Enter
 * sends, Shift+Enter breaks), plus attachment chips with local previews and
 * the node-tag chip a canvas selection produces — sending with one attaches
 * `[node:id "title"]` context so the agent knows what "this" means.
 */

import * as React from "react";
import {
  ArrowUpIcon,
  GraphIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";

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
    <div className="border-t border-[#1f211c]/8 bg-white/80 p-3">
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
              className="relative flex items-center gap-1.5 border border-[#1f211c]/14 bg-white py-1 pr-1.5 pl-1 text-[11px] font-medium text-[#4c4a41]"
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

      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label="Attach media"
          onClick={() => fileInput.current?.click()}
          className="grid size-8 shrink-0 place-items-center border border-[#1f211c]/12 text-[#4c4a41] transition-colors hover:border-[#1f211c]/30 hover:bg-[#f7f4ee] hover:text-[#1f211c]"
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
          className="thin-scrollbar max-h-35 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88] disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Send"
          onClick={send}
          disabled={busy || disabled || uploading || (!text.trim() && !files.length)}
          className={cn(
            "grid size-8 shrink-0 place-items-center bg-[#1f211c] text-[#f7f4ee] transition-all",
            "hover:brightness-110 active:scale-[0.95] disabled:opacity-40 disabled:active:scale-100",
          )}
        >
          {busy || uploading ? (
            <Spinner className="size-4" />
          ) : (
            <ArrowUpIcon className="size-4" weight="bold" />
          )}
        </button>
      </div>

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
