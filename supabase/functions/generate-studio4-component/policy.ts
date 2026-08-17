/**
 * Inline kopie van POLICY_V1_0 uit @design4/studio4-sdk.
 * Deno Edge Functions kunnen workspace-packages niet importeren; deze kopie
 * moet handmatig gesynchroniseerd worden met packages/studio4-sdk/src/policy-v1_0.ts.
 *
 * Bron-of-truth: de studio4-sdk package. Bij wijziging daar → ook hier updaten.
 */

export interface SdkPolicy {
  version: '1.0';
  allowedImports: readonly string[];
  forbiddenGlobals: readonly string[];
  requiresSsrGuard: readonly string[];
  allowedImageDomains: readonly string[];
}

export const POLICY_V1_0: SdkPolicy = {
  version: '1.0',
  allowedImports: [
    'react',
    'react/jsx-runtime',
    'react-i18next',
    'lucide-react',
    '../../../lib/imageUtils',
    '../../../lib/sectionStyle',
    './types',
  ],
  forbiddenGlobals: [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'localStorage', 'sessionStorage', 'indexedDB',
    'eval', 'Function',
  ],
  requiresSsrGuard: ['window', 'document', 'navigator', 'location'],
  // NB: images.unsplash.com en images.pexels.com zijn bewust NIET whitelisted.
  // AI moet {{image:role|query}}-tokens gebruiken; Design4-backend vervangt die
  // na validatie door echte URLs via de media-search Edge Function. Als AI toch
  // een concrete unsplash/pexels-URL verzint (vaak een niet-bestaand photo-ID
  // → 404), pikt de validator dat op en dwingt de repair-loop naar tokens.
  allowedImageDomains: [
    'supabase.co',
    'tr2storage.blob.core.windows.net',
    'online.travelcompositor.com',
    'res.cloudinary.com',
    'static.travelconline.com',
    'i.travelapi.com',
  ],
};
