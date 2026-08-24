// Sends the candidate a "confirm you want to be submitted" email right
// after a Referrer submits them. The candidate isn't a MakePlacement user
// and has no session, so this reads everything it needs server-side with
// the service role key rather than relying on the client to pass it all.
//
// Called from recruiter_dashboard.html's submitCandidate() right after the
// candidates row is inserted (status starts as "pending_confirmation").
// Requires RESEND_API_KEY (same secret notify-new-lead/notify-approved use).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NOTIFY_FROM_EMAIL = "MakePlacement <akash@makeplacement.com>";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { candidateId } = await req.json();
    if (!candidateId) throw new Error("Missing candidateId");

    const { data: candidate, error: candidateErr } = await supabaseAdmin
      .from("candidates")
      .select("id, name, email, confirmation_token, role_id")
      .eq("id", candidateId)
      .single();
    if (candidateErr || !candidate) throw new Error("Candidate not found");
    if (!candidate.email) throw new Error("Candidate has no email on file");

    const { data: role } = await supabaseAdmin
      .from("roles")
      .select("name, company_id")
      .eq("id", candidate.role_id)
      .single();

    const { data: company } = role
      ? await supabaseAdmin.from("companies").select("name").eq("id", role.company_id).single()
      : { data: null };

    const roleName = (role && role.name) || "a role";
    const companyName = (company && company.name) || "a company";
    const origin = req.headers.get("origin") || "https://makeplacement.com";
    const confirmUrl = `${origin}/confirm-candidate.html?token=${candidate.confirmation_token}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFY_FROM_EMAIL,
        to: [candidate.email],
        subject: `Confirm you're interested in the ${roleName} role at ${companyName}`,
        text: `Hi ${candidate.name || "there"},\n\nA recruiter submitted you for the ${roleName} role at ${companyName} through MakePlacement.\n\nIf you're genuinely interested in this opportunity, confirm here:\n${confirmUrl}\n\nIf you did not agree to be submitted for this role, you can safely ignore this email -- you will not be submitted unless you confirm.\n\n— MakePlacement`,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API error (${res.status}): ${body}`);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
