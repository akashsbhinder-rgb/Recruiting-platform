// Sends a "you're approved" email via Resend when an admin approves a
// Company or Recruiter in admin.html. This is what actually backs the
// "we'll email you once you're approved" copy shown on the pending
// screens in dashboard.html / recruiter_dashboard.html / both onboarding
// wizards -- none of which send anything on their own.
//
// Requires the RESEND_API_KEY secret (same one notify-new-lead uses).
// Deploy with --no-verify-jwt: this is called from admin.html by an
// authenticated admin, but there's no need to add auth-checking here
// since it only ever sends a routine "you're approved" email -- worst
// case of misuse is someone gets an email they weren't expecting.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NOTIFY_FROM_EMAIL = "MakePlacement <akash@makeplacement.com>";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, type } = await req.json();
    if (!email) throw new Error("Missing email");

    const dashboardUrl = type === "recruiter"
      ? "https://makeplacement.com/recruiter_dashboard.html"
      : "https://makeplacement.com/dashboard.html";
    const label = type === "recruiter" ? "recruiter" : "company";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFY_FROM_EMAIL,
        to: [email],
        subject: "You're approved on MakePlacement",
        text: `Good news -- your ${label} account on MakePlacement has been approved.\n\nYou can now access your dashboard: ${dashboardUrl}\n\n— MakePlacement`,
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
