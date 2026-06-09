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
 * Agentic streaming loop:
 * - Runs tool calls (non-streaming) emitting \x01TOOL:{json}\n markers per call.
 * - Streams the final Claude text response in real time.
 * Protocol: lines starting with \x01TOOL: are tool-call events; everything else is markdown text.
 */
export function streamWithToolsAgentic(
  req: RunWithToolsRequest,
): ReadableStream<Uint8Array> {
  const client = getClaudeClient();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (chunk: string) => {
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* closed */ }
      };

      try {
        const messages: Anthropic.MessageParam[] = [...req.messages];
        const candidates = getClaudeModelCandidates(req.model);
        let chosenModel: string | null = null;

        const MAX_TURNS = 10;
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // Resolve model on first turn; reuse on subsequent turns
          if (turn === 0) {
            let lastErr: unknown = null;
            for (const model of candidates) {
              try {
                logClaudeAttempt("stream+tools", model);
                // Attempt first streaming call to resolve model
                const s = await client.messages.create({
                  model,
                  max_tokens: req.maxTokens ?? 4096,
                  system: req.system,
                  messages,
                  tools: req.tools,
                  stream: true,
                });
                chosenModel = model;
                // Process this first stream
                const { stopReason, contentBlocks, toolResults } =
                  await processStream(s, emit);
                messages.push({ role: "assistant", content: contentBlocks });
                if (stopReason !== "tool_use") { return; }
                for (const tr of toolResults) {
                  emit(`\x01TOOL:${tr.toolJson}\n`);
                  const result = await safeCallTool(req.toolExecutor, tr.name, tr.input);
                  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tr.id, content: JSON.stringify(result) }] });
                }
                break;
              } catch (err) {
                lastErr = err;
                logClaudeError("stream+tools", model, err);
                if (!isPermissionError(err)) throw err;
              }
            }
            if (!chosenModel) throw lastErr ?? new Error("No usable model for streaming tools.");
            continue;
          }

          // Subsequent turns
          const s = await client.messages.create({
            model: chosenModel!,
            max_tokens: req.maxTokens ?? 4096,
            system: req.system,
            messages,
            tools: req.tools,
            stream: true,
          });
          const { stopReason, contentBlocks, toolResults } = await processStream(s, emit);
          messages.push({ role: "assistant", content: contentBlocks });
          if (stopReason !== "tool_use") break;
          for (const tr of toolResults) {
            emit(`\x01TOOL:${tr.toolJson}\n`);
            const result = await safeCallTool(req.toolExecutor, tr.name, tr.input);
            messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tr.id, content: JSON.stringify(result) }] });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit(`\n\n**Error:** ${msg}`);
      }

      try { controller.close(); } catch { /* closed */ }
    },
  });
}

type ToolResult = { id: string; name: string; toolJson: string; input: Record<string, unknown> };

async function processStream(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  emit: (chunk: string) => void,
): Promise<{ stopReason: string | null; contentBlocks: Anthropic.ContentBlockParam[]; toolResults: ToolResult[] }> {
  type AccumBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; inputJson: string; input: Record<string, unknown> };

  const blocksByIndex = new Map<number, AccumBlock>();
  let stopReason: string | null = null;

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const b = event.content_block;
      if (b.type === "text") {
        blocksByIndex.set(event.index, { type: "text", text: "" });
      } else if (b.type === "tool_use") {
        blocksByIndex.set(event.index, { type: "tool_use", id: b.id, name: b.name, inputJson: "", input: {} });
      }
    } else if (event.type === "content_block_delta") {
      const block = blocksByIndex.get(event.index);
      if (!block) continue;
      const d = event.delta;
      if (d.type === "text_delta" && block.type === "text") {
        block.text += d.text;
        emit(d.text);
      } else if (d.type === "input_json_delta" && block.type === "tool_use") {
        block.inputJson += d.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const block = blocksByIndex.get(event.index);
      if (block?.type === "tool_use") {
        try { block.input = JSON.parse(block.inputJson || "{}") as Record<string, unknown>; } catch { block.input = {}; }
      }
    } else if (event.type === "message_delta") {
      stopReason = event.delta.stop_reason ?? null;
    }
  }

  const sorted = [...blocksByIndex.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  const contentBlocks: Anthropic.ContentBlockParam[] = sorted.map((b) =>
    b.type === "text"
      ? { type: "text" as const, text: b.text }
      : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input },
  );

  const toolResults: ToolResult[] = sorted
    .filter((b): b is Extract<AccumBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      toolJson: JSON.stringify({ name: b.name, input: b.input }),
      input: b.input,
    }));

  return { stopReason, contentBlocks, toolResults };
}

async function safeCallTool(
  executor: ToolExecutor,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try { return await executor(name, input); }
  catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
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
