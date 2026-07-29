"use client";

/**
 * The agent conversation's state machine.
 *
 * Owns the useChat wiring, the proposal lifecycle (placed → accepted /
 * rejected / replaced) and the persistence flushes, behind a narrow bridge the
 * shell provides — the shell's own diff stays small, and everything the
 * sidebar renders comes from here.
 *
 * Tool traffic is deliberately manual (no sendAutomaticallyWhen): an answered
 * questionnaire continues the conversation, but a placed proposal waits for
 * the user's verdict — Reject / Revise / Accept / Run are the continuation.
 */

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { type UIMessage, DefaultChatTransport } from "ai";
import { toast } from "sonner";

import {
  saveChatMessages,
  openChat,
  resetChat,
  setChatProposal,
  setChatStatus,
} from "@/app/workflow/chat-actions";
import type { LoadedChat } from "@/app/workflow/chat-actions";
import { compileGraphSpec } from "@/lib/studio/agent/compile-spec";
import { belowContentAt } from "@/lib/studio/agent/placement";
import type {
  AgentAttachment,
  AskUserInput,
  ChatProposal,
  GraphSpec,
  RemixSource,
  UpdateNodeInput,
} from "@/lib/studio/agent/spec";
import type { Catalog } from "@/lib/studio/catalog";
import type { AssetPreview, Graph } from "@/lib/studio/graph";

/** What the shell lends the session — everything that touches the canvas. */
export type AgentBridge = {
  graph: () => Graph;
  insertGraph: (graph: Graph, at?: { x: number; y: number }) => boolean;
  removeNodes: (ids: string[]) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  runSubgraph: (nodeIds: string[]) => Promise<boolean>;
  upload: (file: File) => Promise<AssetPreview | null>;
};

export type AgentMessageMeta = {
  attachments?: AgentAttachment[];
  taggedNodeIds?: string[];
  /** Set on the message that opened a remix; the route reads the newest one. */
  remix?: RemixSource;
};

export type PendingAsk = { toolCallId: string; input: AskUserInput };

export type AgentSession = {
  messages: UIMessage[];
  /** True while a request or stream is in flight — the input disables on it. */
  busy: boolean;
  error: Error | undefined;
  proposal: ChatProposal | null;
  /**
   * What this thread is remixing, for the sidebar's chip. `pending` while the
   * user hasn't sent the first message yet — the only moment it can still be
   * dismissed, because nothing has entered the transcript.
   */
  remixTarget: { assetId: string; filename: string | null; pending: boolean } | null;
  /** The unanswered questionnaire, if the transcript ends on one. */
  pendingAsk: PendingAsk | null;
  answerAsk: (toolCallId: string, answers: Record<string, string>) => void;
  send: (
    text: string,
    files: File[],
    tagged: { id: string; title: string }[],
  ) => Promise<void>;
  /**
   * Wipe the thread — transcript, proposal, and any nodes a placed proposal
   * left on the canvas. `send` does this itself when a prompt lands on a
   * finished thread; Remix calls it up front so the sidebar opens clean.
   */
  resetThread: () => Promise<void>;
  /** True while `send` is still uploading attachments. */
  uploading: boolean;
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  run: () => Promise<void>;
};

function metaOf(message: UIMessage): AgentMessageMeta {
  return (message.metadata ?? {}) as AgentMessageMeta;
}

function collectAttachments(messages: UIMessage[]): AgentAttachment[] {
  const seen = new Map<string, AgentAttachment>();
  for (const m of messages) {
    for (const a of metaOf(m).attachments ?? []) {
      if (a?.assetId) seen.set(a.assetId, a);
    }
  }
  return [...seen.values()];
}

/** The thread's remix, if one was declared — newest wins, same as the route. */
function collectRemix(messages: UIMessage[]): RemixSource | null {
  let found: RemixSource | null = null;
  for (const m of messages) {
    const remix = metaOf(m).remix;
    if (remix?.assetId) found = remix;
  }
  return found;
}

const MAX_SELF_CORRECTIONS = 2;

