"use client";

/**
 * The prompt bar — the home-screen fast path to a generate node.
 *
 * Models and options come from the catalog, exactly like the node bar: the
 * model list is `modelsForModality` (role-less models only — lipsync has no
 * business here), and the option chips render the selected model's *basic*
 * params, seeded from catalog defaults. Generate hands the selection to the
 * canvas, which places a node carrying that model and those params — so what
 * the bar promises is what the node runs.
 */

import * as React from "react";
import {
  CaretDownIcon,
  CheckIcon,
  FrameCornersIcon,
  PlusIcon,
  SparkleIcon,
  SpeakerSimpleHighIcon,
  SpeakerSimpleSlashIcon,
  StackIcon,
  TimerIcon,
  XIcon,
} from "@phosphor-icons/react";

import { BorderBeam } from "border-beam";

import { cn } from "@/lib/utils";
import {
  type Catalog,
  type CatalogModel,
  type ParamDescriptor,
  defaultParams,
  modelsForModality,
  remapParams,
} from "@/lib/studio/catalog";
import { NODE_BLUEPRINTS, pickModel } from "@/lib/studio/node-ui";
import { AgentIcon, ImageGenIcon, VideoGenIcon } from "./asset-icons";
import { ModelLogo } from "./model-logos";
import { ModelMenuList } from "./model-menu";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type PromptModality = "image" | "video";

/**
 * What the toggle offers. Agent is a third tab, not a third modality — it
 * starts a conversation instead of placing a node, so `modality` stays parked
 * on the last real one while `tab` says what Generate actually means.
 */
export type PromptTab = PromptModality | "agent";

const PROMPT_TABS: { id: PromptTab; label: string; icon: typeof ImageGenIcon }[] = [
  { id: "image", label: "Image", icon: ImageGenIcon },
  { id: "video", label: "Video", icon: VideoGenIcon },
  { id: "agent", label: "Agent", icon: AgentIcon },
];

/** Width of one tab, and so the distance the block slides per step. */
const TAB_WIDTH = 66;

/** What Generate hands the canvas: the node to place, fully decided. */
export type PromptSpec = {
  /** Which tab fired: image/video place a chain, agent opens a conversation. */
  tab: PromptTab;
  modality: PromptModality;
  model?: CatalogModel;
  params?: Record<string, unknown>;
  /** Image tab only: how many generate nodes the quick chain fans out to. */
  count?: number;
};

/** A file staged on the bar — owned by the parent, displayed here. */
export type PromptAttachment = {
  name: string;
  /** Object URL for an image thumbnail; absent renders a plain chip. */
  previewUrl?: string | null;
};

/** The Generate button's states — home creates, quick modes craft. */
export type PromptBusy = boolean | "creating" | "crafting";

const chip =
  "flex h-8 shrink-0 items-center gap-1.5 border border-[#1f211c]/14 bg-[#f7f4ee]/80 px-2 text-xs font-medium text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]";

const menuSurface =
  "min-w-0 border border-[#1f211c]/10 bg-white/97 p-1 shadow-[0_24px_60px_-16px_rgba(31,33,28,0.35)] ring-0 backdrop-blur-xl";

