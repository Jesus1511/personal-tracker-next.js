import Anthropic from "@anthropic-ai/sdk";

import type { ClaudeRequest, ClaudeResponse } from "./types";

const CLAUDE_MODEL = "claude-opus-4-7";

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
    const message = await client.messages.create({
      model: req.model ?? CLAUDE_MODEL,
      max_tokens: req.maxTokens ?? 4096,
      messages: [{ role: "user", content: req.prompt }],
    });

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
