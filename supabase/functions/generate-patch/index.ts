import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";
import { callAnthropic } from "./anthropic.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "" || v.trim() === "") {
    throw new Error("env_missing");
  }
  return v;
}

function optionalEnv(name: string): string | null {
  const v = Deno.env.get(name);
  if (v === undefined || v === "" || v.trim() === "") return null;
  return v;
}

function makeUserClient(jwt: string): SupabaseClient {
  // Belangrijk: `global.headers.Authorization` zorgt dat elke PostgREST-call
  // (.from(...).select(...) etc.) onder de user's JWT loopt. Alleen de anon-
  // key als 2e arg zetten is NIET genoeg — dan gaan de queries als anonymous
  // en RLS-policies met auth.uid()-checks failen met 42501 (permission denied).
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
}

function makeAdmin(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

Deno.serve(makeHandler({
  makeUserClient,
  makeAdmin,
  getAnthropicApiKey: () => optionalEnv("ANTHROPIC_API_KEY"),
  getOrchestratorModel: () => optionalEnv("ORCHESTRATOR_MODEL") ?? "claude-sonnet-5",
  getSpecialistModel: () => optionalEnv("SPECIALIST_MODEL") ?? "claude-opus-5",
  getBetaHeaders: () => optionalEnv("ANTHROPIC_BETA"),
  now: () => Date.now(),
  callAnthropic,
}));
