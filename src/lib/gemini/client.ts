import Anthropic from "@anthropic-ai/sdk";

import { CLAUDE_MODEL_FALLBACK_CHAIN } from "./claude-models";
import type { ClaudeRequest, ClaudeResponse } from "./types";

export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export type RunWithToolsRequest = {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  toolExecutor: ToolExecutor;
  model?: string;
  maxTokens?: number;
};

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
 * Agentic loop: sends messages to Claude with tools, executes tool calls until
 * stop_reason === "end_turn", then returns the final text response.
 */
export async function runWithTools(
  req: RunWithToolsRequest,
): Promise<ClaudeResponse> {
  const client = getClaudeClient();
  const messages: Anthropic.MessageParam[] = [...req.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const candidates = getClaudeModelCandidates(req.model);
  const MAX_ITERATIONS = 10;

  let chosenModel: string | null = null;
  let firstResponse: Anthropic.Message | null = null;
  let lastErr: unknown = null;

  for (const model of candidates) {
    try {
      logClaudeAttempt("tools", model);
      firstResponse = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages,
        tools: req.tools,
      });
      chosenModel = model;
      break;
    } catch (err: unknown) {
      lastErr = err;
      logClaudeError("tools", model, err);
      if (!isPermissionError(err)) throw err;
    }
  }
  if (!chosenModel || !firstResponse) throw lastErr ?? new Error("No usable Claude model found for tool use.");

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = i === 0 ? firstResponse : await client.messages.create({
      model: chosenModel,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages,
      tools: req.tools,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, promptTokens: totalInputTokens, responseTokens: totalOutputTokens };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result: unknown;
        try {
          result = await req.toolExecutor(
            block.name,
            block.input as Record<string, unknown>,
          );
        } catch (err: unknown) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // max_tokens or other stop
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, promptTokens: totalInputTokens, responseTokens: totalOutputTokens };
  }

  throw new Error("runWithTools: exceeded max iterations without end_turn.");
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
