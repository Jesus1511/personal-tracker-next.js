import Anthropic from "@anthropic-ai/sdk";

import { CLAUDE_MODEL_FALLBACK_CHAIN } from "./claude-models";
import type { ClaudeRequest, ClaudeResponse } from "./types";

export type ClaudeStreamRequest = {
  system: string;
  messages: Anthropic.MessageParam[];
  model?: string;
  maxTokens?: number;
};

function getClaudeModelCandidates(model?: string): string[] {
  if (model && model.trim()) return [model.trim()];
  const configured = process.env.CLAUDE_MODEL?.trim();
  if (configured) return [configured];
  return [...CLAUDE_MODEL_FALLBACK_CHAIN];
}

function isPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("403") || err.message.includes("permission_error");
}

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function getClaudeErrorInfo(err: unknown): Record<string, unknown> {
  const nested = err && typeof err === "object"
    ? (err as Record<string, unknown>).error
    : undefined;
  return {
    status: numberField(err, "status"),
    type: stringField(nested, "type") ?? stringField(err, "type"),
    message:
      stringField(nested, "message") ??
      (err instanceof Error ? err.message : String(err)),
    requestId:
      stringField(err, "request_id") ??
      stringField(err, "requestID") ??
      stringField(err, "_request_id"),
  };
}

function logClaudeAttempt(kind: string, model: string) {
  console.info("[claude] request", {
    kind,
    model,
    keySource: process.env.CLAUDE_API_KEY ? "CLAUDE_API_KEY" : "ANTHROPIC_API_KEY",
  });
}

function logClaudeError(kind: string, model: string, err: unknown) {
  console.error("[claude] error", {
    kind,
    model,
    ...getClaudeErrorInfo(err),
  });
}

function getClaudeClient() {
  const key =
    process.env.CLAUDE_API_KEY?.trim() ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing API key: set CLAUDE_API_KEY or ANTHROPIC_API_KEY (SDK default).",
    );
  }
  return new Anthropic({ apiKey: key });
}

/**
 * Server-only wrapper around the Anthropic Messages API.
 */
export async function generateContent(req: ClaudeRequest): Promise<ClaudeResponse> {
  const client = getClaudeClient();

  try {
    let message: Anthropic.Message | null = null;
    let lastErr: unknown = null;
    for (const model of getClaudeModelCandidates(req.model)) {
      try {
        logClaudeAttempt("message", model);
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens ?? 4096,
          messages: [{ role: "user", content: req.prompt }],
        });
        break;
      } catch (err: unknown) {
        lastErr = err;
        logClaudeError("message", model, err);
        if (!isPermissionError(err)) throw err;
      }
    }
    if (!message) throw lastErr ?? new Error("Claude request failed");

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      promptTokens: message.usage.input_tokens,
      responseTokens: message.usage.output_tokens,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Claude request failed";
    throw new Error(`Claude API error: ${msg}`);
  }
}

/**
 * Streams assistant text deltas as UTF-8 bytes (plain concatenation = Markdown).
 */
export function streamContent(req: ClaudeStreamRequest): ReadableStream<Uint8Array> {
  const client = getClaudeClient();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        let stream: AsyncIterable<Anthropic.RawMessageStreamEvent> | null = null;
        let lastErr: unknown = null;
        for (const model of getClaudeModelCandidates(req.model)) {
          try {
            logClaudeAttempt("stream", model);
            stream = await client.messages.create({
              model,
              max_tokens: req.maxTokens ?? 4096,
              system: req.system,
              messages: req.messages,
              stream: true,
            });
            break;
          } catch (err: unknown) {
            lastErr = err;
            logClaudeError("stream", model, err);
            if (!isPermissionError(err)) throw err;
          }
        }
        if (!stream) throw lastErr ?? new Error("Claude stream failed");

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            try {
              controller.enqueue(encoder.encode(event.delta.text));
            } catch {
              //
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Claude stream failed";
        try {
          controller.enqueue(encoder.encode(`\n\n**Error:** ${msg}`));
        } catch {
          //
        }
      }
      try {
        controller.close();
      } catch {
        //
      }
    },
  });
}