export function useAgentSession(options: {
  workflowId: string;
  catalog: Catalog;
  /** Loaded server-side by the canvas page; null when no thread exists yet. */
  initialChat: LoadedChat | null;
  bridge: AgentBridge;
  /** Called when the conversation ends (Accept / Run) — closes the sidebar. */
  onFinished: () => void;
  /** A remix staged by the library panel, waiting for its first message. */
  pendingRemix: RemixSource | null;
  /** The staged remix entered the transcript — the shell can drop its copy. */
  onRemixSent: () => void;
}): AgentSession {
  const { workflowId, catalog, initialChat, bridge, onFinished, pendingRemix, onRemixSent } =
    options;

  const chatIdRef = React.useRef<string | null>(initialChat?.chat.id ?? null);
  /**
   * Whether the loaded thread is finished. A closed thread's history is shown
   * for context, but the next prompt starts a NEW conversation — it resets
   * rather than appends, so the model (and the user) aren't dragged through a
   * brief that was already delivered.
   */
  const statusRef = React.useRef<"open" | "closed">(
    initialChat?.chat.status ?? "open",
  );
  const [proposal, setProposal] = React.useState<ChatProposal | null>(
    initialChat?.chat.proposal ?? null,
  );
  const [uploading, setUploading] = React.useState(false);
  const corrections = React.useRef(0);

  const proposalRef = React.useRef(proposal);
  React.useEffect(() => {
    proposalRef.current = proposal;
  }, [proposal]);

  const transport = React.useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { workflowId, messages },
        }),
      }),
    [workflowId],
  );

  const {
    messages,
    sendMessage,
    addToolOutput,
    status,
    error,
    setMessages,
  } = useChat({
    transport,
    messages: (initialChat?.messages ?? []) as UIMessage[],
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      if (toolCall.toolName === "propose_graph") {
        handleProposal(toolCall.toolCallId, toolCall.input as GraphSpec);
      } else if (toolCall.toolName === "update_node") {
        handleUpdateNode(toolCall.toolCallId, toolCall.input as UpdateNodeInput);
      }
      // ask_user stays unanswered until the user clicks — nothing to do here.
    },
    onError(err) {
      toast.error(err.message || "The agent hit a snag — try again.");
    },
  });

  const messagesRef = React.useRef(messages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** The chat row must exist before anything can be flushed against it. */
  const ensureChatId = React.useCallback(async (): Promise<string | null> => {
    if (chatIdRef.current) return chatIdRef.current;
    const opened = await openChat(workflowId);
    if (!opened.ok) {
      toast.error(opened.error);
      return null;
    }
    chatIdRef.current = opened.data.chat.id;
    // A reopened thread brings its history with it; merge under whatever the
    // user has already typed this session (normally nothing).
    if (opened.data.messages.length && !messagesRef.current.length) {
      setMessages(opened.data.messages as UIMessage[]);
    }
    return chatIdRef.current;
  }, [workflowId, setMessages]);

  const persistProposal = React.useCallback((next: ChatProposal | null) => {
    setProposal(next);
    const chatId = chatIdRef.current;
    if (chatId) void setChatProposal(chatId, next);
  }, []);

  const flushMessages = React.useCallback(() => {
    const chatId = chatIdRef.current;
    if (!chatId) return;
    void saveChatMessages(
      chatId,
      messagesRef.current.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata,
      })),
    );
  }, []);

  const resetThread = React.useCallback(async () => {
    const prev = proposalRef.current;
    if (prev?.status === "placed") bridge.removeNodes(prev.nodeIds);
    proposalRef.current = null;
    setProposal(null);
    corrections.current = 0;
    setMessages([]);
    statusRef.current = "open";
    // Nothing server-side to clear when no row exists yet.
    const chatId = chatIdRef.current;
    if (chatId) await resetChat(chatId);
  }, [bridge, setMessages]);

  function handleProposal(toolCallId: string, spec: GraphSpec) {
    const attachments = collectAttachments(messagesRef.current);
    const prev = proposalRef.current;

    // A new proposal supersedes a placed one — Revise's replacement half.
    if (prev?.status === "placed") {
      bridge.removeNodes(prev.nodeIds);
    }

    // A remix's spec re-emits the source chain's upload nodes; their assets
    // were never attached this thread, so they resolve through the side door.
    const remix = collectRemix(messagesRef.current);
    const compiled = compileGraphSpec(spec, catalog, attachments, remix?.sourceAssets ?? []);
    if (!compiled.ok) {
      addToolOutput({
        tool: "propose_graph",
        toolCallId,
        output: { ok: false, errors: compiled.errors },
      });
      if (corrections.current < MAX_SELF_CORRECTIONS) {
        corrections.current += 1;
        void sendMessage();
      } else {
        toast.error("The agent couldn't build a valid graph — try rephrasing.");
      }
      return;
    }

    const at = belowContentAt(bridge.graph(), compiled.size);
    const placed = bridge.insertGraph(compiled.graph, at);
    if (!placed) {
      addToolOutput({
        tool: "propose_graph",
        toolCallId,
        output: {
          ok: false,
          errors: ["the canvas is full — propose fewer nodes or ask the user to clear space"],
        },
      });
      if (corrections.current < MAX_SELF_CORRECTIONS) {
        corrections.current += 1;
        void sendMessage();
      }
      return;
    }

    corrections.current = 0;
    persistProposal({
      toolCallId,
      nodeIds: compiled.graph.nodes.map((n) => n.id),
      status: "placed",
    });
    addToolOutput({
      tool: "propose_graph",
      toolCallId,
      output: { ok: true, placed: compiled.graph.nodes.length },
    });
    // No auto-continue: the proposal card's four actions are the next move.
    // The placement itself autosaves through the canvas's normal change path;
    // make sure the transcript that references those node ids survives too.
    void ensureChatId().then(flushMessages);
  }

  function handleUpdateNode(toolCallId: string, input: UpdateNodeInput) {
    const exists = bridge.graph().nodes.some((n) => n.id === input.node_id);
    if (!exists) {
      addToolOutput({
        tool: "update_node",
        toolCallId,
        output: { ok: false, error: `no node ${input.node_id} on the canvas` },
      });
      void sendMessage();
      return;
    }
    const patch: Record<string, unknown> = {};
    if (input.prompt !== undefined) patch.prompt = input.prompt;
    if (input.title !== undefined) patch.title = input.title;
    if (input.params !== undefined) patch.params = input.params;
    bridge.updateNodeData(input.node_id, patch);
    addToolOutput({ tool: "update_node", toolCallId, output: { ok: true } });
    // Continue so the agent can confirm in words what just changed on canvas.
    void sendMessage();
  }

  const answerAsk = React.useCallback(
    (toolCallId: string, answers: Record<string, string>) => {
      addToolOutput({ tool: "ask_user", toolCallId, output: { answers } });
      void sendMessage();
    },
    [addToolOutput, sendMessage],
  );

  const send = React.useCallback(
    async (text: string, files: File[], tagged: { id: string; title: string }[]) => {
      const trimmed = text.trim();
      if (!trimmed && !files.length) return;
      // A prompt on a finished thread is a new conversation, not an appendix.
      if (statusRef.current === "closed") await resetThread();
      if (!(await ensureChatId())) return;

      let attachments: AgentAttachment[] = [];
      if (files.length) {
        setUploading(true);
        const uploadedAll = await Promise.all(files.map((f) => bridge.upload(f)));
        setUploading(false);
        const missing = uploadedAll.filter((a) => !a).length;
        if (missing) toast.error("Some attachments failed to upload.");
        attachments = uploadedAll
          .filter((a): a is AssetPreview => a !== null)
          .map((a) => ({
            assetId: a.id,
            mediaType: a.mediaType,
            modality: a.modality,
            filename: a.filename,
          }));
      }

      corrections.current = 0;
      const tags = tagged.map((t) => `[node:${t.id} "${t.title}"]`).join(" ");
      const metadata: AgentMessageMeta = {};
      if (attachments.length) metadata.attachments = attachments;
      if (tagged.length) metadata.taggedNodeIds = tagged.map((t) => t.id);
      if (pendingRemix) {
        metadata.remix = pendingRemix;
        onRemixSent();
      }

      await sendMessage({
        text: tags ? `${trimmed}\n${tags}` : trimmed,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      });
    },
    [bridge, ensureChatId, sendMessage, pendingRemix, onRemixSent, resetThread],
  );

  const closeOut = React.useCallback(
    async (outcome: "accepted" | "rejected") => {
      const prev = proposalRef.current;
      if (!prev) return;
      if (outcome === "rejected" && prev.status === "placed") {
        bridge.removeNodes(prev.nodeIds);
      }
      persistProposal({ ...prev, status: outcome });
      flushMessages();
    },
    [bridge, persistProposal, flushMessages],
  );

  const accept = React.useCallback(async () => {
    await closeOut("accepted");
    statusRef.current = "closed";
    const chatId = chatIdRef.current;
    if (chatId) void setChatStatus(chatId, "closed");
    onFinished();
  }, [closeOut, onFinished]);

  const reject = React.useCallback(async () => {
    await closeOut("rejected");
    // The chat stays open — the user owes the agent a better brief.
  }, [closeOut]);

  const run = React.useCallback(async () => {
    const prev = proposalRef.current;
    if (!prev || prev.status !== "placed") return;
    const started = await bridge.runSubgraph(prev.nodeIds);
    if (!started) return; // the shell already toasted why
    await closeOut("accepted");
    statusRef.current = "closed";
    const chatId = chatIdRef.current;
    if (chatId) void setChatStatus(chatId, "closed");
    onFinished();
  }, [bridge, closeOut, onFinished]);

  /**
   * The home handoff: the row arrived holding one unanswered user message.
   * Fire the first request once, so the conversation starts the moment the
   * canvas opens rather than waiting for a second prompt.
   */
  const autostarted = React.useRef(false);
  React.useEffect(() => {
    if (autostarted.current || status !== "ready") return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") return;
    if (initialChat?.chat.status !== "open") return;
    autostarted.current = true;
    void sendMessage();
  }, [status, messages, initialChat, sendMessage]);

  // Plain derivation — the compiler memoizes renders on its own.
  let pendingAsk: PendingAsk | null = null;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    for (const part of last.parts) {
      if (
        part.type === "tool-ask_user" &&
        "state" in part &&
        part.state === "input-available"
      ) {
        pendingAsk = {
          toolCallId: (part as { toolCallId: string }).toolCallId,
          input: (part as { input: AskUserInput }).input,
        };
        break;
      }
    }
  }

  const sentRemix = collectRemix(messages);
  const remixTarget = pendingRemix
    ? { assetId: pendingRemix.assetId, filename: pendingRemix.filename, pending: true }
    : sentRemix
      ? { assetId: sentRemix.assetId, filename: sentRemix.filename, pending: false }
      : null;

  return {
    messages,
    busy: status === "submitted" || status === "streaming",
    error,
    proposal,
    remixTarget,
    pendingAsk,
    answerAsk,
    send,
    resetThread,
    uploading,
    accept,
    reject,
    run,
  };
}
