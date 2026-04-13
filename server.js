import express from "express";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const clean = decoded.replaceAll("\\", "/");
  const rel = clean.startsWith("/") ? clean.slice(1) : clean;
  const resolved = path.resolve(__dirname, rel || "index.html");
  if (!resolved.startsWith(__dirname)) return null;
  return resolved;
}

function mustEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function stripeServer() {
  return new Stripe(mustEnv("STRIPE_SECRET_KEY"), { apiVersion: "2024-06-20" });
}

function supabaseAdmin() {
  return createClient(mustEnv("SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

const app = express();

// CORS (so your delexo.store frontend can call the Render backend)
app.use((req, res, next) => {
  const allow = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && (allow.includes("*") || allow.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (allow.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Stripe-Signature");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Root (quick sanity check)
app.get("/", (_req, res) => res.type("text").send("support-leaderboard-backend: ok"));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Leaderboard API (used by index.html)
app.get("/leaderboard", async (req, res) => {
  try {
    const n = Number(req.query?.limit || 50);
    const limit = Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 50;
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("supporters")
      .select("display_name,note,total_cents,social_url")
      .order("total_cents", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: "db_error", detail: error.message, code: error.code });
    res.json({ rows: data || [] });
  } catch (_e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Stripe checkout (simple: single PRICE_ID)
app.post("/create-checkout-session", express.json(), async (req, res) => {
  try {
    const stripe = stripeServer();
    const siteUrl = mustEnv("SITE_URL");
    const priceId = mustEnv("PRICE_ID");
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.slice(0, 40) : "";

    // Validate the price exists early (helps diagnose test/live mismatch)
    try {
      await stripe.prices.retrieve(priceId);
    } catch (e) {
      const msg = e?.message ? String(e.message) : "invalid_price";
      const code = e?.code ? String(e.code) : undefined;
      res.status(500).json({
        error: "stripe_price_error",
        detail: msg,
        code,
        hint: "Most common cause: STRIPE_SECRET_KEY mode (test/live) doesn't match PRICE_ID.",
      });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_creation: "always",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/?thanks=1&session_id={CHECKOUT_SESSION_ID}#supporters`,
      cancel_url: `${siteUrl}/#supporters`,
      metadata: { display_name: displayName },
    });
    res.json({ url: session.url });
  } catch (e) {
    // Helpful diagnostics for setup issues (no secrets are included in these messages)
    console.error("create-checkout-session error:", e);
    const msg = (e && e.message) ? String(e.message) : "";
    if (msg.startsWith("Missing env var:")) {
      res.status(500).json({ error: "missing_env", detail: msg });
      return;
    }
    const code = e?.code ? String(e.code) : undefined;
    res.status(500).json({ error: "server_error", detail: msg || "unknown", code });
  }
});

// Save note (after payment)
app.post("/save-note", express.json(), async (req, res) => {
  try {
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : "";
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim().slice(0, 40) : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 140) : "";
    const socialUrlRaw = typeof req.body?.social_url === "string" ? req.body.social_url.trim().slice(0, 220) : "";
    if (!sessionId || !displayName) return res.status(400).json({ error: "missing_fields" });

    const stripe = stripeServer();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== "paid") return res.status(403).json({ error: "not_paid" });

    const email = session.customer_details?.email || session.customer_email;
    if (!email) return res.status(400).json({ error: "missing_email" });

    let social_url = null;
    if (socialUrlRaw) {
      try {
        const u = new URL(socialUrlRaw);
        if (u.protocol === "http:" || u.protocol === "https:") social_url = u.toString();
      } catch {
        social_url = null;
      }
    }

    // IMPORTANT:
    // - If a repeat donor leaves fields blank, do NOT wipe their existing note/link.
    // - Only include optional fields when they are explicitly provided.
    const upsertRow = { email, display_name: displayName };
    if (note) upsertRow.note = note;
    if (social_url) upsertRow.social_url = social_url;

    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("supporters")
      .upsert(upsertRow, { onConflict: "email" })
      .select("display_name,note,total_cents,social_url")
      .single();

    if (error) return res.status(500).json({ error: "db_error", detail: error.message, code: error.code });
    res.json({ supporter: data });
  } catch (e) {
    console.error("save-note error:", e);
    const msg = e?.message ? String(e.message) : "";
    if (msg.startsWith("Missing env var:")) {
      res.status(500).json({ error: "missing_env", detail: msg });
      return;
    }
    res.status(500).json({ error: "server_error", detail: msg || "unknown" });
  }
});

// Stripe webhook (Render endpoint you mentioned)
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const stripe = stripeServer();
    const whsec = mustEnv("STRIPE_WEBHOOK_SECRET");
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("missing signature");

    let evt;
    try {
      evt = stripe.webhooks.constructEvent(req.body, sig, whsec);
    } catch (_e) {
      return res.status(400).send("bad signature");
    }

    if (evt.type !== "checkout.session.completed") return res.json({ received: true });
    const session = evt.data.object;
    if (!session || session.payment_status !== "paid") return res.json({ received: true });

    const email = session.customer_details?.email || session.customer_email;
    const amountTotal = Number(session.amount_total || 0);
    const paymentIntentId = session.payment_intent;
    if (!email || !paymentIntentId || !Number.isFinite(amountTotal)) return res.json({ received: true });

    const sb = supabaseAdmin();

    const { data: supporter, error: supErr } = await sb
      .from("supporters")
      .upsert(
        {
          email,
          display_name: (session.metadata?.display_name || "Supporter").slice(0, 40),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "email" }
      )
      .select("id,total_cents")
      .single();

    if (supErr || !supporter) return res.json({ received: true });

    const { error: donErr } = await sb.from("donations").insert({
      supporter_id: supporter.id,
      amount_cents: amountTotal,
      stripe_payment_intent_id: paymentIntentId,
    });

    // Unique violation means already processed; don't double-add.
    if (donErr) return res.json({ received: true });

    await sb
      .from("supporters")
      .update({
        total_cents: (supporter.total_cents || 0) + amountTotal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", supporter.id);

    res.json({ received: true });
  } catch (_e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Final handler (no invalid "*" route in Express 5)
// On Render you typically only need the API routes above.
// If you run this locally and want it to serve the site, set SERVE_STATIC=1.
app.use(async (req, res) => {
  if (process.env.SERVE_STATIC !== "1") {
    res.status(404).type("text").send("Not found");
    return;
  }
  try {
    let filePath = safePath(req.path);
    if (!filePath) return res.status(403).send("Forbidden");

    try {
      const s = await stat(filePath);
      if (s.isDirectory()) filePath = path.join(filePath, "index.html");
    } catch (_) {}

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const data = await readFile(filePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(data);
  } catch (_e) {
    res.status(404).type("text").send("Not found");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

