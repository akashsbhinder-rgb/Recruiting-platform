// Run on a schedule (e.g. daily via Supabase Cron / pg_cron) to release any
// payout_installments that are due. Transfers the installment amount from
// MakePlacement's Stripe balance to the Referrer's connected account.
//
// Only releases installments for placements where placements.fee_paid is
// true (set by stripe-webhook on checkout.session.completed) -- otherwise
// there's no guarantee MakePlacement's Stripe balance actually has the
// money to transfer out. Installments that fail for other reasons (e.g. a
// genuine Stripe API error) are marked "failed", not silently dropped, so
// a manual re-run/retry path against "failed" rows is needed for those.

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

Deno.serve(async (_req) => {
  const today = new Date().toISOString().slice(0, 10);

  const { data: due, error } = await supabaseAdmin
    .from("payout_installments")
    .select("*, placements(recruiter_id, fee_paid)")
    .eq("status", "pending")
    .lte("due_date", today);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];
  for (const installment of due || []) {
    if (!installment.placements.fee_paid) {
      results.push({ installment: installment.id, skipped: "employer has not paid the placement fee yet" });
      continue;
    }
    const recruiterId = installment.placements.recruiter_id;
    const { data: recruiter } = await supabaseAdmin
      .from("recruiters")
      .select("stripe_connect_account_id, stripe_onboarding_complete")
      .eq("id", recruiterId)
      .single();

    if (!recruiter?.stripe_connect_account_id || !recruiter.stripe_onboarding_complete) {
      results.push({ installment: installment.id, skipped: "recruiter not onboarded to Stripe yet" });
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(installment.amount * 100),
        currency: "usd",
        destination: recruiter.stripe_connect_account_id,
      });
      await supabaseAdmin
        .from("payout_installments")
        .update({ status: "released", stripe_transfer_id: transfer.id, released_at: new Date().toISOString() })
        .eq("id", installment.id);
      results.push({ installment: installment.id, transfer: transfer.id });
    } catch (err) {
      await supabaseAdmin
        .from("payout_installments")
        .update({ status: "failed" })
        .eq("id", installment.id);
      results.push({ installment: installment.id, error: err.message });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
