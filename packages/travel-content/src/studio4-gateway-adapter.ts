import { ContentSourceError, type ContentSourceAdapter } from './adapter.js';
import { TravelContentSchema, type TravelContent } from './schema.js';

/**
 * StudioContentGatewayAdapter — content-adapter voor het `studio4_content`
 * kind. Praat tegen de Studio4-gateway op TravelBridgeAI-repo (Netlify
 * Functions onder `/api/content/*`). Design4 heeft géén TC-credentials,
 * géén directe DB — alle sanitisation gebeurt server-side. Gateway retourneert
 * strict `TravelContent v1` zoals in @design4/travel-content/schema.
 *
 * Auth-model: adapter stuurt user-JWT als Bearer mee; gateway verifieert die
 * met Studio4-Supabase (users bestaan in beide auth-projecten). Zie
 * `docs/studio4-content-gateway.md` in de repo.
 *
 * Gebruik:
 *   const adapter = new StudioContentGatewayAdapter({
 *     gatewayUrl: 'https://studio4.travel/api/content',
 *     userJwt: '<jwt-from-request>',
 *   });
 *   const content = await adapter.resolve('54545455');
 */

export interface StudioGatewayConfig {
  gatewayUrl: string;
  userJwt: string;
  /** Injectable voor tests. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms voor gateway calls. Default: 15s. */
  timeoutMs?: number;
}

export interface StudioTravelSearchResult {
  source_kind: 'travel_compositor' | 'studio4_content';
  source_id: string;
  title: string;
  days?: number;
  countries: string[];
  destinations_preview: string[];
  thumbnail_url?: string;
  updated_at?: string;
}

const TC_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export class StudioContentGatewayAdapter implements ContentSourceAdapter {
  readonly kind = 'studio4_content' as const;

  constructor(private readonly config: StudioGatewayConfig) {
    if (!config.gatewayUrl) {
      throw new ContentSourceError('gatewayUrl required', 'studio4_gateway_url_missing');
    }
    if (!config.userJwt) {
      throw new ContentSourceError('userJwt required', 'studio4_jwt_missing');
    }
  }

  async resolve(sourceId?: string): Promise<TravelContent> {
    if (!sourceId || !TC_ID_REGEX.test(sourceId)) {
      throw new ContentSourceError(
        'source_id required (alphanumeric, max 64 chars)',
        'studio4_invalid_source_id',
      );
    }

    const url = `${this.config.gatewayUrl.replace(/\/+$/, '')}/travels/${encodeURIComponent(sourceId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    const fetchImpl = this.config.fetchImpl ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.userJwt}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      throw new ContentSourceError(
        `gateway_call_failed: ${(e as Error).message}`,
        'studio4_gateway_call_failed',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ContentSourceError(
        `gateway_auth_${response.status}`,
        'studio4_gateway_auth_failed',
      );
    }
    if (response.status === 404) {
      throw new ContentSourceError(
        `travel_not_found:${sourceId}`,
        'studio4_travel_not_found',
      );
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new ContentSourceError(
        `gateway_http_${response.status}: ${bodyText.slice(0, 200)}`,
        'studio4_gateway_http_error',
      );
    }

    let body: { ok?: boolean; content?: unknown; error?: string };
    try {
      body = await response.json() as typeof body;
    } catch (e) {
      throw new ContentSourceError(
        `gateway_response_not_json: ${(e as Error).message}`,
        'studio4_gateway_bad_json',
      );
    }

    if (!body.ok || !body.content) {
      throw new ContentSourceError(
        `gateway_returned_error: ${body.error ?? 'unknown'}`,
        'studio4_gateway_error',
      );
    }

    // Strict Zod-parse — zorgt dat gateway écht TravelContent v1 conform is
    // en geen tenant-only-velden lekt.
    const parsed = TravelContentSchema.safeParse(body.content);
    if (!parsed.success) {
      throw new ContentSourceError(
        `gateway_response_schema_violation: ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).slice(0, 5).join(';')}`,
        'studio4_gateway_schema_violation',
      );
    }
    return parsed.data;
  }
}

/**
 * Standalone helper voor de zoek-flow (UI-picker: lijst van reizen met titel/
 * bestemmingen). Geen adapter-methode omdat search geen `TravelContent`
 * retourneert maar een preview-array.
 */
export async function searchStudioTravels(
  config: StudioGatewayConfig,
  request: { query?: string; tc_id?: string; destination?: string; limit?: number },
): Promise<StudioTravelSearchResult[]> {
  if (!config.gatewayUrl) throw new ContentSourceError('gatewayUrl required', 'studio4_gateway_url_missing');
  if (!config.userJwt) throw new ContentSourceError('userJwt required', 'studio4_jwt_missing');

  const url = `${config.gatewayUrl.replace(/\/+$/, '')}/travels/search`;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.userJwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: request.query,
        tc_id: request.tc_id,
        destination: request.destination,
        limit: Math.min(request.limit ?? 20, 50),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ContentSourceError(
      `gateway_call_failed: ${(e as Error).message}`,
      'studio4_gateway_call_failed',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ContentSourceError(`gateway_http_${response.status}`, 'studio4_gateway_http_error');
  }
  const body = await response.json() as { ok?: boolean; results?: StudioTravelSearchResult[]; error?: string };
  if (!body.ok || !Array.isArray(body.results)) {
    throw new ContentSourceError(`gateway_returned_error: ${body.error ?? 'unknown'}`, 'studio4_gateway_error');
  }
  return body.results;
}
