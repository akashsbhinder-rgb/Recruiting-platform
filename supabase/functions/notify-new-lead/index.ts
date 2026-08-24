// Sends an email via Resend when a new lead is captured on index.html
// (someone fills in name + work email but hasn't necessarily finished
// signing up yet). Called directly from the client right after the
// `leads` row is inserted -- no user session exists at that point, so
// this function is deployed with --no-verify-jwt.
//
// Requires the RESEND_API_KEY secret, set via:
//   supabase secrets set RESEND_API_KEY=re_xxxxx
// And a "from" address on a domain verified in your Resend account --
// see NOTIFY_FROM_EMAIL below.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NOTIFY_TO_EMAILS = ["akashmplacement@gmail.com", "akash@makeplacement.com"];
// Resend requires the "from" address to be on a domain you've verified in
// your Resend account -- makeplacement.com is verified, so this sends as
// the same mailbox used for other outgoing mail.
const NOTIFY_FROM_EMAIL = "MakePlacement Leads <akash@makeplacement.com>";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { type, firstName, lastName, email } = await req.json();
    if (!email) throw new Error("Missing email");

    const typeLabel = type === "company" ? "Company" : type === "search_firm" ? "Search firm / recruiter" : type || "Unknown";
    const name = [firstName, lastName].filter(Boolean).join(" ") || "(no name given)";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFY_FROM_EMAIL,
        to: NOTIFY_TO_EMAILS,
        subject: `New lead: ${name} (${typeLabel})`,
        text: `New lead captured on MakePlacement.\n\nType: ${typeLabel}\nName: ${name}\nEmail: ${email}\n\nThey haven't necessarily finished signing up yet -- this fires as soon as they fill in their name and work email.`,
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
    // Never let a notification failure block the actual lead capture on
    // the client side -- this always returns 200-shaped errors in the
    // body rather than a failing status, and the caller in index.html
    // ignores the result either way.
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
