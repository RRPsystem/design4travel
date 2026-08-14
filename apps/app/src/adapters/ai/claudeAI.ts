import type { SupabaseClient } from '@supabase/supabase-js';
import type { PatchOp } from '@design4/design-doc';
import type {
  AIAdapter,
  AIContext,
  AIResponse,
  AIStreamEvent,
} from './types.js';

interface ClaudeAIOptions {
  client: SupabaseClient;
  /**
   * project_document_id uit bootstrap. De Edge Function laadt de doc-inhoud
   * zelf uit `project_documents` (onder RLS via de user-JWT). We hoeven de
   * doc-JSON hier niet mee te sturen; dat scheelt payload + cache-warmte
   * bij de Anthropic-cache_control op de system-prompt.
   */
  projectDocumentId: string;
  /**
   * Base URL van het Supabase-project (bv. https://xxx.supabase.co).
   * Nodig omdat supabase.functions.invoke geen SSE-streaming ondersteunt;
   * we gebruiken raw fetch naar `${supabaseUrl}/functions/v1/generate-patch`.
   */
  supabaseUrl: string;
  /**
   * Anon/publishable-key voor Supabase's edge-router (apikey-header).
   * Deze staat al veilig in de browser-bundle (dezelfde key als in
   * supabase-client init) en is geen secret.
   */
  supabaseAnonKey: string;
}

/**
 * ClaudeAIAdapter — streamt via SSE. Bij elke Anthropic-event uit de Edge
 * Function bellen we `onEvent` zodat de UI live meebeweegt. De uiteindelijke
 * assistantMessage + patches komen uit het terminale `done`-event.
 *
 * Waarom raw fetch i.p.v. supabase.functions.invoke: die wrapper leest de
 * volledige response als JSON — geen SSE-streaming mogelijk.
 */
export class ClaudeAIAdapter implements AIAdapter {
  readonly name = 'claude';
  private readonly client: SupabaseClient;
  private readonly projectDocumentId: string;
  private readonly endpointUrl: string;
  private readonly anonKey: string;

  constructor(opts: ClaudeAIOptions) {
    this.client = opts.client;
    this.projectDocumentId = opts.projectDocumentId;
    this.endpointUrl = `${opts.supabaseUrl.replace(/\/+$/, '')}/functions/v1/generate-patch`;
    this.anonKey = opts.supabaseAnonKey;
  }

  async generatePatch(
    context: AIContext,
    prompt: string,
    onEvent?: (event: AIStreamEvent) => void,
  ): Promise<AIResponse> {
    // Actuele user-JWT ophalen. Supabase-client houdt de sessie zelf up-to-date
    // (autoRefreshToken). Geen langdurig-cachen van de token.
    const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
    if (sessionError) {
      throw new Error(`getSession failed: ${sessionError.message}`);
    }
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) {
      throw new Error('generate-patch: no active session — user must sign in');
    }

    const body: Record<string, unknown> = {
      project_document_id: this.projectDocumentId,
      prompt,
    };
    if (context.selectedNodeId) body.selected_node_id = context.selectedNodeId;
    if (context.history && context.history.length > 0) body.history = context.history;

    const res = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        apikey: this.anonKey,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (typeof parsed.error === 'string') code = parsed.error;
      } catch { /* body not json */ }
      throw new Error(`generate-patch failed: status=${res.status} code=${code}`);
    }
    if (!res.body) {
      throw new Error('generate-patch: empty response body');
    }

    const final = await consumeEventStream(res.body, onEvent);
    return final;
  }
}

// -----------------------------------------------------------------------------
// SSE-consumer (client-side)
// -----------------------------------------------------------------------------

interface DonePayload {
  kind: 'done';
  assistantMessage: string;
  patches: PatchOp[];
}
interface ErrorPayload {
  kind: 'error';
  code: string;
  message: string;
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: (evt: AIStreamEvent) => void,
): Promise<AIResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let terminalDone: DonePayload | null = null;
  let terminalError: ErrorPayload | null = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        let eventName = '';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (!eventName || dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');

        let parsed: unknown;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (eventName === 'activity') {
          if (onEvent && parsed && typeof parsed === 'object') {
            onEvent(parsed as AIStreamEvent);
          }
        } else if (eventName === 'done') {
          terminalDone = parsed as DonePayload;
        } else if (eventName === 'error') {
          terminalError = parsed as ErrorPayload;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (terminalError) {
    throw new Error(
      `generate-patch stream error: ${terminalError.code} — ${terminalError.message}`,
    );
  }
  if (!terminalDone) {
    throw new Error('generate-patch: stream ended without done or error');
  }
  const patches = Array.isArray(terminalDone.patches) ? terminalDone.patches : [];
  return {
    assistantMessage: typeof terminalDone.assistantMessage === 'string'
      ? terminalDone.assistantMessage
      : '',
    patches,
  };
}
