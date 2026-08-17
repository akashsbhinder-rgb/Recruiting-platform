// Called from the public confirm-candidate.html page when a candidate
// clicks the confirm link in their email. No auth -- the token itself is
// the credential, so this uses the service role key to look the candidate
// up and flip their status, entirely outside RLS (which has no concept of
// an anonymous candidate).
//
// Deploy with --no-verify-jwt: the candidate has no Supabase session at all.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { token } = await req.json();
    if (!token) throw new Error("Missing token");

    const { data: candidate, error: candidateErr } = await supabaseAdmin
      .from("candidates")
      .select("id, name, status, role_id")
      .eq("confirmation_token", token)
      .maybeSingle();
    if (candidateErr) throw new Error(candidateErr.message);
    if (!candidate) throw new Error("This confirmation link isn't valid.");

    const { data: role } = await supabaseAdmin
      .from("roles")
      .select("name, company_id")
      .eq("id", candidate.role_id)
      .single();
    const { data: company } = role
      ? await supabaseAdmin.from("companies").select("name").eq("id", role.company_id).single()
      : { data: null };

    const roleName = (role && role.name) || "the role";
    const companyName = (company && company.name) || "the company";

    if (candidate.status === "active" || candidate.status === "hired" || candidate.status === "placed") {
      // Already confirmed at some point -- treat a repeat click as a
      // friendly no-op rather than an error.
      return new Response(JSON.stringify({ ok: true, alreadyConfirmed: true, roleName, companyName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (candidate.status !== "pending_confirmation") {
      throw new Error("This submission is no longer active.");
    }

    const { error: updateErr } = await supabaseAdmin
      .from("candidates")
      .update({ status: "active", confirmed_at: new Date().toISOString() })
      .eq("id", candidate.id);
    if (updateErr) throw new Error(updateErr.message);

    return new Response(JSON.stringify({ ok: true, alreadyConfirmed: false, roleName, companyName }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
