import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeDescription(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeAccount(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2026-11-26") return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function serviceHeaders(serviceKey: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: "server_configuration_incomplete" }, 503);
  }

  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return json({ error: "missing_bearer_token" }, 401);

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 100_000) return json({ error: "request_too_large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.action === "issue") {
    // Verify the caller's actual Supabase user session; the platform JWT
    // gate is disabled because the import route uses a one-time bearer token.
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` },
    });
    if (!userResponse.ok) return json({ error: "invalid_user_session" }, 401);
    const user = await userResponse.json();
    if (!user?.id) return json({ error: "invalid_user_session" }, 401);

    const adminHeaders = serviceHeaders(serviceKey);
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const rateResponse = await fetch(
      `${supabaseUrl}/rest/v1/richly_ai_import_tokens?user_id=eq.${encodeURIComponent(user.id)}&created_at=gte.${encodeURIComponent(cutoff)}&select=token_hash`,
      { headers: adminHeaders },
    );
    if (!rateResponse.ok) return json({ error: "token_issue_unavailable" }, 503);
    const recent = await rateResponse.json();
    if (Array.isArray(recent) && recent.length >= 3) {
      return json({ error: "token_issue_rate_limited", retry_after_seconds: 300 }, 429);
    }

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const oneTimeToken = toBase64Url(bytes);
    const tokenHash = await sha256(oneTimeToken);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

    // Opportunistically remove expired tokens for this user.
    await fetch(
      `${supabaseUrl}/rest/v1/richly_ai_import_tokens?user_id=eq.${encodeURIComponent(user.id)}&expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: "DELETE", headers: adminHeaders },
    );

    const insertResponse = await fetch(`${supabaseUrl}/rest/v1/richly_ai_import_tokens`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        token_hash: tokenHash,
        user_id: user.id,
        expires_at: expiresAt,
      }),
    });
    if (!insertResponse.ok) return json({ error: "token_issue_failed" }, 503);

    return json({
      token: oneTimeToken,
      expires_at: expiresAt,
      expires_in_seconds: 600,
      use_once: true,
      instruction: "Keep this token private. It authorizes one transaction-import batch only.",
    });
  }

  if (body.action === "import") {
    if (!Array.isArray(body.transactions) || body.transactions.length < 1 || body.transactions.length > 100) {
      return json({ error: "transactions_must_be_an_array_of_1_to_100_items" }, 400);
    }

    const now = new Date().toISOString();
    const prepared = [];
    for (const item of body.transactions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return json({ error: "invalid_transaction_object" }, 400);
      }
      const tx = item as Record<string, unknown>;
      const description = typeof tx.description === "string" ? tx.description.trim() : "";
      const account = typeof tx.account === "string" ? tx.account.trim() : "";
      const date = typeof tx.date === "string" ? tx.date : "";
      const amount = Number(tx.amount);
      const type = tx.type;
      const category = typeof tx.category === "string" ? tx.category.trim() : "";

      if (!description || description.length > 160 || !account || account.length > 80) {
        return json({ error: "description_or_account_invalid" }, 400);
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
        return json({ error: "amount_invalid" }, 400);
      }
      if (type !== "expense" && type !== "income") {
        return json({ error: "only_confirmed_expense_or_income_transactions_are_accepted" }, 400);
      }
      if (!validDate(date)) return json({ error: "transaction_date_invalid_or_before_2026_11_26" }, 400);
      if (type === "income" && !category) return json({ error: "income_category_required" }, 400);
      if (category.length > 60) return json({ error: "category_too_long" }, 400);

      const direction = type as string;
      const fingerprint = [
        normalizeAccount(account),
        date,
        amount.toFixed(2),
        direction,
        normalizeDescription(description),
      ].join("|");

      prepared.push({
        id: crypto.randomUUID(),
        description,
        amount,
        type,
        category: type === "expense" ? (category || "Other") : category,
        date,
        note: typeof tx.note === "string" ? tx.note.slice(0, 240) : "",
        person: "",
        payment: typeof tx.payment === "string" ? tx.payment.slice(0, 40) : "",
        account,
        imported: true,
        importSource: "chatgpt_gmail",
        importedAt: now,
        importFingerprint: fingerprint,
        ...(typeof tx.sourceMessageId === "string" ? { sourceMessageId: tx.sourceMessageId.slice(0, 160) } : {}),
      });
    }

    const tokenHash = await sha256(bearer);
    const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_richly_ai_import`, {
      method: "POST",
      headers: serviceHeaders(serviceKey),
      body: JSON.stringify({ p_token_hash: tokenHash, p_transactions: prepared }),
    });
    const resultText = await rpcResponse.text();
    if (!rpcResponse.ok) {
      // Do not expose database internals or token details to the caller.
      return json({ error: rpcResponse.status === 400 ? "invalid_or_expired_import_token" : "transaction_import_failed" }, rpcResponse.status === 400 ? 401 : 500);
    }

    let result: Record<string, unknown> = {};
    try { result = JSON.parse(resultText); } catch { /* no response body */ }
    return json({
      success: true,
      added: Number(result.added) || 0,
      duplicates: Number(result.duplicates) || 0,
      received: prepared.length,
    });
  }

  return json({ error: "unsupported_action" }, 400);
});
