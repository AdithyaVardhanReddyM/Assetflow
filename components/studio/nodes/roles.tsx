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

import { MusicGenIcon, TextToSpeechIcon } from "../asset-icons";

export type RoleIcon = React.ComponentType<{ className?: string }>;

export const ROLE_ICON: Record<string, RoleIcon> = {
  music: MusicGenIcon,
  speech: TextToSpeechIcon,
  sfx: SpeakerHifiIcon,
  lipsync: UserSoundIcon,
};

export const ROLE_LABEL: Record<string, string> = {
  music: "Music",
  speech: "Speech",
  sfx: "Sound effects",
  lipsync: "Lip sync",
};
