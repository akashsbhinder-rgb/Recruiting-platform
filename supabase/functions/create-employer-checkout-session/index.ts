// Creates a Stripe Checkout Session for an Employer to pay the placement
// fee owed on a given placement. The fee percentage is computed here,
// server-side, and never sent to the browser -- dashboard.html only ever
// asks for "a checkout session for this placement" and gets back a URL to
// redirect to, matching the design decision to keep the platform/Referrer
// split private (see recruiting-agreement.html Section 2).
//
// Required secrets: STRIPE_SECRET_KEY, plus the Supabase-provided ones.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Total placement fee as a percentage of first-year base salary, per
// recruiting-agreement.html Section 2. Kept server-side only.
const TOTAL_FEE_PCT = 0.25;

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

    const { placementId } = await req.json();
    if (!placementId) throw new Error("Missing placementId");

    const { data: placement, error: placementErr } = await supabaseAdmin
      .from("placements")
      .select("id, base_salary, fee_paid, company_id, stripe_checkout_session_id")
      .eq("id", placementId)
      .single();
    if (placementErr || !placement) throw new Error("Placement not found");
    if (placement.fee_paid) throw new Error("This placement fee has already been paid");

    const { data: company, error: companyErr } = await supabaseAdmin
      .from("companies")
      .select("id, name, auth_user_id, stripe_customer_id")
      .eq("id", placement.company_id)
      .single();
    if (companyErr || !company) throw new Error("Company not found");
    // Only the company that owns this placement can pay for it.
    if (company.auth_user_id !== user.id) throw new Error("Not authorized for this placement");

    let customerId = company.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: company.name || undefined,
        email: user.email || undefined,
        metadata: { company_id: String(company.id) },
      });
      customerId = customer.id;
      await supabaseAdmin.from("companies").update({ stripe_customer_id: customerId }).eq("id", company.id);
    }

    const feeTotal = Math.round(Number(placement.base_salary) * TOTAL_FEE_PCT * 100) / 100;

    const origin = req.headers.get("origin") || "https://makeplacement.com";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: Math.round(feeTotal * 100),
          product_data: { name: "MakePlacement placement fee" },
        },
        quantity: 1,
      }],
      metadata: { placement_id: String(placement.id) },
      success_url: `${origin}/dashboard.html?fee=paid`,
      cancel_url: `${origin}/dashboard.html?fee=cancelled`,
    });

    await supabaseAdmin
      .from("placements")
      .update({ employer_fee_total: feeTotal, stripe_checkout_session_id: session.id })
      .eq("id", placement.id);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
