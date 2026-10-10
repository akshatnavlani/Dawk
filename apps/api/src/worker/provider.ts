import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6-astra",
  google: "gemini-3.8-flash",
} as const;

const SUPPORTED = new Set<string>(Object.keys(DEFAULT_MODELS));

// Published base rates in USD per million tokens.
// Anthropic and OpenAI rates checked 2026-10-09. Gemini 3.8 Flash standard
// rate checked 2026-10-10: $0.75 input and $3.75 output through 2026-12-31
// (https://ai.google.dev/gemini-api/docs/pricing). Cache and long-context
// prices are not included. Unknown models use the higher of the Claude and
// OpenAI rates so a spend cap does not under-count.
const RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
};
const FALLBACK_RATE = { input: 10, output: 50 };

export type LlmFailureKind =
  | "auth"
  | "quota"
  | "rate"
  | "transient"
  | "unsupported"
  | "fatal";

export class LlmError extends Error {
  readonly kind: LlmFailureKind;

  constructor(kind: LlmFailureKind) {
    super(kind);
    this.name = "LlmError";
    this.kind = kind;
  }
}

export type LlmRequest = {
  provider: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
};

export type LlmResult = {
  text: string;
  tokenIn: number;
  tokenOut: number;
  costEst: number;
};

export type LlmClient = {
  complete(request: LlmRequest): Promise<LlmResult>;
};

export function supportsProvider(provider: string): boolean {
  return SUPPORTED.has(provider);
}

export function defaultModel(provider: string): string | null {
  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "google"
  ) {
    return DEFAULT_MODELS[provider];
  }
  return null;
}

export function estimateCost(
  model: string,
  tokenIn: number,
  tokenOut: number,
): number {
  const rate = RATES[model] ?? FALLBACK_RATE;
  const cost = (tokenIn * rate.input + tokenOut * rate.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function classifyProviderFailure(
  status: number | undefined,
  detail: string,
): LlmFailureKind {
  const text = detail.toLowerCase();
  if (
    text.includes("quota") ||
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("insufficient")
  ) {
    return "quota";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate";
  }
  if (
    status === undefined ||
    status === 408 ||
    status === 529 ||
    status >= 500
  ) {
    return "transient";
  }
  return "fatal";
}

function statusOf(error: unknown): { status?: number; detail: string } {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = error.status;
    const message = "message" in error ? String(error.message) : "";
    if (typeof status === "number") {
      return { status, detail: message };
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { detail: "timeout" };
  }
  return { detail: "" };
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  const { status, detail } = statusOf(error);
  return new LlmError(classifyProviderFailure(status, detail));
}

export function createLiveClient(): LlmClient {
  return {
    async complete(request) {
      if (!supportsProvider(request.provider)) {
        throw new LlmError("unsupported");
      }
      try {
        if (request.provider === "anthropic") {
          return await completeAnthropic(request);
        }
        if (request.provider === "google") {
          return await completeGoogle(request);
        }
        return await completeOpenAI(request);
      } catch (error) {
        throw asLlmError(error);
      }
    },
  };
}

async function completeAnthropic(request: LlmRequest): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: request.apiKey });
  const message = await client.messages.create(
    {
      model: request.model,
      max_tokens: 1024,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    },
    { signal: AbortSignal.timeout(45_000) },
  );
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const tokenIn = message.usage.input_tokens;
  const tokenOut = message.usage.output_tokens;
  return {
    text,
    tokenIn,
    tokenOut,
    costEst: estimateCost(request.model, tokenIn, tokenOut),
  };
}

async function completeGoogle(request: LlmRequest): Promise<LlmResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": request.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error(`gemini failed status=${response.status}`);
    throw new LlmError(classifyProviderFailure(response.status, detail));
  }
  const body = (await response.json()) as {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  const tokenIn = body.usageMetadata?.promptTokenCount ?? 0;
  const tokenOut = body.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text,
    tokenIn,
    tokenOut,
    costEst: estimateCost(request.model, tokenIn, tokenOut),
  };
}

async function completeOpenAI(request: LlmRequest): Promise<LlmResult> {
  const client = new OpenAI({ apiKey: request.apiKey });
  const completion = await client.chat.completions.create(
    {
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    },
    { signal: AbortSignal.timeout(45_000) },
  );
  const content = completion.choices[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  const tokenIn = completion.usage?.prompt_tokens ?? 0;
  const tokenOut = completion.usage?.completion_tokens ?? 0;
  return {
    text,
    tokenIn,
    tokenOut,
    costEst: estimateCost(request.model, tokenIn, tokenOut),
  };
}