function OptionMenu({
  label,
  options,
  value,
  onSelect,
  icon,
}: {
  label: string;
  options: { value: string; label?: string }[];
  value: string;
  onSelect: (v: string) => void;
  icon?: React.ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={chip} aria-label={`${label}: ${value}`}>
            {icon}
            {current?.label ?? value}
            <CaretDownIcon className="size-3 text-[#8a8271]" />
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className={cn(menuSurface, "w-max")}
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className="px-2.5 py-1.5 text-xs font-medium text-[#1f211c] focus:bg-[#f7f4ee]"
          >
            {option.label ?? option.value}
            {value === option.value ? (
              <CheckIcon className="ml-auto size-3.5" weight="bold" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SliderChip({
  label,
  icon,
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  valueWidth = "w-6",
}: {
  label: string;
  icon: React.ReactNode;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  /** Reserve just enough room for the widest formatted value, no more. */
  valueWidth?: string;
}) {
  return (
    <div className={cn(chip, "gap-2")} aria-label={label} title={label}>
      {icon}
      <div className="w-14">
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
          aria-label={label}
          // --muted is near-white and vanishes on the cream chip; ink the track.
          className="[&_[data-slot=slider-thumb]]:size-2.5 [&_[data-slot=slider-thumb]]:border-[#1f211c]/45 [&_[data-slot=slider-track]]:bg-[#1f211c]/15"
        />
      </div>
      <span
        className={cn(
          "text-right font-semibold text-[#1f211c] tabular-nums",
          valueWidth,
        )}
      >
        {format(value)}
      </span>
    </div>
  );
}

/**
 * One chip per basic param of the selected model. Enums become menus, numbers
 * become sliders, booleans become toggle chips — audio switches render as a
 * speaker whose glyph carries the state, same as the node bar.
 */
const AUDIO_PARAM_NAMES = new Set(["generate_audio"]);

function ParamChips({
  model,
  params,
  onChange,
}: {
  model: CatalogModel;
  params: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const basic = model.params.filter((p) => (p.group ?? "basic") === "basic");

  const chipIcon = (p: ParamDescriptor) =>
    p.name === "aspect_ratio" ? (
      <FrameCornersIcon className="size-3.5" />
    ) : p.unit === "s" ? (
      <TimerIcon className="size-3.5 text-[#8a8271]" />
    ) : undefined;

  return (
    <>
      {basic.map((p) => {
        const value = params[p.name] ?? p.default;
        if (p.type === "enum") {
          return (
            <OptionMenu
              key={p.name}
              label={p.label ?? p.name}
              options={p.options ?? []}
              value={String(value ?? "")}
              onSelect={(v) => onChange(p.name, v)}
              icon={chipIcon(p)}
            />
          );
        }
        if (p.type === "integer" || p.type === "number") {
          const num = Number(value);
          return (
            <SliderChip
              key={p.name}
              label={p.label ?? p.name}
              icon={chipIcon(p)}
              min={p.min ?? 0}
              max={p.max ?? 100}
              step={p.step ?? 1}
              value={Number.isFinite(num) ? num : (p.min ?? 0)}
              onChange={(v) => onChange(p.name, p.type === "integer" ? Math.round(v) : v)}
              format={(v) => (p.unit ? `${v}${p.unit}` : `${v}`)}
            />
          );
        }
        if (p.type === "boolean") {
          const on = Boolean(value);
          const audio = AUDIO_PARAM_NAMES.has(p.name);
          const AudioIcon = on ? SpeakerSimpleHighIcon : SpeakerSimpleSlashIcon;
          return (
            <button
              key={p.name}
              type="button"
              aria-pressed={on}
              aria-label={p.label ?? p.name}
              title={p.label ?? p.name}
              onClick={() => onChange(p.name, !on)}
              className={cn(
                chip,
                on ? "border-[#1f211c]/30 bg-[#1f211c]/5 text-[#1f211c]" : "text-[#8a8271]",
              )}
            >
              {/* Glyph only — same rule as the node's action bar: the speaker
                  already says "audio", so the word is the fact twice. */}
              {audio ? (
                <AudioIcon className="size-3.5" weight="fill" />
              ) : (
                (p.label ?? p.name)
              )}
            </button>
          );
        }
        return null;
      })}
    </>
  );
}

export function PromptBar({
  catalog,
  value,
  onChange,
  onGenerate,
  onAttach,
  busy = false,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
}: {
  catalog: Catalog;
  value: string;
  onChange: (v: string) => void;
  onGenerate: (spec: PromptSpec) => void;
  onAttach: () => void;
  /**
   * On the home screen, Generate creates a workflow before it can place a
   * node — so the wait belongs on the button that started it. "crafting" is
   * the quick modes' LLM rewrite; plain `true` reads as "creating".
   */
  busy?: PromptBusy;
  /** Files staged for the next Generate, owned by the parent. When these three
   *  props are present the `+` button stages files here (agent always; quick
   *  modes only when the selected model has a reference-image port) instead of
   *  falling back to `onAttach`'s upload-node behavior. */
  attachments?: PromptAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = React.useState<PromptTab>("image");
  /**
   * The generating half of the toggle. Agent parks on the last real modality
   * rather than clearing it, so switching away and back finds the model and
   * params still where they were left.
   */
  const [modality, setModality] = React.useState<PromptModality>("image");
  /** Quick image mode's fan-out — a placement count, never a model param. */
  const [count, setCount] = React.useState(1);
  const fileInput = React.useRef<HTMLInputElement>(null);

  // Role-less models only: the bar's two tabs mean plain image / plain video
  // generation, and a lipsync model placed from here could never run.
  const models = React.useMemo(
    () => ({
      image: modelsForModality(catalog, "image").filter((m) => !m.role),
      video: modelsForModality(catalog, "video").filter((m) => !m.role),
    }),
    [catalog],
  );

  // Seeded from the same blueprints the toolbar uses, so the bar and the
  // Image/Video tools agree on what a fresh node runs.
  const [selected, setSelected] = React.useState<
    Record<PromptModality, CatalogModel | undefined>
  >(() => ({
    image: pickModel(catalog, NODE_BLUEPRINTS.image),
    video: pickModel(catalog, NODE_BLUEPRINTS.video),
  }));
  const [params, setParams] = React.useState<
    Record<PromptModality, Record<string, unknown>>
  >(() => ({
    image: selected.image ? defaultParams(selected.image) : {},
    video: selected.video ? defaultParams(selected.video) : {},
  }));

  const model = selected[modality];

  function selectModel(next: CatalogModel) {
    setSelected((s) => ({ ...s, [modality]: next }));
    // Same carry-over rule as the node bar: keep values the new model also
    // accepts, reseed the rest from its defaults.
    setParams((p) => ({ ...p, [modality]: remapParams(p[modality], next) }));
  }

  function setParam(name: string, v: unknown) {
    setParams((p) => ({ ...p, [modality]: { ...p[modality], [name]: v } }));
  }

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    if (value) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const isVideo = tab === "video";
  const isAgent = tab === "agent";

  /**
   * Whether the `+` button stages files on the bar rather than seeding an
   * upload node: always in agent mode (the conversation carries them), and in
   * the quick modes only when the chosen model can actually take a reference.
   */
  const canStageFiles =
    Boolean(onAttachFiles) &&
    (isAgent || Boolean(model?.accepts.some((a) => a.port === "image_ref")));

  // Guarded here rather than only on the button, because Enter in the textarea
  // reaches this without going through it.
  const generate = () => {
    if (busy) return;
    onGenerate({
      tab,
      modality,
      model: isAgent ? undefined : model,
      params: !isAgent && model ? params[modality] : undefined,
      count: tab === "image" ? count : undefined,
    });
  };

  return (
    <BorderBeam
      size="md"
      // The palette comes from `.beam-colour-only` in globals.css — see there
      // for why. `colorVariant` only still feeds the (disabled) bloom layer.
      colorVariant="sunset"
      theme="light"
      borderRadius={0}
      // Near-neutral: the gradients are already the brand amber, so this only
      // has to add the shimmer, not rescue a muted palette.
      brightness={1.05}
      saturation={1.15}
      hueRange={10}
      // The beam's hue-shift cycle is hardcoded to 12s, so a spin duration that
      // doesn't divide it evenly makes every lap land on a different colour —
      // that's the drift. 4s = exactly three laps per hue cycle.
      duration={4}
      // Video carries two controls image does not (duration, resolution), which
      // is exactly enough to wrap the chip row onto a second line at the image
      // width. The bar grows to hold them instead, animated so the toggle and
      // the bar read as one movement rather than a snap.
      className={cn(
        "beam-colour-only mx-auto w-full transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        isVideo ? "max-w-[940px]" : "max-w-[760px]",
      )}
      style={
        {
          // The light preset's opacities (stroke 0.12, inner 0.26) are tuned to
          // sit under a mono core that no longer exists; open them right up.
          "--beam-stroke-opacity": 8.4,
          "--beam-inner-opacity": 3.4,
          // The bloom layer is monochrome-only in the rotate presets — on the
          // light theme it's pure black, so it adds haze and no colour.
          "--beam-bloom-opacity": 0,
        } as React.CSSProperties
      }
    >
      <div
        className={cn(
          "w-full border border-[#1f211c]/8 bg-white/94 p-4 backdrop-blur-xl transition-shadow duration-300",
          "shadow-[0_28px_80px_-20px_rgba(31,33,28,0.38),0_2px_8px_rgba(31,33,28,0.05)]",
          "focus-within:border-[#1f211c]/18 focus-within:shadow-[0_28px_90px_-16px_rgba(31,33,28,0.45)]",
        )}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label="Add media"
            onClick={() => (canStageFiles ? fileInput.current?.click() : onAttach())}
            className="mt-0.5 grid size-8 shrink-0 place-items-center border border-[#1f211c]/12 text-[#4c4a41] transition-colors hover:border-[#1f211c]/30 hover:bg-[#f7f4ee] hover:text-[#1f211c]"
          >
            <PlusIcon className="size-4" />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) onAttachFiles?.(files);
            }}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                generate();
              }
            }}
            placeholder="Describe the scene you imagine…"
            className="thin-scrollbar max-h-50 min-h-20 flex-1 resize-none overflow-y-auto bg-transparent pt-1 text-[15px] leading-6 text-[#1f211c] outline-none placeholder:text-[#a09a88]"
          />
        </div>

        {attachments?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {attachments.map((a, index) => (
              <span
                key={`${a.name}-${index}`}
                className="flex items-center gap-1.5 border border-[#1f211c]/14 bg-[#f7f4ee]/80 py-1 pr-1.5 pl-1 text-[11px] font-medium text-[#4c4a41]"
              >
                {a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.previewUrl} alt="" className="size-6 object-cover" />
                ) : null}
                <span className="max-w-36 truncate">{a.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => onRemoveAttachment?.(index)}
                  className="text-[#8a8271] hover:text-[#1f211c]"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex items-center gap-1.5">
          {/* Options wrap instead of pushing Generate past the bar's edge */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {/* Modality toggle — sliding block in primary, carrying the same
              amber-on-dark-amber pairing Generate uses at the other end of the
              bar. One brand colour across the row, no neutral block. */}
          <div className="relative flex h-8 shrink-0 border border-[#1f211c]/14 bg-[#f7f4ee]/80 p-0.5">
            <span
              aria-hidden
              className="absolute top-0.5 bottom-0.5 left-0.5 bg-primary transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
              style={{
                width: TAB_WIDTH,
                transform: `translateX(${PROMPT_TABS.findIndex((t) => t.id === tab) * TAB_WIDTH}px)`,
              }}
            />
            {PROMPT_TABS.map(({ id, label, icon: IconComp }) => (
              <button
                key={id}
                type="button"
                aria-pressed={tab === id}
                onClick={() => {
                  setTab(id);
                  if (id !== "agent") setModality(id);
                }}
                style={{ width: TAB_WIDTH }}
                className={cn(
                  "relative z-10 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors duration-300",
                  tab === id
                    ? "text-primary-foreground"
                    : "text-[#8a8271] hover:text-[#1f211c]",
                )}
              >
                <IconComp className="size-3.5" weight={tab === id ? "fill" : "regular"} />
                {label}
              </button>
            ))}
          </div>

          {/* Model picker for the active modality. Agent has no catalog behind
              it yet, so the row stays empty rather than offering a choice that
              wouldn't run. */}
          {!isAgent && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={cn(chip, "min-w-0")}>
                  {model ? (
                    <ModelLogo
                      provider={model.provider}
                      modelId={model.id}
                      label={model.label}
                      size="sm"
                    />
                  ) : null}
                  <span className="max-w-32 truncate font-semibold text-[#1f211c]">
                    {model?.label ?? "Pick a model"}
                  </span>
                  <CaretDownIcon className="size-3 shrink-0 text-[#8a8271]" />
                </button>
              }
            />
            <DropdownMenuContent
              align="start"
              side="top"
              sideOffset={10}
              className={cn(menuSurface, "w-72 p-1.5")}
            >
              <ModelMenuList
                models={models[modality]}
                selected={model ? { provider: model.provider, id: model.id } : undefined}
                onSelect={selectModel}
                emptyLabel={`No ${modality} models in the catalog yet.`}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          {model && !isAgent ? (
            <ParamChips
              model={model}
              params={params[modality]}
              onChange={setParam}
            />
          ) : null}

          {/* Fan-out for the quick image chain — placement count, not a model
              param, so it lives beside the chips rather than among them. */}
          {tab === "image" && model ? (
            <OptionMenu
              label="Images"
              options={[1, 2, 3, 4].map((n) => ({
                value: String(n),
                label: `×${n}`,
              }))}
              value={String(count)}
              onSelect={(v) => setCount(Number(v))}
              icon={<StackIcon className="size-3.5" />}
            />
          ) : null}
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={Boolean(busy)}
            aria-busy={Boolean(busy) || undefined}
            className="flex h-9 shrink-0 items-center gap-2 bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_24px_-8px_oklch(0.75_0.16_85_/_0.9),inset_0_1px_0_rgba(255,255,255,0.5)] transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:active:scale-100 disabled:hover:brightness-100"
          >
            {busy ? (
              <>
                <Spinner className="size-4" />
                {busy === "crafting" ? "Crafting…" : "Creating workflow…"}
              </>
            ) : (
              <>
                <SparkleIcon weight="fill" className="size-4" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>
    </BorderBeam>
  );
}
