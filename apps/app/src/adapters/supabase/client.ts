import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. See apps/app/.env.example.',
  );
}

// The publishable/anon key is safe in the browser bundle. A key starting with
// sb_secret_ (or a service_role JWT) bypasses RLS and must never ship client-side.
if (anonKey.startsWith('sb_secret_')) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY looks like a secret key (sb_secret_...). Use the publishable/anon key instead.',
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
