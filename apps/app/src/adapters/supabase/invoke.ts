import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Dunne wrapper rond `supabase.functions.invoke` die de FunctionsError-shape
 * platslaat naar een discriminated union met (waar aanwezig) de publieke
 * `error`-code uit het response-body.
 *
 * Wordt gebruikt door de Supabase-persistence- en -version-adapters. Supabase
 * stuurt bij invoke automatisch de actuele sessie-JWT mee; hier hoeft geen
 * access token apart bijgehouden of doorgegeven te worden.
 */
export type InvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code?: string; transport: 'network' | 'http' };

export async function invokeEdge<T>(
  client: SupabaseClient,
  fnName: string,
  body: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  let raw: { data: unknown; error: unknown };
  try {
    raw = (await client.functions.invoke(fnName, { body })) as {
      data: unknown;
      error: unknown;
    };
  } catch {
    return { ok: false, status: 0, transport: 'network' };
  }

  const err = raw.error;
  if (err) {
    let status = 0;
    let code: string | undefined;
    // FunctionsHttpError draagt de originele Response op `.context`.
    const ctx = (err as { context?: unknown }).context;
    if (ctx instanceof Response) {
      status = ctx.status;
      try {
        const parsed = (await ctx.clone().json()) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { error?: unknown }).error === 'string'
        ) {
          code = (parsed as { error: string }).error;
        }
      } catch {
        /* body was geen JSON of leeg */
      }
    }
    return {
      ok: false,
      status,
      ...(code !== undefined ? { code } : {}),
      transport: status === 0 ? 'network' : 'http',
    };
  }

  return { ok: true, data: raw.data as T };
}
