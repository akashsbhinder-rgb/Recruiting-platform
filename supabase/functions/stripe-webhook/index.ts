// Receives Stripe webhook events. Handles:
//  - account.updated: fires as a Referrer completes (or changes) their
//    Connect Express onboarding -- flips recruiters.stripe_onboarding_complete,
//    which both the "Connect Stripe" banner and the payout-release function
//    depend on.
//  - checkout.session.completed: fires when an Employer finishes paying a
//    placement fee -- flips placements.fee_paid, which is what actually
//    puts money in MakePlacement's Stripe balance for release-payout-installments
//    to pay Referrers from.
//
// This endpoint needs TWO separate webhook destinations registered in the
// Stripe Dashboard, both pointing at this same URL: one scoped to
// "Connected accounts" subscribed to account.updated, and one scoped to
// "Your account" subscribed to checkout.session.completed. Stripe gives
// each destination its own signing secret -- set both, comma-separated,
// via `supabase secrets set STRIPE_WEBHOOK_SECRETS=whsec_aaa,whsec_bbb`.

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

const webhookSecrets = (Deno.env.get("STRIPE_WEBHOOK_SECRETS") || Deno.env.get("STRIPE_WEBHOOK_SECRET") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event;
  let verified = false;
  for (const secret of webhookSecrets) {
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature!, secret);
      verified = true;
      break;
    } catch (_err) {
      // try the next secret
    }
  }
  if (!verified) {
    return new Response("Webhook signature verification failed against all configured secrets", { status: 400 });
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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const placementId = session.metadata?.placement_id;
    if (placementId) {
      const { error } = await supabaseAdmin
        .from("placements")
        .update({ fee_paid: true, fee_paid_at: new Date().toISOString() })
        .eq("id", placementId);

      if (error) {
        return new Response(`Failed updating placement: ${error.message}`, { status: 500 });
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
