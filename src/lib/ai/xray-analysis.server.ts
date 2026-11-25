// Server-only: AI second opinion on a chest X-ray via Lovable AI Gateway (OpenAI Responses).
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, NoObjectGeneratedError, Output, jsonSchema, streamText } from "ai";

import { createLovableAiGatewayRunIdFetch } from "./run-id";

const GATEWAY_BASE_URL = "https://ai.gateway.lovable.dev/v1";
const MODEL = "openai/gpt-6-astra";

export type AiXrayFinding = { region: string; observation: string; severity: "none" | "mild" | "moderate" | "severe" };

export type AiXrayAnalysis = {
  is_chest_xray: boolean;
  image_quality: "good" | "acceptable" | "poor";
  normal: number;
  pneumonia: number;
  tuberculosis: number;
  label: "Normal" | "Pneumonia" | "Tuberculosis" | "Indeterminate";
  findings: AiXrayFinding[];
  impression: string;
};

export class AiAnalysisError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const schema = jsonSchema<AiXrayAnalysis>({
  type: "object",
  additionalProperties: false,
  required: ["is_chest_xray", "image_quality", "normal", "pneumonia", "tuberculosis", "label", "findings", "impression"],
  properties: {
    is_chest_xray: { type: "boolean", description: "True only if the image is a frontal chest radiograph." },
    image_quality: { type: "string", enum: ["good", "acceptable", "poor"] },
    normal: { type: "number", description: "Likelihood 0-1 that the radiograph is normal." },
    pneumonia: { type: "number", description: "Likelihood 0-1 of pneumonia pattern." },
    tuberculosis: { type: "number", description: "Likelihood 0-1 of pulmonary tuberculosis pattern." },
    label: { type: "string", enum: ["Normal", "Pneumonia", "Tuberculosis", "Indeterminate"] },
    findings: {
      type: "array",
      description: "Up to 5 observations, one per lung region.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["region", "observation", "severity"],
        properties: {
          region: { type: "string" },
          observation: { type: "string" },
          severity: { type: "string", enum: ["none", "mild", "moderate", "severe"] },
        },
      },
    },
    impression: { type: "string", description: "2-4 sentence radiology-style impression." },
  },
});

const INSTRUCTIONS = `You are assisting a final-year academic research project on chest X-ray classification.
Review the frontal chest radiograph and give a structured research second opinion across three classes: Normal, Pneumonia, Tuberculosis.
- Look for TB patterns: upper-lobe / apical infiltrates, cavitation, fibro-nodular opacities, hilar lymphadenopathy, miliary nodules, pleural effusion.
- Look for pneumonia patterns: lobar or segmental consolidation, air bronchograms, patchy airspace opacities, typically lower/middle zones.
- normal, pneumonia and tuberculosis are independent likelihoods between 0 and 1 (they need not sum to 1).
- label is the most likely class; use Indeterminate if the image is not a chest X-ray or quality is too poor.
- If the image is not a chest radiograph set is_chest_xray to false, all likelihoods to 0, and explain in the impression.
- Give at most 5 findings, each naming a region (e.g. "Right upper zone").
- Write the impression in plain clinical English, 2-4 sentences. Do not give treatment advice.`;

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function mapAiError(error: unknown, streamError?: unknown): AiAnalysisError {
  const cause = streamError ?? error;
  if (cause instanceof AiAnalysisError) return cause;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? 500;
    let gatewayMessage = "";
    try {
      const body = JSON.parse(cause.responseBody ?? "{}") as { error?: { message?: string }; message?: string };
      const raw = body?.error?.message ?? body?.message;
      if (typeof raw === "string" && raw.trim()) gatewayMessage = raw.trim();
    } catch {
      /* keep empty */
    }
    if (status === 402) {
      return new AiAnalysisError(
        gatewayMessage || "AI credits are used up for this workspace. Add credits or wait for the daily reset, then try again.",
        402,
      );
    }
    if (status === 403) {
      return new AiAnalysisError(gatewayMessage || "AI access is currently blocked for this workspace.", 403);
    }
    if (status === 429) {
      return new AiAnalysisError("The AI service is busy. Please retry in a minute.", 429);
    }
    if (status === 401) {
      return new AiAnalysisError("AI service is not configured.", 401);
    }
    return new AiAnalysisError(gatewayMessage || "The AI service failed. Please try again later.", status);
  }
  if (NoObjectGeneratedError.isInstance(cause)) {
    return new AiAnalysisError("The AI could not produce a structured reading for this image.", 422);
  }
  if (cause instanceof Error && cause.message) {
    return new AiAnalysisError(cause.message, 500);
  }
  return new AiAnalysisError("The AI service failed. Please try again later.", 500);
}

export async function analyzeXrayWithAi(imageDataUrl: string, context: { tbModelProbability: number }) {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new AiAnalysisError("AI service is not configured.", 401);

  const runIdFetch = createLovableAiGatewayRunIdFetch();
  const provider = createOpenAI({
    baseURL: GATEWAY_BASE_URL,
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runIdFetch.fetch,
  });

  let streamError: unknown = null;
  const result = streamText({
    model: provider.responses(MODEL),
    instructions: INSTRUCTIONS,
    maxRetries: 0,
    onError: ({ error }) => {
      streamError = error;
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyse this chest X-ray. For reference only, our trained ResNet18 TB classifier output a TB probability of ${context.tbModelProbability.toFixed(3)}; form your own independent judgement from the image.`,
          },
          { type: "image", image: new URL(imageDataUrl) },
        ],
      },
    ],
    output: Output.object({ schema }),
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    },
  });

  try {
    const output = await result.output;
    return {
      ...output,
      normal: clamp(output.normal),
      pneumonia: clamp(output.pneumonia),
      tuberculosis: clamp(output.tuberculosis),
      findings: (output.findings ?? []).slice(0, 5),
    } satisfies AiXrayAnalysis;
  } catch (error) {
    throw mapAiError(error, streamError);
  }
}
