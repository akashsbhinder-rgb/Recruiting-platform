// Receives Stripe webhook events. Currently handles account.updated, which
// fires as a Referrer completes (or changes) their Connect Express
// onboarding -- this is what flips recruiters.stripe_onboarding_complete,
// which both the "Connect Stripe" banner and the payout-release function
// depend on.
//
// After deploying, register this endpoint's URL in the Stripe Dashboard
// under Developers -> Webhooks, subscribed to "account.updated", and set
// STRIPE_WEBHOOK_SECRET via `supabase secrets set` to the signing secret
// Stripe gives you for that endpoint.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  if (event.type === "account.updated") {
    const account = event.data.object;
    const onboardingComplete = !!(account.details_submitted && account.charges_enabled && account.payouts_enabled);

    const { error } = await supabaseAdmin
      .from("recruiters")
      .update({ stripe_onboarding_complete: onboardingComplete })
      .eq("stripe_connect_account_id", account.id);

    if (error) {
      return new Response(`Failed updating recruiter: ${error.message}`, { status: 500 });
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
