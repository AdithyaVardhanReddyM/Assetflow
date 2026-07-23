"use client";

/**
 * Shared node furniture: the card, the caption above it, the floating action
 * bar below it, and the generic parameter control.
 *
 * `ParamControl` is the reason the catalog carries UI hints (label, unit,
 * group, options) alongside types — one component renders every model's
 * parameters, so adding a provider is a YAML change rather than a new form.
 */

import * as React from "react";
import {
  CaretDownIcon,
  CheckIcon,
  DotsThreeIcon,
  MicrophoneIcon,
  SpeakerSimpleHighIcon,
  SpeakerSimpleSlashIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ParamDescriptor } from "@/lib/studio/catalog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Menus size to their content. The base popup used to pin its width to
 * `--anchor-width`, which for a 40px param chip clipped every option to a
 * sliver — hence `w-max` there and no `min-w-0` here.
 */
export const menuSurface =
  "border border-[#1f211c]/10 bg-white/97 p-1 shadow-[0_24px_60px_-16px_rgba(31,33,28,0.35)] ring-0 backdrop-blur-xl";

/** The white card. Zero radius throughout, per the studio's design language. */
export function NodeCard({
  selected,
  className,
  children,
  style,
}: {
  selected?: boolean;
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "relative border bg-white transition-shadow duration-150",
        selected
          ? "border-[#1f211c]/45 shadow-[0_22px_54px_-16px_rgba(31,33,28,0.4)]"
          : "border-[#1f211c]/10 shadow-[0_10px_30px_-14px_rgba(31,33,28,0.28)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The small row above the card: what this node is on the left, its model on the right. */
export function NodeHeader({
  icon: Icon,
  label,
  right,
}: {
  icon?: React.ComponentType<{ className?: string; weight?: never }>;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5 text-[11px] text-[#8a8271]">
      <span className="flex min-w-0 items-center gap-1.5">
        {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
        <span className="truncate font-medium">{label}</span>
      </span>
      {right ? <span className="shrink-0 truncate">{right}</span> : null}
    </div>
  );
}

/** An inline-editable caption, used where a node carries a user-given name. */
export function NodeCaption({
  value,
  placeholder,
  onChange,
  className,
  style,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  /** Layout only — callers that inline the caption override width and margin. */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      style={style}
      onChange={(e) => onChange(e.target.value)}
      // React Flow drags the node on pointerdown anywhere in it; `nodrag` opts
      // this element out so the caret can be placed by clicking.
      className={cn(
        "nodrag mb-1.5 w-full bg-transparent px-0.5 text-[11px] font-medium text-[#8a8271] outline-none placeholder:text-[#bdb7a7] hover:text-[#1f211c] focus:text-[#1f211c]",
        className,
      )}
    />
  );
}

/** The pill of actions that floats below a node. */
export function FloatingBar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "nodrag mt-2 flex items-center gap-1 border border-[#1f211c]/8 bg-white/92 px-1.5 py-1 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BarButton({
  label,
  icon: Icon,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; weight?: never }>;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "grid size-7 shrink-0 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c] disabled:pointer-events-none disabled:opacity-35",
              danger && "hover:bg-[#cf7c7c]/12 hover:text-[#a94848]",
            )}
          >
            <Icon className="size-4" />
          </button>
        }
      />
      <TooltipContent side="bottom" sideOffset={8} className="bg-[#1f211c] text-[#f7f4ee]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function BarDivider() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-[#1f211c]/10" />;
}

export const barChip =
  "flex h-7 shrink-0 items-center gap-1 px-1.5 text-[11px] font-medium text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]";

// --- parameters -----------------------------------------------------------

