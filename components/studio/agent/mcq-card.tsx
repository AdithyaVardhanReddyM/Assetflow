"use client";

/**
 * The agent's clarifying questions, rendered as option chips — click one per
 * question and the answers go back as a single tool result. "Other" swaps to
 * an inline input. Once answered (or rehydrated as answered), the card
 * freezes with the chosen options inked.
 */

import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { AskUserInput } from "@/lib/studio/agent/spec";

const chip =
  "border border-[#1f211c]/14 bg-white px-2.5 py-1.5 text-left text-[12px] font-medium text-[#4c4a41] transition-colors hover:border-[#1f211c]/35 hover:text-[#1f211c]";

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

  const submitIfComplete = (next: Record<string, string>) => {
    setAnswers(next);
    if (input.questions.every((q) => (next[q.id] ?? "").trim())) onSubmit(next);
  };

  return (
    <div className="border border-[#1f211c]/10 bg-[#f7f4ee]/70 p-3">
      <div className="flex flex-col gap-3">
        {input.questions.map((q) => {
          const chosen = current[q.id];
          const isOther =
            others[q.id] || (done && chosen !== undefined && !q.options.includes(chosen));
          return (
            <div key={q.id}>
              <p className="text-[12.5px] leading-5 font-medium text-[#1f211c]">
                {q.question}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {q.options.map((option) => {
                  const active = chosen === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={done}
                      onClick={() => {
                        setOthers((o) => ({ ...o, [q.id]: false }));
                        submitIfComplete({ ...answers, [q.id]: option });
                      }}
                      className={cn(
                        chip,
                        active && "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee] hover:text-[#f7f4ee]",
                        done && !active && "opacity-50",
                      )}
                    >
                      {active ? <CheckIcon className="mr-1 inline size-3" weight="bold" /> : null}
                      {option}
                    </button>
                  );
                })}
                {q.allow_other !== false ? (
                  isOther ? (
                    done ? (
                      <span className={cn(chip, "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee]")}>
                        <CheckIcon className="mr-1 inline size-3" weight="bold" />
                        {chosen}
                      </span>
                    ) : (
                      <input
                        autoFocus
                        placeholder="Type your answer, press Enter"
                        className="min-w-40 border border-[#1f211c]/30 bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1f211c] outline-none placeholder:text-[#a09a88]"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const value = (e.target as HTMLInputElement).value.trim();
                          if (value) submitIfComplete({ ...answers, [q.id]: value });
                        }}
                      />
                    )
                  ) : (
                    <button
                      type="button"
                      disabled={done}
                      onClick={() => setOthers((o) => ({ ...o, [q.id]: true }))}
                      className={cn(chip, "text-[#8a8271]", done && "opacity-50")}
                    >
                      Other…
                    </button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
