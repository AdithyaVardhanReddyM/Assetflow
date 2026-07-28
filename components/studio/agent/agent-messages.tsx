"use client";

/**
 * The transcript. User turns sit right in ink-on-cream bubbles; the agent's
 * text renders as plain paragraphs, and its tool calls become the interactive
 * cards — questions to click, a proposal to judge, a node edit receipt.
 */

import * as React from "react";
import { FileIcon, GraphIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import type { UIMessage } from "ai";

import type {
  AgentAttachment,
  AskUserInput,
  ChatProposal,
  GraphSpec,
} from "@/lib/studio/agent/spec";
import type { AgentMessageMeta, AgentSession } from "./use-agent-session";
import { McqCard } from "./mcq-card";
import { ProposalCard } from "./proposal-card";

type ToolPart = {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type.startsWith("tool-") && "toolCallId" in part;
}

function AttachmentChips({ attachments }: { attachments: AgentAttachment[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((a) => (
        <span
          key={a.assetId}
          className="flex items-center gap-1.5 border border-[#1f211c]/14 bg-white px-2 py-1 text-[11px] font-medium text-[#4c4a41]"
        >
          <FileIcon className="size-3.5 text-[#8a8271]" />
          <span className="max-w-40 truncate">{a.filename ?? a.modality}</span>
        </span>
      ))}
    </div>
  );
}

export function AgentMessages({
  session,
  proposal,
  runBusy,
  onRevise,
}: {
  session: AgentSession;
  proposal: ChatProposal | null;
  runBusy: boolean;
  onRevise: () => void;
}) {
  const viewport = React.useRef<HTMLDivElement>(null);

  // Pinned to the tail: a conversation reads newest-last, and streaming text
  // grows the column continuously.
  React.useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages, session.busy]);

  return (
    <div
      ref={viewport}
      className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="flex flex-col gap-4">
        {session.messages.map((message) => (
          <MessageBlock
            key={message.id}
            message={message}
            session={session}
            proposal={proposal}
            runBusy={runBusy}
            onRevise={onRevise}
          />
        ))}
        {session.busy ? (
          <p className="animate-pulse text-[12px] font-medium text-[#8a8271]">
            Thinking…
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MessageBlock({
  message,
  session,
  proposal,
  runBusy,
  onRevise,
}: {
  message: UIMessage;
  session: AgentSession;
  proposal: ChatProposal | null;
  runBusy: boolean;
  onRevise: () => void;
}) {
  const meta = (message.metadata ?? {}) as AgentMessageMeta;

  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return (
      <div className="flex flex-col items-end gap-1.5">
        {meta.attachments?.length ? (
          <AttachmentChips attachments={meta.attachments} />
        ) : null}
        {text ? (
          <div className="max-w-[85%] bg-[#1f211c] px-3 py-2 text-[12.5px] leading-5 whitespace-pre-wrap text-[#f7f4ee]">
            {text}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text.trim() ? (
            <p
              key={index}
              className="text-[12.5px] leading-5 whitespace-pre-wrap text-[#1f211c]"
            >
              {part.text}
            </p>
          ) : null;
        }
        if (!isToolPart(part)) return null;

        if (part.type === "tool-ask_user" && part.input) {
          const answered =
            part.state === "output-available"
              ? ((part.output as { answers?: Record<string, string> })?.answers ?? {})
              : null;
          return (
            <McqCard
              key={part.toolCallId}
              input={part.input as AskUserInput}
              answered={answered}
              onSubmit={(answers) => session.answerAsk(part.toolCallId, answers)}
            />
          );
        }

        if (part.type === "tool-propose_graph" && part.input) {
          const spec = part.input as GraphSpec;
          const output = part.output as
            | { ok: boolean; placed?: number; errors?: string[] }
            | undefined;
          if (output && !output.ok) {
            return (
              <p key={part.toolCallId} className="text-[11.5px] text-[#8a8271] italic">
                Reworking the graph…
              </p>
            );
          }
          const mine = proposal?.toolCallId === part.toolCallId;
          return (
            <ProposalCard
              key={part.toolCallId}
              summary={spec.summary}
              nodeCount={spec.nodes.length}
              active={Boolean(mine && proposal?.status === "placed")}
              outcome={mine ? (proposal!.status as "accepted" | "rejected" | "replaced") : "replaced"}
              busy={runBusy}
              onReject={() => void session.reject()}
              onRevise={onRevise}
              onAccept={() => void session.accept()}
              onRun={() => void session.run()}
            />
          );
        }

        if (part.type === "tool-update_node") {
          return (
            <p
              key={part.toolCallId}
              className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#527d5a]"
            >
              <PencilSimpleIcon className="size-3.5" />
              Updated the node on the canvas.
            </p>
          );
        }

        if (part.type.startsWith("tool-") && part.state === "input-streaming") {
          return (
            <p
              key={part.toolCallId}
              className="flex animate-pulse items-center gap-1.5 text-[11.5px] font-medium text-[#8a8271]"
            >
              <GraphIcon className="size-3.5" />
              Drafting…
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}
