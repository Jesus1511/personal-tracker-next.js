import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requirePublishableKey, requireSupabaseUrl } from "./keys";

let serverClient: SupabaseClient | undefined;
let adminClient: SupabaseClient | undefined;

/**
 * Server client with publishable/anon key (respects RLS). For Server
 * Components, Route Handlers, and Server Actions without cookie session.
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (!serverClient) {
    serverClient = createClient(requireSupabaseUrl(), requirePublishableKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return serverClient;
}

/**
 * Server client with secret key (bypasses RLS). Use only in trusted server
 * code after your own auth checks; never import from Client Components.
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (!adminClient) {
    const secret = process.env.SUPABASE_SECRET_KEY?.trim();
    if (!secret) {
      throw new Error("Missing SUPABASE_SECRET_KEY for admin client");
    }
    adminClient = createClient(requireSupabaseUrl(), secret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient;
}
