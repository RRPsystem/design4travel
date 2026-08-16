/**
 * Directe fetch-based wrapper voor Claude Messages API met vision + tool-use.
 * Geen SDK om cold-start klein te houden (zelfde principe als sandbox-build-trigger).
 */

export interface EmittedPackage {
  manifest: Record<string, unknown>;
  componentTsx: string;
}

export interface ClaudeVisionCall {
  apiKey: string;
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: ReadonlyArray<Record<string, unknown>>;
  maxTokens: number;
}

export interface ClaudeVisionResult {
  emitted: EmittedPackage;
  tokensIn?: number;
  tokensOut?: number;
  rawText?: string;
}

interface AnthropicResponse {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { message?: string; type?: string };
}

export async function callClaudeVision(opts: ClaudeVisionCall): Promise<ClaudeVisionResult> {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: { type: 'tool', name: 'emit_studio4_component_package' },
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = (await r.json()) as AnthropicResponse;

  if (!r.ok || payload.error) {
    throw new Error(`anthropic_${r.status}: ${payload.error?.message ?? JSON.stringify(payload).slice(0, 400)}`);
  }

  // Zoek de tool_use met naam emit_studio4_component_package
  const toolBlock = payload.content?.find(
    (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      b.type === 'tool_use' && b.name === 'emit_studio4_component_package',
  );
  if (!toolBlock) {
    const textBlock = payload.content?.find((b): b is { type: 'text'; text: string } => b.type === 'text');
    throw new Error(
      `no_tool_use_in_response (stop_reason=${payload.stop_reason ?? '?'}, text="${(textBlock?.text ?? '').slice(0, 200)}")`,
    );
  }

  const input = toolBlock.input as Partial<EmittedPackage>;
  if (!input || typeof input.componentTsx !== 'string' || typeof input.manifest !== 'object' || !input.manifest) {
    throw new Error('tool_use_input_shape_invalid');
  }

  return {
    emitted: { manifest: input.manifest as Record<string, unknown>, componentTsx: input.componentTsx },
    tokensIn: payload.usage?.input_tokens,
    tokensOut: payload.usage?.output_tokens,
  };
}
