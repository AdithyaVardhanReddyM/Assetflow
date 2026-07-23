"use client";

/**
 * Presentation for a model's `role` — what it is *for*, when modality is too
 * coarse to tell nodes apart. Music, text-to-speech and sound effects are all
 * `audio` and would otherwise render identically.
 *
 * Shared between the node body and the port rail so a node and the connector it
 * emits from never disagree about what they are.
 */

import {
  SpeakerHifiIcon,
  UserSoundIcon,
} from "@phosphor-icons/react";

import { LlmIcon, MusicGenIcon, TextToSpeechIcon } from "../asset-icons";

export type RoleIcon = React.ComponentType<{ className?: string }>;

export const ROLE_ICON: Record<string, RoleIcon> = {
  music: MusicGenIcon,
  speech: TextToSpeechIcon,
  sfx: SpeakerHifiIcon,
  lipsync: UserSoundIcon,
  llm: LlmIcon,
};

export const ROLE_LABEL: Record<string, string> = {
  music: "Music",
  speech: "Speech",
  sfx: "Sound effects",
  lipsync: "Lip sync",
  llm: "LLM",
};

/**
 * Body copy for roles the generic wording does not fit. "Describe the llm…"
 * is nonsense: an LLM node is handed a rough prompt and hands back a better
 * one, so both its input and its output need saying in those terms.
 */
export const ROLE_COPY: Record<string, { placeholder: string; well: string }> = {
  llm: {
    placeholder: "Paste a rough prompt to rewrite…",
    well: "Your rewritten prompt will appear here",
  },
  // "Describe the music" fits generation; with a source track wired the same
  // words read as restyle directions, which is exactly what they become.
  music: {
    placeholder: "Describe the music to generate…",
    well: "Your music will appear here",
  },
  speech: {
    placeholder: "Enter text to generate speech…",
    well: "Your audio will appear here",
  },
  sfx: {
    placeholder: "Describe the sound effect…",
    well: "Your audio will appear here",
  },
};
