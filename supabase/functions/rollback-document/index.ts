import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  // Fail-closed on undefined, empty string, and whitespace-only. Trim only
  // to detect emptiness; the returned value is verbatim so a legitimate
  // secret is never inadvertently mutated.
  if (v === undefined || v === "" || v.trim() === "") {
    throw new Error("env_missing");
  }
  return v;
}

// No JWT is injected at construction time. `supabase.auth.getUser(jwt)`
// receives the token as an explicit parameter — a `global.headers.Authorization`
// entry here would only add a surface for future accidental leakage into
// other userClient calls.
function makeUserClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function makeAdmin(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

Deno.serve(makeHandler({ makeUserClient, makeAdmin }));
