"use client";

/**
 * Voice metadata for the TTS node's picker.
 *
 * A voice ID is meaningless and a bare name ("Brian") is barely better — what
 * the user is choosing is a tone, an accent and an age. `GET /v1/catalog/voices`
 * carries those, plus a public sample URL, for every voice the catalog offers.
 *
 * Decoration, never truth: the picker renders the catalog's own options and
 * merges this on top, so a missing ELEVENLABS_API_KEY or a network blip costs
 * the tags and the sample, not the ability to choose a voice.
 *
 * One request serves the whole canvas — the promise is memoised at module
 * scope, so twenty TTS nodes mounting at once share a single fetch.
 */

import { API_URL } from "@/lib/studio/catalog";

export type VoiceMeta = {
  voice_id: string;
  name: string;
  /** ElevenLabs' own three-word character sketch, e.g. "Velvety Actress". */
  tagline: string | null;
  description: string | null;
  /** Public ElevenLabs URL — played straight from the browser. */
  preview_url: string | null;
  gender: string | null;
  age: string | null;
  accent: string | null;
  use_case: string | null;
  descriptive: string | null;
  language: string | null;
};

export type VoiceIndex = {
  byId: Record<string, VoiceMeta>;
  /** False when the backend could not reach ElevenLabs — names only. */
  available: boolean;
  reason: string | null;
};

const EMPTY: VoiceIndex = { byId: {}, available: false, reason: null };

let inflight: Promise<VoiceIndex> | null = null;

export function fetchVoices(): Promise<VoiceIndex> {
  inflight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/v1/catalog/voices`);
      if (!res.ok) return EMPTY;
      const body = (await res.json()) as {
        voices?: VoiceMeta[];
        available?: boolean;
        reason?: string | null;
      };
      const byId: Record<string, VoiceMeta> = {};
      for (const voice of body.voices ?? []) byId[voice.voice_id] = voice;
      return {
        byId,
        available: Boolean(body.available),
        reason: body.reason ?? null,
      };
    } catch {
      // Backend down — the picker falls back to catalog labels.
      return EMPTY;
    }
  })();
  return inflight;
}

/** Human wording for the machine-readable label values ElevenLabs ships. */
export function voiceTags(meta: VoiceMeta | undefined): string[] {
  if (!meta) return [];
  return [meta.gender, meta.age, meta.accent, meta.use_case]
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => tag.replace(/_/g, " "));
}

/** Everything a search box should match on for one voice. */
export function voiceHaystack(label: string, meta: VoiceMeta | undefined): string {
  return [label, meta?.name, meta?.tagline, meta?.description, ...voiceTags(meta)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
