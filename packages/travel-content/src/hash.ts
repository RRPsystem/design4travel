/**
 * Deterministic SHA-256 hash van een JSON-value. Sorteert object-keys zodat
 * dezelfde inhoud altijd dezelfde hash geeft — cruciaal voor cache-lookup
 * en versie-tracking van content-sources.
 *
 * Werkt in Node én Deno via de Web Crypto API.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function sha256Hex(value: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(stableStringify(value));
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
