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
  TimerIcon,
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
import { ImageGenIcon, VideoGenIcon } from "./asset-icons";
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

type PromptModality = "image" | "video";

/** What Generate hands the canvas: the node to place, fully decided. */
export type PromptSpec = {
  modality: PromptModality;
  model?: CatalogModel;
  params?: Record<string, unknown>;
};

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
              title={p.label ?? p.name}
              onClick={() => onChange(p.name, !on)}
              className={cn(
                chip,
                on ? "border-[#1f211c]/30 bg-[#1f211c]/5 text-[#1f211c]" : "text-[#8a8271]",
              )}
            >
              {audio ? <AudioIcon className="size-3.5" weight="fill" /> : null}
              {p.label ?? p.name}
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
}: {
  catalog: Catalog;
  value: string;
  onChange: (v: string) => void;
  onGenerate: (spec: PromptSpec) => void;
  onAttach: () => void;
  /**
   * On the home screen, Generate creates a workflow before it can place a
   * node — so the wait belongs on the button that started it.
   */
  busy?: boolean;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [modality, setModality] = React.useState<PromptModality>("image");

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

  const isVideo = modality === "video";
  // Guarded here rather than only on the button, because Enter in the textarea
  // reaches this without going through it.
  const generate = () => {
    if (busy) return;
    onGenerate({ modality, model, params: model ? params[modality] : undefined });
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
      className="beam-colour-only w-full"
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
            onClick={onAttach}
            className="mt-0.5 grid size-8 shrink-0 place-items-center border border-[#1f211c]/12 text-[#4c4a41] transition-colors hover:border-[#1f211c]/30 hover:bg-[#f7f4ee] hover:text-[#1f211c]"
          >
            <PlusIcon className="size-4" />
          </button>
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

        <div className="mt-3 flex items-center gap-1.5">
          {/* Options wrap instead of pushing Generate past the bar's edge */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {/* Modality toggle — sliding ink block */}
          <div className="relative flex h-8 shrink-0 border border-[#1f211c]/14 bg-[#f7f4ee]/80 p-0.5">
            <span
              aria-hidden
              className={cn(
                "absolute top-0.5 bottom-0.5 left-0.5 w-[66px] bg-[#1f211c] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                isVideo && "translate-x-[66px]",
              )}
            />
            {(
              [
                { id: "image", label: "Image", icon: ImageGenIcon },
                { id: "video", label: "Video", icon: VideoGenIcon },
              ] as const
            ).map(({ id, label, icon: IconComp }) => (
              <button
                key={id}
                type="button"
                aria-pressed={modality === id}
                onClick={() => setModality(id)}
                className={cn(
                  "relative z-10 flex w-[66px] items-center justify-center gap-1.5 text-xs font-semibold transition-colors duration-300",
                  modality === id
                    ? "text-[#f7f4ee]"
                    : "text-[#8a8271] hover:text-[#1f211c]",
                )}
              >
                <IconComp className="size-3.5" weight={modality === id ? "fill" : "regular"} />
                {label}
              </button>
            ))}
          </div>

          {/* Model picker for the active modality */}
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

          {model ? (
            <ParamChips
              model={model}
              params={params[modality]}
              onChange={setParam}
            />
          ) : null}
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={busy}
            aria-busy={busy || undefined}
            className="flex h-9 shrink-0 items-center gap-2 bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_24px_-8px_oklch(0.75_0.16_85_/_0.9),inset_0_1px_0_rgba(255,255,255,0.5)] transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:active:scale-100 disabled:hover:brightness-100"
          >
            {busy ? (
              <>
                <Spinner className="size-4" />
                Creating workflow…
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
