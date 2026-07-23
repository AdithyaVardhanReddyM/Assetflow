"use client";

/**
 * Canvas comments.
 *
 * The design idea, in one line: **people speak in serif, machines speak in
 * sans.** Every node on this canvas is set in the UI sans; a comment is set in
 * Instrument Serif — the same face as the home screen's greeting — so someone's
 * voice is legible as a voice at a glance, before a word of it is read.
 *
 * The pin is a hard-edged paper tag rather than a round bubble. Nothing in this
 * design language has a radius, and a circle would be the one foreign shape on
 * screen; a tag with a tail down to its anchor point says "this is stuck here"
 * in the system's own vocabulary. The shape is one SVG path so the hairline
 * stays a hairline at any zoom.
 *
 * Pins live in flow space (they must stay on what they point at) but hold a
 * constant screen size, counter-scaled against zoom — position tracks the
 * graph, legibility does not.
 */

import * as React from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ArrowUpIcon,
  ArrowUUpLeftIcon,
  CheckIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { CanvasComment } from "@/app/workflow/comments";

export type CommentsApi = {
  items: CanvasComment[];
  currentUserId: string | null;
  add: (input: { x: number; y: number; body: string }) => Promise<boolean>;
  reply: (parentId: string, body: string) => Promise<boolean>;
  setResolved: (id: string, resolved: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

export type CommentDraft = { x: number; y: number };

const PIN_W = 28;
const PIN_H = 35;
const PANEL_W = 320;

/**
 * How far right of the anchor a panel opens. The tag hangs its full width to
 * the right of the point it marks, so anything less than `PIN_W` puts the panel
 * on top of the very pin it belongs to.
 */
const PANEL_OFFSET_X = PIN_W + 14;

const surface =
  "border border-[#1f211c]/10 bg-white/96 shadow-[0_24px_60px_-18px_rgba(31,33,28,0.42),0_2px_6px_rgba(31,33,28,0.06)] backdrop-blur-md";

function initialOf(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function shortTime(iso: string) {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

// --- pin ------------------------------------------------------------------

/**
 * The tag outline, drawn once. Square body, tail sweeping to the bottom-left
 * tip — which is the anchor, so the point of the comment sits exactly on the
 * point of the canvas it is about.
 */
function TagShape({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${PIN_W} ${PIN_H}`}
      width={PIN_W}
      height={PIN_H}
      className={cn("absolute inset-0", className)}
      aria-hidden
    >
      <path
        d={`M0.5 0.5 H${PIN_W - 0.5} V${PIN_W - 0.5} H8.5 L0.5 ${PIN_H - 0.5} Z`}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CommentPin({
  comment,
  state,
  onClick,
}: {
  comment: CanvasComment;
  state: "idle" | "open" | "resolved";
  onClick: () => void;
}) {
  const open = state === "open";
  const resolved = state === "resolved";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={`Comment from ${comment.authorName}`}
      style={{ width: PIN_W, height: PIN_H }}
      className={cn(
        "group relative block origin-bottom-left transition-transform duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
        "animate-[studio-rise_0.4s_cubic-bezier(0.32,0.72,0,1)_both] hover:scale-110",
        resolved && "opacity-45 hover:opacity-100",
      )}
    >
      <TagShape
        className={cn(
          open
            ? "fill-[#1f211c] stroke-[#1f211c]"
            : "fill-white stroke-[#1f211c]/45 group-hover:stroke-[#1f211c]/80",
          resolved && !open && "[stroke-dasharray:3_2.5] fill-[#f7f4ee]",
        )}
      />
      <span
        className={cn(
          "absolute inset-x-0 top-0 grid h-7 place-items-center font-serif text-[15px] leading-none italic",
          open ? "text-[#f7f4ee]" : "text-[#1f211c]",
        )}
      >
        {resolved && !open ? (
          <CheckIcon className="size-3.5 not-italic" weight="bold" />
        ) : (
          initialOf(comment.authorName)
        )}
      </span>
    </button>
  );
}

// --- composer -------------------------------------------------------------

function Composer({
  placeholder,
  autoFocus,
  busy,
  bordered = true,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  busy: boolean;
  /** Off on the draft, where the composer *is* the panel and needs no seam. */
  bordered?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = React.useState("");
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const ready = value.trim().length > 0 && !busy;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  const submit = () => {
    const body = value.trim();
    if (!body || busy) return;
    setValue("");
    onSubmit(body);
  };

  return (
    <div
      className={cn(
        "flex items-end gap-1.5 px-2.5 py-2",
        bordered && "border-t border-[#1f211c]/8",
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        // The placeholder stays in the same serif as the note it will become —
        // fighting the cascade to make it sans only produced two typefaces in
        // one box, which read as a bug rather than a distinction.
        className="thin-scrollbar max-h-30 min-h-7 flex-1 resize-none bg-transparent py-0.5 font-serif text-[14px] leading-[1.5] text-[#1f211c] outline-none placeholder:text-[#b3ac9a]"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!ready}
        aria-label="Post comment"
        // Ghost until there is something to send, so the button reads as the
        // next step rather than a grey slab sitting in an empty box.
        className={cn(
          "grid size-7 shrink-0 place-items-center border transition-all duration-150",
          ready
            ? "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee] hover:opacity-85"
            : "border-[#1f211c]/12 bg-transparent text-[#c0baa8]",
        )}
      >
        <ArrowUpIcon className="size-3.5" weight="bold" />
      </button>
    </div>
  );
}

// --- one message ----------------------------------------------------------

function Message({
  comment,
  mine,
  onDelete,
}: {
  comment: CanvasComment;
  mine: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="group/msg px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-serif text-[13px] font-medium text-[#1f211c] italic">
          {comment.authorName}
        </span>
        <span className="text-[10.5px] text-[#b3ac9a]">
          {shortTime(comment.createdAt)}
        </span>
        {mine ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete comment"
            className="ml-auto text-[#c0baa8] opacity-0 transition-all duration-150 group-hover/msg:opacity-100 hover:text-[#a94848] focus-visible:opacity-100"
          >
            <TrashIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 font-serif text-[14px] leading-[1.5] whitespace-pre-wrap text-[#31332c]">
        {comment.body}
      </p>
    </div>
  );
}

// --- thread panel ---------------------------------------------------------

/**
 * Screen-space, not flow-space: a panel that scaled with the canvas would be
 * unreadable zoomed out and enormous zoomed in. It tracks the pin by reading
 * the viewport transform directly, and `clamp()` keeps it on screen without a
 * resize listener.
 */
function ThreadPanel({
  root,
  replies,
  api,
  onClose,
}: {
  root: CanvasComment;
  replies: CanvasComment[];
  api: CommentsApi;
  onClose: () => void;
}) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const [busy, setBusy] = React.useState(false);

  const left = root.x * zoom + tx + PANEL_OFFSET_X;
  const top = root.y * zoom + ty - 40;
  const resolved = root.resolvedAt !== null;

  return (
    <div
      style={{
        left: `clamp(12px, ${left}px, calc(100vw - ${PANEL_W + 12}px))`,
        top: `clamp(12px, ${top}px, calc(100vh - 320px))`,
        width: PANEL_W,
      }}
      className={cn(
        surface,
        // `nowheel` keeps a scroll inside the thread from reaching the canvas,
        // which pans on scroll — reading a long thread would otherwise drag the
        // graph out from under its own pin.
        "nowheel fixed z-50 flex max-h-[60vh] flex-col",
        "animate-[studio-rise_0.28s_cubic-bezier(0.32,0.72,0,1)_both]",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[#1f211c]/8 pr-1 pl-2.5">
        <span className="text-[10px] tracking-[0.16em] text-[#b3ac9a] uppercase">
          {resolved ? "Resolved" : replies.length ? "Thread" : "Comment"}
        </span>
        <button
          type="button"
          onClick={() => void api.setResolved(root.id, !resolved)}
          className={cn(
            "ml-auto flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-semibold transition-colors duration-150",
            resolved
              ? "text-[#527d5a] hover:bg-[#1f211c]/6"
              : "text-[#8a8271] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
          )}
        >
          <CheckIcon className="size-3.5" weight="bold" />
          {resolved ? "Reopen" : "Resolve"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="grid size-6 place-items-center text-[#8a8271] transition-colors duration-150 hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 divide-y divide-[#1f211c]/6 overflow-y-auto">
        <Message
          comment={root}
          mine={root.authorUserId === api.currentUserId}
          onDelete={() => {
            onClose();
            void api.remove(root.id);
          }}
        />
        {replies.map((reply) => (
          <Message
            key={reply.id}
            comment={reply}
            mine={reply.authorUserId === api.currentUserId}
            onDelete={() => void api.remove(reply.id)}
          />
        ))}
      </div>

      <div className="shrink-0">
        <Composer
          placeholder={replies.length ? "Reply…" : "Add a reply…"}
          busy={busy}
          onSubmit={async (body) => {
            setBusy(true);
            await api.reply(root.id, body);
            setBusy(false);
          }}
        />
      </div>
    </div>
  );
}

// --- draft ----------------------------------------------------------------

function DraftPanel({
  draft,
  api,
  onCancel,
}: {
  draft: CommentDraft;
  api: CommentsApi;
  onCancel: () => void;
}) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const [busy, setBusy] = React.useState(false);

  const left = draft.x * zoom + tx + PANEL_OFFSET_X;
  const top = draft.y * zoom + ty - 40;

  return (
    <div
      style={{
        left: `clamp(12px, ${left}px, calc(100vw - ${PANEL_W + 12}px))`,
        top: `clamp(12px, ${top}px, calc(100vh - 200px))`,
        width: PANEL_W,
      }}
      className={cn(
        surface,
        "nowheel fixed z-50 animate-[studio-rise_0.28s_cubic-bezier(0.32,0.72,0,1)_both]",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* No header bar: a new comment is one field, and a title over an empty
          box is furniture. Cancel lives in the footer, next to the keys that
          do the same job faster. */}
      <Composer
        placeholder="Leave a note…"
        autoFocus
        busy={busy}
        bordered={false}
        onCancel={onCancel}
        onSubmit={async (body) => {
          setBusy(true);
          const ok = await api.add({ x: draft.x, y: draft.y, body });
          setBusy(false);
          if (ok) onCancel();
        }}
      />
      <div className="flex items-center gap-2 border-t border-[#1f211c]/6 px-2.5 py-1.5">
        <span className="text-[10.5px] text-[#b3ac9a]">
          <kbd className="font-sans">Enter</kbd> to post ·{" "}
          <kbd className="font-sans">Esc</kbd> to discard
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto text-[11px] font-semibold text-[#8a8271] transition-colors duration-150 hover:text-[#1f211c]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The dashed placeholder standing where the comment will land. */
function DraftPin() {
  return (
    <div
      style={{ width: PIN_W, height: PIN_H }}
      className="relative animate-[studio-rise_0.3s_cubic-bezier(0.32,0.72,0,1)_both]"
    >
      <TagShape className="fill-white stroke-[#1f211c]/45 [stroke-dasharray:3_2.5]" />
      <span className="absolute inset-x-0 top-0 grid h-7 place-items-center">
        <span className="size-1.5 animate-pulse bg-[#1f211c]/35" />
      </span>
    </div>
  );
}

// --- layer ----------------------------------------------------------------

export function CommentLayer({
  api,
  draft,
  openId,
  onOpen,
  onCancelDraft,
}: {
  api: CommentsApi;
  draft: CommentDraft | null;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onCancelDraft: () => void;
}) {
  // Only zoom, so a pan does not re-render every pin — the portal already
  // moves them, and all they need from the viewport is how much to resist it.
  const zoom = useStore((s) => s.transform[2]);

  const { pins, repliesOf } = React.useMemo(() => {
    const pins: CanvasComment[] = [];
    const repliesOf = new Map<string, CanvasComment[]>();
    for (const item of api.items) {
      if (item.parentId === null) pins.push(item);
      else {
        const list = repliesOf.get(item.parentId);
        if (list) list.push(item);
        else repliesOf.set(item.parentId, [item]);
      }
    }
    return { pins, repliesOf };
  }, [api.items]);

  const open = openId ? pins.find((p) => p.id === openId) : undefined;

  return (
    <>
      <ViewportPortal>
        {pins.map((pin) => (
          // Zero-sized anchor at the comment's flow position: the pin hangs off
          // its bottom-left corner, and the counter-scale pivots on that same
          // point, so the tail tip never drifts off the spot at any zoom.
          <div
            key={pin.id}
            style={{
              position: "absolute",
              left: pin.x,
              top: pin.y,
              width: 0,
              height: 0,
              transform: `scale(${1 / zoom})`,
              transformOrigin: "0 0",
              zIndex: pin.id === openId ? 6 : 5,
            }}
          >
            <div className="studio-comment-pin absolute bottom-0 left-0">
              <CommentPin
                comment={pin}
                state={
                  pin.id === openId
                    ? "open"
                    : pin.resolvedAt
                      ? "resolved"
                      : "idle"
                }
                onClick={() => onOpen(pin.id === openId ? null : pin.id)}
              />
            </div>
          </div>
        ))}

        {draft ? (
          <div
            style={{
              position: "absolute",
              left: draft.x,
              top: draft.y,
              width: 0,
              height: 0,
              transform: `scale(${1 / zoom})`,
              transformOrigin: "0 0",
              zIndex: 7,
            }}
          >
            <div className="absolute bottom-0 left-0">
              <DraftPin />
            </div>
          </div>
        ) : null}
      </ViewportPortal>

      {open ? (
        <ThreadPanel
          key={open.id}
          root={open}
          replies={repliesOf.get(open.id) ?? []}
          api={api}
          onClose={() => onOpen(null)}
        />
      ) : null}

      {draft ? (
        <DraftPanel draft={draft} api={api} onCancel={onCancelDraft} />
      ) : null}
    </>
  );
}

/** The hint that replaces the empty-canvas one while the comment tool is up. */
export function CommentModeHint() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-20 flex justify-center">
      <div className="flex items-center gap-2 border border-[#1f211c]/8 bg-white/88 px-3 py-1.5 text-[12px] text-[#8a8271] shadow-[0_14px_36px_-16px_rgba(31,33,28,0.3)] backdrop-blur-md">
        <ArrowUUpLeftIcon className="size-3.5 -scale-x-100" />
        Click anywhere to leave a comment
      </div>
    </div>
  );
}
