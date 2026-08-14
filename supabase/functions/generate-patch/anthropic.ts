// Thin fetch-wrapper rond Anthropic's Messages API (raw HTTP, geen SDK).
//
// Waarom fetch en niet @anthropic-ai/sdk:
// - Deno-Edge-Functions bundelen liever compact.
// - De adaptive-thinking-parameters (`thinking.type: 'adaptive'` +
//   `output_config.effort: 'high'|'xhigh'`) waren op moment van schrijven
//   nieuw en de SDK-versie die ze correct exposed was niet gegarandeerd
//   beschikbaar. Rechtstreekse HTTP-call is voorspelbaar en versie-loos.

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type AnthropicContentBlock =
  | AnthropicToolUseBlock
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | { type: string; [k: string]: unknown };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  thinking_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: AnthropicUsage;
}

export interface AnthropicMessageInput {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicCallInput {
  apiKey: string;
  model: string;
  system: string;
  systemCacheControl?: boolean;
  /**
   * Volledige conversatie voor deze turn. Laatste message MOET role='user' zijn.
   * Voor single-turn: één user-message met de prompt.
   * Voor multi-turn: history-messages (oudste eerst) + tot slot de huidige user-prompt.
   */
  messages: AnthropicMessageInput[];
  tools: readonly unknown[];
  toolChoice?: "auto" | { type: "tool"; name: string };
  effort: "high" | "xhigh";
  betaHeaders?: string;
  maxTokens?: number;
}

export interface AnthropicCallResult {
  ok: true;
  response: AnthropicMessageResponse;
  latencyMs: number;
  requestId: string | null;
}

export interface AnthropicCallFailure {
  ok: false;
  status: number;
  errorCode: string;
  latencyMs: number;
  requestId: string | null;
}

/** POST /v1/messages met de adaptive-thinking-vorm. */
export async function callAnthropic(
  input: AnthropicCallInput,
): Promise<AnthropicCallResult | AnthropicCallFailure> {
  const started = Date.now();

  const systemBlocks = input.systemCacheControl
    ? [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }]
    : input.system;

  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? 8192,
    system: systemBlocks,
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.toolChoice ?? { type: "auto" },
    // Adaptive thinking (Claude 5.x): geen budget_tokens (400 op 4.7+).
    thinking: { type: "adaptive" },
    output_config: { effort: input.effort },
  };

  const headers: Record<string, string> = {
    "x-api-key": input.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (input.betaHeaders) headers["anthropic-beta"] = input.betaHeaders;

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      errorCode: `network:${(e as Error).message ?? "unknown"}`.slice(0, 100),
      latencyMs: Date.now() - started,
      requestId: null,
    };
  }

  const requestId = res.headers.get("request-id");
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    let errorCode = `anthropic_${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: { type?: string } };
      if (parsed.error?.type) {
        errorCode = `anthropic_${res.status}_${parsed.error.type}`.slice(0, 100);
      }
    } catch { /* body was not JSON */ }
    return { ok: false, status: res.status, errorCode, latencyMs, requestId };
  }

  const parsed = (await res.json()) as AnthropicMessageResponse;
  return { ok: true, response: parsed, latencyMs, requestId };
}

/** Extract text-content voor de assistant-message. */
export function extractAssistantText(blocks: AnthropicContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof (b as AnthropicTextBlock).text === "string") {
      out.push((b as AnthropicTextBlock).text);
    }
  }
  return out.join("\n").trim();
}

/** Extract tool_use-blokken. */
export function extractToolUses(blocks: AnthropicContentBlock[]): AnthropicToolUseBlock[] {
  return blocks.filter(
    (b): b is AnthropicToolUseBlock =>
      b.type === "tool_use" &&
      typeof (b as AnthropicToolUseBlock).name === "string" &&
      typeof (b as AnthropicToolUseBlock).input === "object",
  );
}
