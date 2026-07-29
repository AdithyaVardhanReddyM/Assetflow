"use client";

/**
 * The agent's clarifying questions — one card per question, stacked, in the
 * manner of a CLI questionnaire: a numbered header rail, the question, then
 * full-width option rows you pick from. "Other" is the last row and expands
 * into an inline input. The whole set submits itself the moment every
 * question holds an answer; afterwards the cards freeze with the chosen row
 * inked and the rest dimmed.
 */

import * as React from "react";
import { CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { AskUserInput } from "@/lib/studio/agent/spec";

function OptionRow({
  label,
  active,
  done,
  onPick,
  icon,
}: {
  label: React.ReactNode;
  active: boolean;
  done: boolean;
  onPick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={done}
      onClick={onPick}
      className={cn(
        "group flex w-full items-center gap-2.5 border px-2.5 py-2 text-left text-[12.5px] leading-5 font-medium transition-colors",
        active
          ? "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee]"
          : "border-transparent text-[#4c4a41] hover:border-[#1f211c]/20 hover:bg-[#f7f4ee]",
        done && !active && "opacity-40",
      )}
    >
      {/* Square selector — the checkbox glyph of a zero-radius system. */}
      <span
        aria-hidden
        className={cn(
          "grid size-3.5 shrink-0 place-items-center border transition-colors",
          active
            ? "border-[#f7f4ee]/60 bg-[#f7f4ee]/10"
            : "border-[#1f211c]/30 bg-white group-hover:border-[#1f211c]/50",
        )}
      >
        {active ? <CheckIcon className="size-2.5" weight="bold" /> : null}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {icon}
    </button>
  );
}

export function McqCard({
  input,
  answered,
  onSubmit,
}: {
  input: AskUserInput;
  /** The stored answers when this card was already completed; null if live. */
  answered: Record<string, string> | null;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [others, setOthers] = React.useState<Record<string, boolean>>({});
  const done = answered !== null;
  const current = answered ?? answers;
  const total = input.questions.length;

  const submitIfComplete = (next: Record<string, string>) => {
    setAnswers(next);
    if (input.questions.every((q) => (next[q.id] ?? "").trim())) onSubmit(next);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {input.questions.map((q, index) => {
        const chosen = current[q.id];
        const isOther =
          others[q.id] || (done && chosen !== undefined && !q.options.includes(chosen));
        const settled = Boolean((chosen ?? "").trim());

        return (
          <div
            key={q.id}
            className="border border-[#1f211c]/12 bg-white shadow-[0_14px_36px_-24px_rgba(31,33,28,0.45)]"
          >
            <div className="flex items-center gap-2 border-b border-[#1f211c]/8 bg-gradient-to-r from-primary/12 to-transparent px-3 py-1.5">
              <span className="grid size-4 shrink-0 place-items-center bg-primary text-[9.5px] font-bold text-primary-foreground">
                {index + 1}
              </span>
              <span className="text-[9.5px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
                Question {index + 1} of {total}
              </span>
              {settled ? (
                <CheckIcon className="ml-auto size-3.5 text-[#527d5a]" weight="bold" />
              ) : null}
            </div>

            <p className="px-3 pt-2.5 pb-1 text-[13px] leading-5 font-medium text-[#1f211c]">
              {q.question}
            </p>

            <div className="flex flex-col gap-0.5 p-1.5">
              {q.options.map((option) => (
                <OptionRow
                  key={option}
                  label={option}
                  active={chosen === option}
                  done={done}
                  onPick={() => {
                    setOthers((o) => ({ ...o, [q.id]: false }));
                    submitIfComplete({ ...answers, [q.id]: option });
                  }}
                />
              ))}

              {q.allow_other !== false ? (
                isOther && !done ? (
                  <div className="flex items-center gap-2.5 border border-[#1f211c]/30 bg-white px-2.5 py-1.5">
                    <PencilSimpleIcon className="size-3.5 shrink-0 text-[#8a8271]" />
                    <input
                      autoFocus
                      placeholder="Type your answer, press Enter"
                      className="w-full bg-transparent text-[12.5px] font-medium text-[#1f211c] outline-none placeholder:text-[#a09a88]"
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        const value = (e.target as HTMLInputElement).value.trim();
                        if (value) submitIfComplete({ ...answers, [q.id]: value });
                      }}
                    />
                  </div>
                ) : (
                  <OptionRow
                    label={
                      isOther ? (
                        chosen
                      ) : (
                        <span className="text-[#8a8271] group-hover:text-[#4c4a41]">
                          Other…
                        </span>
                      )
                    }
                    active={Boolean(isOther && done)}
                    done={done}
                    onPick={() => setOthers((o) => ({ ...o, [q.id]: true }))}
                    icon={
                      !isOther ? (
                        <PencilSimpleIcon className="size-3.5 shrink-0 text-[#8a8271]/70" />
                      ) : undefined
                    }
                  />
                )
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
