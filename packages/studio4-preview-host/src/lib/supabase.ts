import { createClient } from '@supabase/supabase-js';

/**
 * Supabase-client voor de preview-host. Gebruikt de publieke publishable
 * key (sb_publishable_*) — die mag in de bundle staan. De echte auth
 * gebeurt via magic-link → session.access_token wordt gebruikt als Bearer
 * bij fetch-calls naar sandbox-build-trigger (Edge Function verifieert).
 *
 * Hard-reject als iemand per ongeluk een sb_secret_* key als anon zet:
 * die hoort server-side te blijven. Zelfde patroon als apps/app.
 */

const SUPABASE_URL = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Niet fatal bij build-time; App toont een duidelijke fout.
  console.warn('[supabase] VITE_SUPABASE_URL of VITE_SUPABASE_ANON_KEY ontbreekt');
}

if (SUPABASE_ANON_KEY?.startsWith('sb_secret_')) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY lijkt een service-role-key (sb_secret_...). ' +
    'Die hoort server-side te blijven. Gebruik sb_publishable_...',
  );
}

export const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_ANON_KEY ?? '', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const SUPABASE_CONFIG_OK = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
