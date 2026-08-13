import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "" || v.trim() === "") {
    throw new Error("env_missing");
  }
  return v;
}

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
