import { describe, expect, it, vi } from 'vitest';
import {
  StudioContentGatewayAdapter,
  searchStudioTravels,
} from './studio4-gateway-adapter.js';
import type { TravelContent } from './schema.js';

const VALID_CONTENT: TravelContent = {
  schema_version: '1.0',
  title: 'Safari Zuid-Afrika & strand Mauritius',
  intro: 'Twee weken door Zuid-Afrika en Mauritius.',
  days: 14,
  nights: 13,
  countries: ['Zuid-Afrika', 'Mauritius'],
  destinations: [
    { name: 'Johannesburg', country: 'Zuid-Afrika', from_day: 1, to_day: 2 },
    { name: 'Kruger', country: 'Zuid-Afrika', from_day: 4, to_day: 7 },
    { name: 'Mauritius', country: 'Mauritius', from_day: 8, to_day: 14 },
  ],
  hero_image_hint: 'safari elephant sunset',
  meta: {
    source_kind: 'travel_compositor',
    source_id: '54545455',
    version: '1.0',
    hash: 'a'.repeat(64),
  },
};

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StudioContentGatewayAdapter.resolve', () => {
  it('happy path: fetcht /travels/:id met Bearer + parseert TravelContent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true, content: VALID_CONTENT }));
    const adapter = new StudioContentGatewayAdapter({
      gatewayUrl: 'https://studio4.travel/api/content',
      userJwt: 'user-jwt-abc',
      fetchImpl,
    });
    const result = await adapter.resolve('54545455');
    expect(result.title).toContain('Safari');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://studio4.travel/api/content/travels/54545455');
    expect((opts as RequestInit).method).toBe('GET');
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer user-jwt-abc');
  });

  it('strippt trailing slash op gatewayUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true, content: VALID_CONTENT }));
    const adapter = new StudioContentGatewayAdapter({
      gatewayUrl: 'https://studio4.travel/api/content/',
      userJwt: 'jwt',
      fetchImpl,
    });
    await adapter.resolve('12345');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://studio4.travel/api/content/travels/12345');
  });

  it('throws bij lege sourceId', async () => {
    const adapter = new StudioContentGatewayAdapter({
      gatewayUrl: 'https://x/',
      userJwt: 'j',
      fetchImpl: vi.fn(),
    });
    await expect(adapter.resolve('')).rejects.toThrow(/source_id required/);
  });

  it('throws bij invalid sourceId (special chars)', async () => {
    const adapter = new StudioContentGatewayAdapter({
      gatewayUrl: 'https://x/',
      userJwt: 'j',
      fetchImpl: vi.fn(),
    });
    await expect(adapter.resolve('../../../etc/passwd')).rejects.toThrow(/source_id required/);
  });

  it('mapt 401 naar studio4_gateway_auth_failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));
    const adapter = new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl });
    await expect(adapter.resolve('54545455')).rejects.toThrow(/gateway_auth_401/);
  });

  it('mapt 404 naar studio4_travel_not_found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(404, { error: 'not found' }));
    const adapter = new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl });
    await expect(adapter.resolve('99999999')).rejects.toThrow(/travel_not_found:99999999/);
  });

  it('mapt 502 upstream error naar http_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(502, { error: 'upstream_down' }));
    const adapter = new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl });
    await expect(adapter.resolve('54545455')).rejects.toThrow(/gateway_http_502/);
  });

  it('weigert response met ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: false, error: 'map_failed' }));
    const adapter = new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl });
    await expect(adapter.resolve('54545455')).rejects.toThrow(/gateway_returned_error: map_failed/);
  });

  it('weigert response die niet aan TravelContentSchema voldoet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, {
      ok: true,
      content: { title: 'x', tenant_only_secret: 'leak' }, // schema-violation
    }));
    const adapter = new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl });
    await expect(adapter.resolve('54545455')).rejects.toThrow(/schema_violation/);
  });

  it('constructor throws zonder gatewayUrl of userJwt', () => {
    expect(() => new StudioContentGatewayAdapter({ gatewayUrl: '', userJwt: 'j', fetchImpl: vi.fn() }))
      .toThrow(/gatewayUrl required/);
    expect(() => new StudioContentGatewayAdapter({ gatewayUrl: 'https://x/', userJwt: '', fetchImpl: vi.fn() }))
      .toThrow(/userJwt required/);
  });
});

describe('searchStudioTravels', () => {
  it('POST naar /travels/search met query en Bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, {
      ok: true,
      results: [
        {
          source_kind: 'travel_compositor',
          source_id: '54545455',
          title: 'Safari Zuid-Afrika',
          days: 14,
          countries: ['Zuid-Afrika', 'Mauritius'],
          destinations_preview: ['Johannesburg', 'Kruger'],
        },
      ],
      total: 1,
    }));
    const results = await searchStudioTravels(
      { gatewayUrl: 'https://x/api/content', userJwt: 'jwt', fetchImpl },
      { query: 'safari' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toContain('Safari');

    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://x/api/content/travels/search');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((opts as RequestInit).body));
    expect(body.query).toBe('safari');
    expect(body.limit).toBe(20);
  });

  it('capt limit op 50', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true, results: [], total: 0 }));
    await searchStudioTravels(
      { gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl },
      { query: 'x', limit: 500 },
    );
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.limit).toBe(50);
  });

  it('lege results-array is ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: true, results: [], total: 0 }));
    const results = await searchStudioTravels(
      { gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl },
      { query: 'nonexistent' },
    );
    expect(results).toEqual([]);
  });

  it('gooit bij ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { ok: false, error: 'db_down' }));
    await expect(
      searchStudioTravels({ gatewayUrl: 'https://x/', userJwt: 'j', fetchImpl }, { query: 'x' }),
    ).rejects.toThrow(/db_down/);
  });
});
