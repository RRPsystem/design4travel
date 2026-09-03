import type { SupabaseClient } from '@supabase/supabase-js';
import { TravelContentSchema, type TravelContent } from '@design4/travel-content/schema';
import { invokeEdge } from '../supabase/invoke.js';

/**
 * Client-side wrapper rond de `resolve-content-source` Edge Function.
 *
 * Deze functie is uitsluitend een dun kanaal: input door, output valideren
 * tegen het canonical TravelContent-schema, klaar. De sanitisation +
 * autorisatie zit server-side (adapter + RLS); dit is de client-side
 * type-safety gate zodat we hier nooit een niet-conform TravelContent-
 * object naar de seed-builder doorlaten.
 */

export type ResolveContentResult =
  | { ok: true; contentSourceId: string; content: TravelContent; hash: string; version: string }
  | { ok: false; error: string };

export interface ResolveContentInput {
  kind: 'fixture' | 'travel_compositor' | 'studio4_content' | 'manual';
  source_id: string;
}

interface RawResolveResponse {
  ok?: boolean;
  content_source_id?: unknown;
  content?: unknown;
  hash?: unknown;
  version?: unknown;
  error?: unknown;
}

export async function resolveContentSource(
  client: SupabaseClient,
  input: ResolveContentInput,
): Promise<ResolveContentResult> {
  const res = await invokeEdge<RawResolveResponse>(client, 'resolve-content-source', {
    kind: input.kind,
    source_id: input.source_id,
  });
  if (!res.ok) {
    return { ok: false, error: res.code ?? `http_${res.status}` };
  }
  const raw = res.data;
  if (!raw || raw.ok !== true || typeof raw.content_source_id !== 'string') {
    const err = typeof raw?.error === 'string' ? raw.error : 'malformed_response';
    return { ok: false, error: err };
  }
  const parsed = TravelContentSchema.safeParse(raw.content);
  if (!parsed.success) {
    return { ok: false, error: 'content_schema_invalid' };
  }
  return {
    ok: true,
    contentSourceId: raw.content_source_id,
    content: parsed.data,
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    version: typeof raw.version === 'string' ? raw.version : '',
  };
}
