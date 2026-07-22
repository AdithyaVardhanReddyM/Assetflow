"use client";

import { formatDistanceToNowStrict } from "date-fns";
import {
  FilmSlateIcon,
  IdentificationCardIcon,
  ImageSquareIcon,
  MusicNotesIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

export type WorkflowCard = {
  id: string;
  name: string;
  updatedAt: string; // ISO
};

/** Warm curated duos — picked by name hash so a workflow keeps its colors. */
const SWATCHES: [string, string][] = [
  ["#f3e3bd", "#e0a73c"],
  ["#e3ead9", "#7ca982"],
  ["#efe4f5", "#a48ad4"],
  ["#fbe3d1", "#e08a4c"],
  ["#dde9f2", "#6d9dc5"],
  ["#f5dede", "#cf7c7c"],
];

const TEMPLATES: { name: string; tag: string; icon: Icon }[] = [
  { name: "Product shot set", tag: "Image", icon: ImageSquareIcon },
  { name: "Character turnaround", tag: "Character", icon: IdentificationCardIcon },
  { name: "Lyric video", tag: "Video", icon: FilmSlateIcon },
  { name: "Podcast trailer", tag: "Audio", icon: MusicNotesIcon },
];

function hashHue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SWATCHES[Math.abs(h) % SWATCHES.length];
}

function CardShell({
  onClick,
  children,
  delay,
}: {
  onClick: () => void;
  children: React.ReactNode;
  delay: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      className="group w-52 shrink-0 overflow-hidden border border-[#1f211c]/8 bg-white/88 text-left shadow-[0_1px_2px_rgba(31,33,28,0.05),0_8px_20px_-12px_rgba(31,33,28,0.22)] backdrop-blur-sm transition-all duration-200 animate-[studio-rise_0.65s_cubic-bezier(0.32,0.72,0,1)_both] hover:-translate-y-1 hover:border-[#1f211c]/16 hover:shadow-[0_2px_4px_rgba(31,33,28,0.06),0_18px_36px_-18px_rgba(31,33,28,0.28)]"
    >
      {children}
    </button>
  );
}

export function WorkflowCards({
  workflows,
  onOpen,
  onStartTemplate,
}: {
  workflows: WorkflowCard[];
  /** Passed the whole card: opening one has to load its graph by id. */
  onOpen: (card: WorkflowCard) => void;
  /** Templates are not saved rows — they open a blank canvas under that name. */
  onStartTemplate: (name: string) => void;
}) {
  const hasWorkflows = workflows.length > 0;

  return (
    <div className="mx-auto w-[min(1000px,calc(100vw-160px))]">
      <div className="mb-3 flex items-baseline justify-between px-1">
        <h2 className="text-[13px] font-semibold tracking-[0.02em] text-[#4c4a41]">
          {hasWorkflows ? "Recent workflows" : "Start from a template"}
        </h2>
        <span className="text-xs text-[#a09a88]">
          {hasWorkflows
            ? `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`
            : "or just start typing a prompt"}
        </span>
      </div>

      {/* overflow-x-auto also clips vertically, so the padding here has to clear
          the hover shadow (~36px below, ~18px aside); negative margins undo it. */}
      <div className="no-scrollbar -mx-4 -mb-7 flex gap-3.5 overflow-x-auto px-5 pt-2 pb-10">
        {hasWorkflows
          ? workflows.map((wf, i) => {
              const [from, to] = hashHue(wf.name);
              return (
                <CardShell key={wf.id} delay={i * 55} onClick={() => onOpen(wf)}>
                  <div
                    className="relative h-[104px] w-full"
                    style={{
                      background: `radial-gradient(130% 140% at 18% 0%, ${from} 30%, ${to} 100%)`,
                    }}
                  >
                    <SparkleIcon
                      weight="fill"
                      className="absolute right-3 bottom-2.5 size-4 text-white/70 mix-blend-overlay"
                    />
                  </div>
                  <div className="p-3">
                    <p className="truncate text-[13px] font-semibold text-[#1f211c]">
                      {wf.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#a09a88]">
                      Edited{" "}
                      {formatDistanceToNowStrict(new Date(wf.updatedAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </CardShell>
              );
            })
          : TEMPLATES.map((tpl, i) => {
              const [from, to] = hashHue(tpl.name);
              const IconComp = tpl.icon;
              return (
                <CardShell
                  key={tpl.name}
                  delay={i * 55}
                  onClick={() => onStartTemplate(tpl.name)}
                >
                  <div
                    className="relative h-[104px] w-full"
                    style={{
                      background: `radial-gradient(130% 140% at 18% 0%, ${from} 30%, ${to} 100%)`,
                    }}
                  >
                    <IconComp
                      weight="duotone"
                      className="absolute right-3 bottom-2.5 size-6 text-[#1f211c]/35"
                    />
                  </div>
                  <div className="p-3">
                    <p className="truncate text-[13px] font-semibold text-[#1f211c]">
                      {tpl.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#a09a88]">
                      Template · {tpl.tag}
                    </p>
                  </div>
                </CardShell>
              );
            })}
      </div>
    </div>
  );
}
