// Receives Stripe webhook events. Handles:
//  - account.updated: fires as a Referrer completes (or changes) their
//    Connect Express onboarding -- flips recruiters.stripe_onboarding_complete,
//    which both the "Connect Stripe" banner and the payout-release function
//    depend on.
//  - checkout.session.completed: fires when an Employer finishes paying a
//    placement fee -- flips placements.fee_paid, which is what actually
//    puts money in MakePlacement's Stripe balance for release-payout-installments
//    to pay Referrers from. Also triggers awardReferralBonus below.
//
// This endpoint needs TWO separate webhook destinations registered in the
// Stripe Dashboard, both pointing at this same URL: one scoped to
// "Connected accounts" subscribed to account.updated, and one scoped to
// "Your account" subscribed to checkout.session.completed. Stripe gives
// each destination its own signing secret -- set both, comma-separated,
// via `supabase secrets set STRIPE_WEBHOOK_SECRETS=whsec_aaa,whsec_bbb`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

// Refer & earn: cut of a referred recruiter's OWN placement fee
// (referrer_bonus_total, not the employer's full fee) that the recruiter
// who referred them earns -- once, on the referred recruiter's first paid
// placement. Recording it here only creates a "pending" ledger row; the
// actual Stripe transfer to the referrer is a separate release step, same
// pattern as release-payout-installments already uses for the recruiter's
// own payouts.
const REFERRAL_BONUS_PCT = 0.15;

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

// Awards the referrer a one-time bonus the first time their referred
// recruiter gets a placement fee paid. Guards against double-awarding
// two ways: the in-code count check (belt) and referral_bonuses.
// unique(referred_recruiter_id) at the DB level (suspenders, covers
// concurrent/duplicate webhook deliveries for the same event).
async function awardReferralBonus(placement: { id: string; recruiter_id: string; referrer_bonus_total: number }) {
  const { data: recruiter } = await supabaseAdmin
    .from("recruiters")
    .select("id, referred_by_code")
    .eq("id", placement.recruiter_id)
    .single();
  if (!recruiter?.referred_by_code) return;

  const { count: priorPaidCount } = await supabaseAdmin
    .from("placements")
    .select("id", { count: "exact", head: true })
    .eq("recruiter_id", recruiter.id)
    .eq("fee_paid", true);
  if ((priorPaidCount ?? 0) !== 1) return; // not their first paid placement

  const { data: referrer } = await supabaseAdmin
    .from("recruiters")
    .select("id")
    .eq("referral_code", recruiter.referred_by_code)
    .maybeSingle();
  if (!referrer) return; // referral code didn't match a real recruiter

  const amount = Math.round(Number(placement.referrer_bonus_total) * REFERRAL_BONUS_PCT * 100) / 100;

  await supabaseAdmin.from("referral_bonuses").insert([{
    referrer_id: referrer.id,
    referred_recruiter_id: recruiter.id,
    placement_id: placement.id,
    pct: REFERRAL_BONUS_PCT,
    amount,
  }]);
  // A unique-violation here just means this bonus was already recorded
  // (e.g. a retried webhook delivery) -- nothing to do, so the error from
  // this insert is intentionally not checked or surfaced.
}

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
      const { data: placement, error } = await supabaseAdmin
        .from("placements")
        .update({ fee_paid: true, fee_paid_at: new Date().toISOString() })
        .eq("id", placementId)
        .select("id, recruiter_id, referrer_bonus_total")
        .single();

      if (error) {
        return new Response(`Failed updating placement: ${error.message}`, { status: 500 });
      }

      if (placement) {
        await awardReferralBonus(placement);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
