// Creates (or reuses) a Stripe Express Connect account for the authenticated
// Referrer and returns a fresh Stripe-hosted onboarding link. Only callable
// once the Referrer has at least one placement on record -- matches the
// product rule that Stripe onboarding is never pushed on someone with
// nothing to be paid for yet.
//
// Required secrets (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY          - Stripe secret key (test or live)
//   SUPABASE_URL                - auto-provided by Supabase
//   SUPABASE_ANON_KEY           - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY   - auto-provided by Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !user) throw new Error("Not authenticated");

    const { data: recruiter, error: recErr } = await supabaseAdmin
      .from("recruiters")
      .select("id, email, stripe_connect_account_id")
      .eq("auth_user_id", user.id)
      .single();
    if (recErr || !recruiter) throw new Error("Recruiter not found");

    // Server-side enforcement of "only triggered at placement" -- not just
    // a UI convenience, since this endpoint could otherwise be called directly.
    const { count, error: placementErr } = await supabaseAdmin
      .from("placements")
      .select("id", { count: "exact", head: true })
      .eq("recruiter_id", recruiter.id);
    if (placementErr) throw placementErr;
    if (!count || count < 1) throw new Error("No placement on record for this recruiter yet.");

    let accountId = recruiter.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: recruiter.email,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      const { error: updateErr } = await supabaseAdmin
        .from("recruiters")
        .update({ stripe_connect_account_id: accountId })
        .eq("id", recruiter.id);
      if (updateErr) throw updateErr;
    }

    const origin = req.headers.get("origin") || "https://makeplacement.com";
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/recruiter_dashboard.html?stripe=refresh`,
      return_url: `${origin}/recruiter_dashboard.html?stripe=complete`,
      type: "account_onboarding",
    });

    return new Response(JSON.stringify({ url: accountLink.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
