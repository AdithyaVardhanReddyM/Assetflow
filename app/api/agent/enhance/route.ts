/**
 * Prompt crafting for the quick Image/Video tabs — one structured LLM call,
 * no conversation. Kept apart from the agent route so the "Crafting…" moment
 * carries none of the chat machinery's weight.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject } from "ai";
import { z } from "zod";

import { requireTenant } from "@/lib/studio/tenant";

export const maxDuration = 30;

const AGENT_MODEL = process.env.AGENT_MODEL ?? "google/gemini-3.6-flash";

const BodySchema = z.object({
  mode: z.enum(["image", "video"]),
  prompt: z.string().min(1).max(4000),
  aspect: z.string().optional(),
  needsStartFrame: z.boolean().default(false),
  needsEndFrame: z.boolean().default(false),
});

const ImageResult = z.object({
  prompt: z
    .string()
    .describe("The user's idea rewritten as a detailed, production-grade image prompt."),
});

const VideoResult = z.object({
  videoPrompt: z.string().describe("Detailed video generation prompt: action, camera, mood."),
  startFramePrompt: z
    .string()
    .nullable()
    .describe("Prompt for the still the video starts from, or null if not requested."),
  endFramePrompt: z
    .string()
    .nullable()
    .describe("Prompt for the still the video ends on, or null if not requested."),
});

export async function POST(req: Request) {
  const who = await requireTenant();
  if (!who) return Response.json({ error: "Not signed in." }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request." }, { status: 400 });
  const { mode, prompt, aspect, needsStartFrame, needsEndFrame } = parsed.data;

  const gmi = createOpenAICompatible({
    name: "gmi",
    apiKey: process.env.GMI_API_KEY,
    baseURL: "https://api.gmi-serving.com/v1",
    // Without this the schema rides along as prose and the model freelances
    // its own JSON keys; with it GMI enforces response_format json_schema.
    supportsStructuredOutputs: true,
  });
  // Prompt rewriting needs craft, not deliberation — low reasoning keeps the
  // "Crafting…" moment near-instant (the model reasons by default).
  const model = gmi.chatModel(AGENT_MODEL);
  const reasoning = { gmi: { reasoningEffort: "low" } };
  const shape = aspect ? ` The output shape is ${aspect}.` : "";

  try {
    if (mode === "image") {
      const { object } = await generateObject({
        model,
        providerOptions: reasoning,
        schema: ImageResult,
        prompt:
          `Rewrite this idea as one detailed image-generation prompt a senior art ` +
          `director would sign off: subject, style, lighting, composition, mood. ` +
          `Keep the user's intent exactly; add craft, not new concepts.${shape}\n\n` +
          `Idea: ${prompt}`,
      });
      return Response.json(object);
    }

    const frames = [
      needsStartFrame ? "a startFramePrompt for the opening still" : null,
      needsEndFrame ? "an endFramePrompt for the closing still" : null,
    ].filter(Boolean);
    const { object } = await generateObject({
      model,
      providerOptions: reasoning,
      schema: VideoResult,
      prompt:
        `Rewrite this idea as a detailed video-generation brief. Return a videoPrompt ` +
        `(action, camera movement, pacing, mood)` +
        (frames.length ? ` plus ${frames.join(" and ")}` : "") +
        `. Set any frame prompt you were not asked for to null. Keep the user's ` +
        `intent exactly; the clip is short (~5s).${shape}\n\nIdea: ${prompt}`,
    });
    return Response.json({
      videoPrompt: object.videoPrompt,
      startFramePrompt: needsStartFrame ? object.startFramePrompt : null,
      endFramePrompt: needsEndFrame ? object.endFramePrompt : null,
    });
  } catch {
    // The caller degrades to the raw prompt — crafting is an upgrade, not a gate.
    return Response.json({ error: "Enhance failed." }, { status: 502 });
  }
}
