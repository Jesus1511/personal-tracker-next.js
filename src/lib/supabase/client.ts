"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requirePublishableKey, requireSupabaseUrl } from "./keys";

let browserClient: SupabaseClient | undefined;

/**
 * Supabase client for Client Components. Uses the publishable (or legacy anon)
 * key; RLS must protect your data.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createClient(requireSupabaseUrl(), requirePublishableKey());
  }
  return browserClient;
}
