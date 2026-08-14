// Thin fetch-wrapper rond Anthropic's Messages API.
//
// Twee vormen:
// - callAnthropic(): non-streaming — één response met alle content.
// - callAnthropicStream(): streaming — async-iterator van getypeerde events
//   uit de SSE-stream. Voor real-time forward naar de client.
//
// Waarom fetch en niet @anthropic-ai/sdk:
// - Deno-Edge-Functions bundelen liever compact.
// - De adaptive-thinking-parameters (`thinking.type: 'adaptive'` +
//   `output_config.effort`) waren op moment van schrijven nieuw en de SDK-
//   versie die ze correct exposed was niet gegarandeerd beschikbaar.
// - Streaming SSE-parser is triviaal genoeg om zelf te doen zonder SDK-
//   dependency.

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

// -----------------------------------------------------------------------------
// Non-streaming (bestaand pad — nu ongebruikt door handler, maar behouden voor
// eventueel toekomstig hergebruik + tests)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Streaming (nieuw pad)
// -----------------------------------------------------------------------------

/**
 * Genormaliseerde events uit een Anthropic streaming call.
 * De ruwe SSE-events zijn wat gedetailleerder; deze subset is genoeg voor
 * onze use-case (live tool-use feed + accumulate final response).
 */
export type AnthropicStreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; index: number; id: string; name: string }
  | { kind: "tool_input_delta"; index: number; partial: string }
  | {
      kind: "tool_complete";
      index: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { kind: "usage"; usage: AnthropicUsage }
  | { kind: "message_stop" }
  | { kind: "error"; message: string };

export interface AnthropicStreamStart {
  ok: true;
  events: AsyncGenerator<AnthropicStreamEvent, void, void>;
  requestId: string | null;
  startedAt: number;
}

/**
 * Start een streaming Anthropic-call. Bij transport-fout of non-2xx retourneert
 * dit een AnthropicCallFailure (zelfde shape als non-streaming) zodat de caller
 * beide paden identiek kan mappen naar client-errors.
 */
export async function callAnthropicStream(
  input: AnthropicCallInput,
): Promise<AnthropicStreamStart | AnthropicCallFailure> {
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
    thinking: { type: "adaptive" },
    output_config: { effort: input.effort },
    stream: true,
  };

  const headers: Record<string, string> = {
    "x-api-key": input.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "accept": "text/event-stream",
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

  if (!res.ok) {
    let errorCode = `anthropic_${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: { type?: string } };
      if (parsed.error?.type) {
        errorCode = `anthropic_${res.status}_${parsed.error.type}`.slice(0, 100);
      }
    } catch { /* body was not JSON */ }
    return {
      ok: false,
      status: res.status,
      errorCode,
      latencyMs: Date.now() - started,
      requestId,
    };
  }

  if (!res.body) {
    return {
      ok: false,
      status: 500,
      errorCode: "anthropic_no_body",
      latencyMs: Date.now() - started,
      requestId,
    };
  }

  return {
    ok: true,
    events: parseAnthropicStream(res.body),
    requestId,
    startedAt: started,
  };
}

/**
 * SSE-parser voor Anthropic's stream. Yield't genormaliseerde events; slikt
 * ping-events + onbekende event-types stil.
 *
 * De parser handhaaft twee accumulators:
 * - `toolInputBuffers`: per content-block-index (die een tool_use is) het
 *   groeiende partial_json-buffer. Bij content_block_stop parsen we de
 *   volledige JSON en emit'en we tool_complete.
 * - `toolNames`: per index de tool-naam (aangeleverd bij content_block_start).
 *
 * Fail-modes:
 * - Parse-fout op event-data → skip, geen crash.
 * - Onvolledige JSON in tool_input bij message_stop → tool_complete met leeg
 *   input-object.
 */
async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicStreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  const toolInputBuffers = new Map<number, string>();
  const toolNames = new Map<number, string>();
  const toolIds = new Map<number, string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE-events zijn gescheiden door \n\n
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        // Elk event heeft "event: ..." en "data: ..."-lijnen.
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");

        let payload: {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: AnthropicUsage;
          message?: { usage?: AnthropicUsage };
          error?: { message?: string };
        };
        try {
          payload = JSON.parse(dataStr);
        } catch {
          continue;
        }

        switch (payload.type) {
          case "message_start": {
            const usage = payload.message?.usage;
            if (usage) yield { kind: "usage", usage };
            break;
          }
          case "content_block_start": {
            const idx = payload.index ?? -1;
            const block = payload.content_block;
            if (block?.type === "tool_use" && typeof block.name === "string") {
              toolInputBuffers.set(idx, "");
              toolNames.set(idx, block.name);
              if (typeof block.id === "string") toolIds.set(idx, block.id);
              yield {
                kind: "tool_start",
                index: idx,
                id: typeof block.id === "string" ? block.id : "",
                name: block.name,
              };
            }
            // Text-blocks: geen expliciete start-event, alleen delta's.
            break;
          }
          case "content_block_delta": {
            const idx = payload.index ?? -1;
            const delta = payload.delta;
            if (!delta) break;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              yield { kind: "text_delta", text: delta.text };
            } else if (
              delta.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const acc = (toolInputBuffers.get(idx) ?? "") + delta.partial_json;
              toolInputBuffers.set(idx, acc);
              yield {
                kind: "tool_input_delta",
                index: idx,
                partial: delta.partial_json,
              };
            }
            // thinking_delta etc. worden hier stil geslikt — de UI toont
            // alleen text + tool_use in v1.
            break;
          }
          case "content_block_stop": {
            const idx = payload.index ?? -1;
            const name = toolNames.get(idx);
            if (name !== undefined) {
              const rawInput = toolInputBuffers.get(idx) ?? "";
              let input: Record<string, unknown> = {};
              if (rawInput.length > 0) {
                try {
                  input = JSON.parse(rawInput) as Record<string, unknown>;
                } catch {
                  input = {};
                }
              }
              yield {
                kind: "tool_complete",
                index: idx,
                id: toolIds.get(idx) ?? "",
                name,
                input,
              };
              toolInputBuffers.delete(idx);
              toolNames.delete(idx);
              toolIds.delete(idx);
            }
            break;
          }
          case "message_delta": {
            const usage = payload.usage;
            if (usage) yield { kind: "usage", usage };
            break;
          }
          case "message_stop": {
            yield { kind: "message_stop" };
            break;
          }
          case "error": {
            yield {
              kind: "error",
              message: payload.error?.message ?? "unknown",
            };
            break;
          }
          case "ping":
          default:
            // ignore pings + onbekende types
            break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}

/** Extract text-content voor de assistant-message (non-stream pad). */
export function extractAssistantText(blocks: AnthropicContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof (b as AnthropicTextBlock).text === "string") {
      out.push((b as AnthropicTextBlock).text);
    }
  }
  return out.join("\n").trim();
}

/** Extract tool_use-blokken (non-stream pad). */
export function extractToolUses(blocks: AnthropicContentBlock[]): AnthropicToolUseBlock[] {
  return blocks.filter(
    (b): b is AnthropicToolUseBlock =>
      b.type === "tool_use" &&
      typeof (b as AnthropicToolUseBlock).name === "string" &&
      typeof (b as AnthropicToolUseBlock).input === "object",
  );
}
