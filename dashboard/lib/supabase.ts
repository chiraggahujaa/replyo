"use client";

import { createClient } from "@supabase/supabase-js";

// Browser Supabase client — used only for auth (sign in, session, sign out). All
// tenant data goes through the FastAPI backend, which verifies the JWT this issues.
// The publishable key is safe to ship in client JS.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
