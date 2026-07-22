"use client";

import * as React from "react";
import {
  CaretDownIcon,
  CheckIcon,
  FrameCornersIcon,
  GaugeIcon,
  ImagesIcon,
  PlusIcon,
  SparkleIcon,
  TimerIcon,
} from "@phosphor-icons/react";

import { BorderBeam } from "border-beam";

import { cn } from "@/lib/utils";
import { ImageGenIcon, VideoGenIcon } from "./asset-icons";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Modality = "image" | "video";

const MODELS: Record<Modality, { name: string; hint: string }[]> = {
  image: [
    { name: "Nano Banana Pro", hint: "Google's flagship generation model" },
    { name: "GPT Image 2", hint: "Near-perfect text rendering" },
    { name: "Seedream 5.0 Pro", hint: "Intelligent visual reasoning" },
    { name: "Recraft V4.1", hint: "Photorealistic and expressive" },
    { name: "FLUX.2 [pro]", hint: "Sharp detail, fast iterations" },
  ],
  video: [
    { name: "Veo 3.1", hint: "Cinematic motion with audio" },
    { name: "Kling 2.6 Pro", hint: "Fluid, physical motion" },
    { name: "Runway Gen-4", hint: "Consistent characters and scenes" },
    { name: "Wan 2.5", hint: "Open weights, strong stylization" },
  ],
};

const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const VIDEO_RATIOS = ["Auto", "16:9", "9:16", "4:3", "3:4", "1:1"];
const QUALITIES = ["1K", "2K", "4K"];

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
  options: string[];
  value: string;
  onSelect: (v: string) => void;
  icon?: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={chip} aria-label={`${label}: ${value}`}>
            {icon}
            {value}
            <CaretDownIcon className="size-3 text-[#8a8271]" />
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className={cn(menuSurface, "w-28")}
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            onClick={() => onSelect(option)}
            className="px-2.5 py-1.5 text-xs font-medium text-[#1f211c] focus:bg-[#f7f4ee]"
          >
            {option}
            {value === option ? (
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
  value,
  onChange,
  format,
  valueWidth = "w-6",
}: {
  label: string;
  icon: React.ReactNode;
  min: number;
  max: number;
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
          step={1}
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

export function PromptBar({
  value,
  onChange,
  onGenerate,
  onAttach,
}: {
  value: string;
  onChange: (v: string) => void;
  onGenerate: () => void;
  onAttach: () => void;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [modality, setModality] = React.useState<Modality>("image");
  const [model, setModel] = React.useState<Record<Modality, string>>({
    image: "Nano Banana Pro",
    video: "Veo 3.1",
  });
  const [imageRatio, setImageRatio] = React.useState("3:4");
  const [videoRatio, setVideoRatio] = React.useState("Auto");
  const [quality, setQuality] = React.useState("1K");
  const [count, setCount] = React.useState(1);
  const [duration, setDuration] = React.useState(5);
  const [highBitrate, setHighBitrate] = React.useState(false);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    if (value) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const isVideo = modality === "video";

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
                onGenerate();
              }
            }}
            placeholder="Describe the scene you imagine…"
            className="max-h-50 min-h-20 flex-1 resize-none bg-transparent pt-1 text-[15px] leading-6 text-[#1f211c] outline-none placeholder:text-[#a09a88]"
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
                  <span className="grid size-4.5 shrink-0 place-items-center bg-[#1f211c] text-[9px] font-bold text-[#f7f4ee]">
                    {model[modality].charAt(0)}
                  </span>
                  <span className="max-w-28 truncate font-semibold text-[#1f211c]">
                    {model[modality]}
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
              {MODELS[modality].map((m) => (
                <DropdownMenuItem
                  key={m.name}
                  onClick={() => setModel({ ...model, [modality]: m.name })}
                  className="px-2.5 py-2 focus:bg-[#f7f4ee]"
                >
                  <span className="grid size-6 shrink-0 place-items-center bg-[#1f211c]/6 text-[10px] font-bold text-[#1f211c]">
                    {m.name.charAt(0)}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] font-semibold text-[#1f211c]">
                      {m.name}
                    </span>
                    <span className="truncate text-[11px] text-[#8a8271]">
                      {m.hint}
                    </span>
                  </span>
                  {model[modality] === m.name ? (
                    <CheckIcon className="ml-auto size-3.5 text-[#1f211c]" weight="bold" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {isVideo ? (
            <>
              <OptionMenu
                label="Aspect ratio"
                options={VIDEO_RATIOS}
                value={videoRatio}
                onSelect={setVideoRatio}
                icon={<FrameCornersIcon className="size-3.5" />}
              />
              <SliderChip
                label="Duration"
                icon={<TimerIcon className="size-3.5 text-[#8a8271]" />}
                min={1}
                max={15}
                value={duration}
                onChange={setDuration}
                format={(v) => `${v}s`}
              />
              <button
                type="button"
                className={cn(
                  chip,
                  "max-[620px]:hidden",
                  highBitrate && "border-[#1f211c]/30 bg-[#1f211c]/5 text-[#1f211c]",
                )}
                aria-pressed={highBitrate}
                onClick={() => setHighBitrate(!highBitrate)}
                title="Toggle bitrate"
              >
                <GaugeIcon className="size-3.5" />
                {highBitrate ? "High bitrate" : "Standard"}
              </button>
            </>
          ) : (
            <>
              <OptionMenu
                label="Aspect ratio"
                options={IMAGE_RATIOS}
                value={imageRatio}
                onSelect={setImageRatio}
                icon={<FrameCornersIcon className="size-3.5" />}
              />
              <OptionMenu
                label="Quality"
                options={QUALITIES}
                value={quality}
                onSelect={setQuality}
              />
              <SliderChip
                label="Number of outputs"
                icon={<ImagesIcon className="size-3.5 text-[#8a8271]" />}
                min={1}
                max={4}
                value={count}
                onChange={setCount}
                format={(v) => `${v}`}
                valueWidth="w-2"
              />
            </>
          )}
          </div>

          <button
            type="button"
            onClick={onGenerate}
            className="flex h-9 shrink-0 items-center gap-2 bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_24px_-8px_oklch(0.75_0.16_85_/_0.9),inset_0_1px_0_rgba(255,255,255,0.5)] transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97]"
          >
            <SparkleIcon weight="fill" className="size-4" />
            Generate
          </button>
        </div>
      </div>
    </BorderBeam>
  );
}
