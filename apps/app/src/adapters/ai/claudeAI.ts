import type { SupabaseClient } from '@supabase/supabase-js';
import type { AIAdapter, AIContext, AIResponse } from './types.js';
import { invokeEdge } from '../supabase/invoke.js';

interface ClaudeAIOptions {
  client: SupabaseClient;
  /**
   * project_document_id uit bootstrap. De Edge Function laadt de doc-inhoud
   * zelf uit `project_documents` (onder RLS via de user-JWT). We hoeven de
   * doc-JSON hier niet mee te sturen; dat scheelt payload + cache-warmte
   * bij de Anthropic-cache_control op de system-prompt.
   */
  projectDocumentId: string;
}

interface GenerateResponse {
  assistantMessage: string;
  patches: unknown[]; // frontend Zod-validation gebeurt via DesignDocSchema in applyOps
}

export class ClaudeAIAdapter implements AIAdapter {
  readonly name = 'claude';
  private readonly client: SupabaseClient;
  private readonly projectDocumentId: string;

  constructor(opts: ClaudeAIOptions) {
    this.client = opts.client;
    this.projectDocumentId = opts.projectDocumentId;
  }

  async generatePatch(context: AIContext, prompt: string): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      project_document_id: this.projectDocumentId,
      prompt,
    };
    if (context.selectedNodeId) body.selected_node_id = context.selectedNodeId;

    const res = await invokeEdge<GenerateResponse>(this.client, 'generate-patch', body);

    if (!res.ok) {
      throw new Error(
        `generate-patch failed: status=${res.status} code=${res.code ?? '-'}`,
      );
    }
    const data = res.data;
    if (!data || typeof data.assistantMessage !== 'string' || !Array.isArray(data.patches)) {
      throw new Error('generate-patch returned malformed response');
    }
    // Cast: PatchOp-validatie gebeurt in designDocStore.applyOps via
    // DesignDocSchema. Als de Edge Function een malformed patch retourneert,
    // krijgt de user daar de foutmelding via applyOps' error-pad.
    return {
      assistantMessage: data.assistantMessage,
      patches: data.patches as AIResponse['patches'],
    };
  }
}