function paramLabel(param: ParamDescriptor): string {
  return param.label || param.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function formatValue(param: ParamDescriptor, value: unknown): string {
  // An unset param still runs at the catalog default, so show that rather than
  // a dash — a chip reading "—" claims the node has no aspect ratio when it does.
  const effective = value === undefined || value === null || value === "" ? param.default : value;
  if (effective === undefined || effective === null || effective === "") {
    // A numeric param with no default is genuinely unset until touched, and
    // its provider picks the value — "Auto" says that where "—" reads as broken.
    return param.type === "integer" || param.type === "number" ? "Auto" : "—";
  }
  if (param.type === "boolean") return effective ? "On" : "Off";
  const option = param.options?.find((o) => o.value === String(effective));
  const text = option?.label ?? String(effective);
  return param.unit ? `${text}${param.unit}` : text;
}

/**
 * Boolean params that mean "sound on/off" — they render as a speaker glyph
 * whose state is the icon itself, not a status dot. Kept as a name set so a
 * new provider's audio switch only has to reuse the name to pick this up.
 */
const AUDIO_PARAM_NAMES = new Set(["generate_audio"]);

/**
 * Renders any `ParamDescriptor` as a compact chip for the node's action bar.
 * Enum becomes a menu, number a slider, boolean a toggle, string an inline
 * field — driven entirely by the descriptor, never by the model's identity.
 */
export function ParamControl({
  param,
  value,
  onChange,
}: {
  param: ParamDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = paramLabel(param);
  // What the node would actually send: an untouched param runs at its default.
  const effective = value === undefined || value === null || value === "" ? param.default : value;

  if (param.type === "boolean") {
    const on = Boolean(effective);
    // Audio toggles read as a speaker rather than a status dot — the glyph
    // itself carries the state, muted-styled when off.
    const audio = AUDIO_PARAM_NAMES.has(param.name);
    const AudioIcon = on ? SpeakerSimpleHighIcon : SpeakerSimpleSlashIcon;
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        title={label}
        onClick={() => onChange(!on)}
        className={cn(
          barChip,
          on ? "bg-[#1f211c]/6 text-[#1f211c]" : audio && "text-[#a09a88]",
        )}
      >
        {/* An audio switch is the glyph alone: a speaker already says "audio",
            and the word beside it is the same fact twice. Every other boolean
            keeps its label, since nothing else names itself. `aria-label` and
            `title` above carry it for anyone the glyph does not reach. */}
        {audio ? (
          <AudioIcon className="size-3.5" weight="fill" />
        ) : (
          <>
            {label}
            <span
              className={cn(
                "size-1.5 rounded-full",
                on ? "bg-[#5d9468]" : "bg-[#1f211c]/20",
              )}
            />
          </>
        )}
      </button>
    );
  }

  if (param.type === "enum") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" className={barChip} title={label} aria-label={label}>
              {formatValue(param, value)}
              <CaretDownIcon className="size-3 text-[#a09a88]" />
            </button>
          }
        />
        <DropdownMenuContent align="start" side="bottom" sideOffset={8} className={menuSurface}>
          {(param.options ?? []).map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onChange(option.value)}
              className="px-2.5 py-1.5 text-xs font-medium text-[#1f211c] focus:bg-[#f7f4ee]"
            >
              {option.label ?? option.value}
              {String(effective) === option.value ? (
                <CheckIcon className="ml-auto size-3.5" weight="bold" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (param.type === "integer" || param.type === "number") {
    const min = param.min ?? 0;
    const max = param.max ?? 100;
    const step = param.step ?? (param.type === "integer" ? 1 : 0.5);
    const current = typeof effective === "number" ? effective : Number(effective ?? min);
    // The chip shows the raw effective (so an untouched optional param reads
    // "Auto"); the slider still opens at a concrete value.
    const chipValue = effective === undefined || effective === null || effective === "" ? null : current;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" className={barChip} title={label} aria-label={label}>
              {formatValue(param, chipValue)}
              <CaretDownIcon className="size-3 text-[#a09a88]" />
            </button>
          }
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={8}
          className={cn(menuSurface, "w-52 p-3")}
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-[#1f211c]">{label}</span>
            <span className="text-[11px] text-[#8a8271] tabular-nums">
              {formatValue(param, current)}
            </span>
          </div>
          <Slider
            min={min}
            max={max}
            step={step}
            value={[Number.isFinite(current) ? current : min]}
            onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
            aria-label={label}
            className="[&_[data-slot=slider-thumb]]:border-[#1f211c]/45 [&_[data-slot=slider-track]]:bg-[#1f211c]/15"
          />
          {param.help ? (
            <p className="mt-2 text-[11px] leading-4 text-[#a09a88]">{param.help}</p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // string
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={barChip} title={label} aria-label={label}>
            <span className="max-w-24 truncate">{formatValue(param, effective)}</span>
            <CaretDownIcon className="size-3 text-[#a09a88]" />
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        className={cn(menuSurface, "w-60 p-3")}
      >
        <label className="mb-1.5 block text-[11px] font-semibold text-[#1f211c]">
          {label}
          {param.required ? <span className="ml-1 text-[#a94848]">required</span> : null}
        </label>
        <input
          value={typeof value === "string" ? value : ""}
          maxLength={param.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-[#1f211c]/14 bg-[#f7f4ee]/70 px-2 py-1.5 text-xs text-[#1f211c] outline-none focus:border-[#1f211c]/35"
        />
        {param.help ? (
          <p className="mt-2 text-[11px] leading-4 text-[#a09a88]">{param.help}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- body controls --------------------------------------------------------

function boolOn(param: ParamDescriptor, value: unknown): boolean {
  // Nullish, not falsy: a `false` value must not fall through to the default.
  return value === undefined || value === null ? Boolean(param.default) : Boolean(value);
}

/** An enum body param as a full-width select row (the voice picker). */
function EnumRow({
  param,
  value,
  onChange,
}: {
  param: ParamDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const effective = value === undefined || value === null || value === "" ? param.default : value;
  const current = param.options?.find((o) => o.value === String(effective));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="nodrag flex w-full items-center gap-2 border border-[#1f211c]/14 bg-[#f7f4ee]/60 px-2.5 py-2 text-left text-[12.5px] text-[#1f211c] transition-colors hover:border-[#1f211c]/30"
            title={paramLabel(param)}
          >
            <MicrophoneIcon className="size-3.5 shrink-0 text-[#8a8271]" weight="fill" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {current?.label ?? current?.value ?? "Select…"}
            </span>
            <CaretDownIcon className="size-3 shrink-0 text-[#a09a88]" />
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        className={cn(menuSurface, "max-h-72 w-[--anchor-width] overflow-y-auto")}
      >
        {(param.options ?? []).map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className="px-2.5 py-1.5 text-xs font-medium text-[#1f211c] focus:bg-[#f7f4ee]"
          >
            {option.label ?? option.value}
            {String(effective) === option.value ? (
              <CheckIcon className="ml-auto size-3.5" weight="bold" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The `group: "body"` params — full-width controls too central to shrink into
 * a bar chip. A multiline string becomes a labelled text box; a boolean beside
 * it becomes that box's enable toggle (Vocals over the Lyrics box); an enum
 * becomes a select row (the voice picker). Placement is entirely catalog-driven
 * — nothing here is keyed to a model's identity.
 */
export function NodeBodyControls({
  params,
  values,
  onChange,
}: {
  params: ParamDescriptor[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const textParam = params.find((p) => p.type === "string" && p.multiline);
  // A boolean sitting with a text box is that box's enable switch.
  const toggleParam = textParam ? params.find((p) => p.type === "boolean") : undefined;
  const enumParams = params.filter((p) => p.type === "enum");
  const looseBooleans = params.filter(
    (p) => p.type === "boolean" && p.name !== toggleParam?.name,
  );

  const enabled = toggleParam ? boolOn(toggleParam, values[toggleParam.name]) : true;

  return (
    <div className="flex flex-col gap-2.5">
      {enumParams.map((param) => (
        <EnumRow
          key={param.name}
          param={param}
          value={values[param.name]}
          onChange={(v) => onChange(param.name, v)}
        />
      ))}

      {textParam ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[#8a8271]">
              {paramLabel(textParam)}
            </span>
            {toggleParam ? (
              <Switch
                size="sm"
                checked={enabled}
                onCheckedChange={(v: boolean) => onChange(toggleParam.name, v)}
                aria-label={paramLabel(toggleParam)}
                className="data-checked:bg-[#1f211c]"
              />
            ) : null}
          </div>
          <textarea
            rows={2}
            value={typeof values[textParam.name] === "string" ? (values[textParam.name] as string) : ""}
            disabled={!enabled}
            maxLength={textParam.max_length ?? undefined}
            onChange={(e) => onChange(textParam.name, e.target.value || null)}
            placeholder={
              enabled
                ? (textParam.help ?? `Add ${paramLabel(textParam).toLowerCase()}…`)
                : "Instrumental — no lyrics"
            }
            className="nodrag nowheel thin-scrollbar max-h-28 min-h-7 w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88] disabled:text-[#c8c2b3]"
          />
        </div>
      ) : null}

      {looseBooleans.map((param) => (
        <div key={param.name} className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[#8a8271]">{paramLabel(param)}</span>
          <Switch
            size="sm"
            checked={boolOn(param, values[param.name])}
            onCheckedChange={(v: boolean) => onChange(param.name, v)}
            aria-label={paramLabel(param)}
            className="data-checked:bg-[#1f211c]"
          />
        </div>
      ))}
    </div>
  );
}

/** The overflow menu shared by every node's action bar. */
export function MoreMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More actions"
            className="grid size-7 shrink-0 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </button>
        }
      />
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className={cn(menuSurface, "w-44 p-1.5")}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const menuItem =
  "gap-2 px-2.5 py-1.5 text-xs font-medium text-[#1f211c] focus:bg-[#f7f4ee]";
