"use client";

/**
 * The searchable body of a model-picker menu — shared by the generate node's
 * bar and the prompt bar so the two pickers cannot drift apart. The menu
 * *content* only: each caller keeps its own trigger chip and DropdownMenu
 * shell, which differ by surface.
 */

import * as React from "react";
import { CheckIcon, MagnifyingGlassIcon, WarningIcon } from "@phosphor-icons/react";

import type { CatalogModel } from "@/lib/studio/catalog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ModelLogo } from "./model-logos";

export function ModelMenuList({
  models,
  selected,
  onSelect,
  emptyLabel = "No models in the catalog yet.",
}: {
  models: CatalogModel[];
  selected?: { provider: string; id: string };
  onSelect: (model: CatalogModel) => void;
  emptyLabel?: string;
}) {
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? models.filter((m) =>
        `${m.label} ${m.provider_label} ${m.id}`.toLowerCase().includes(q),
      )
    : models;

  return (
    <>
      <div className="mb-1 flex items-center gap-1.5 border-b border-[#1f211c]/8 px-2.5 pt-1 pb-1.5">
        <MagnifyingGlassIcon className="size-3.5 shrink-0 text-[#a09a88]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          aria-label="Search models"
          // The menu's typeahead listens at the popup; without this, typing
          // jumps the highlight around instead of filling the box. Escape
          // still bubbles so the menu closes.
          onKeyDown={(e) => {
            if (e.key !== "Escape") e.stopPropagation();
          }}
          className="h-6 w-full bg-transparent text-[12px] text-[#1f211c] outline-none placeholder:text-[#a09a88]"
        />
      </div>

      {shown.length ? (
        shown.map((m) => (
          <DropdownMenuItem
            key={`${m.provider}/${m.id}`}
            onClick={() => onSelect(m)}
            className="px-2.5 py-2 focus:bg-[#f7f4ee]"
          >
            <ModelLogo provider={m.provider} modelId={m.id} label={m.label} />
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1f211c]">
                {m.label}
                {m.status !== "ready" ? (
                  <WarningIcon className="size-3 text-[#a9743f]" weight="fill" />
                ) : null}
              </span>
              <span className="truncate text-[11px] text-[#8a8271]">
                {m.provider_label}
              </span>
            </span>
            {selected && m.id === selected.id && m.provider === selected.provider ? (
              <CheckIcon className="ml-auto size-3.5 text-[#1f211c]" weight="bold" />
            ) : null}
          </DropdownMenuItem>
        ))
      ) : (
        <p className="px-2.5 py-2 text-[11px] leading-4 text-[#a09a88]">
          {q ? "No models match." : emptyLabel}
        </p>
      )}
    </>
  );
}
