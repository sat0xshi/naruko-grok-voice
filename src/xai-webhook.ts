import { buildXaiInstructions } from "./xai-call";
import { INBOUND_FALLBACK_RECEPTION, errorMessage, extractDirection, extractPeerNumber, log } from "./shared";

const TOLERANCE_SEC = 300;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard Webhooks (whsec_) verification. */
export async function verifyStandardWebhook(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > TOLERANCE_SEC) return false;
  const key = await crypto.subtle.importKey("raw", b64ToBytes(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  const enc = new TextEncoder();
  return sigHeader.split(" ").some((part) => {
    const [ver, sig] = part.split(",", 2);
    if (ver !== "v1" || !sig) return false;
    const a = enc.encode(sig), b = enc.encode(expected);
    return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  });
}

/** +81XXXXXXXXX -> 0XXXXXXXXX for Japanese numbers. */
function jpLocal(n: string): string {
  return n.replace(/^\+?81(?=[1-9]\d{8,9}$)/, "0");
}

export async function handleXaiWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.XAI_API_KEY || !env.XAI_WEBHOOK_SECRET || !env.XAI_CALL) {
    log("error", "xai.configuration_missing");
    return new Response("Server configuration error", { status: 500 });
  }
  const body = await request.text();
  if (!(await verifyStandardWebhook(env.XAI_WEBHOOK_SECRET, request.headers, body))) {
    log("warn", "xai.webhook.invalid_signature");
    return new Response("Invalid webhook", { status: 400 });
  }
  let event: { type?: string; data?: { call_id?: string; sip_headers?: unknown } };
  try { event = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }
  if (event.type === "internal.resend_summary" && event.data?.call_id) {
    // Same whsec_ signature as xAI; used by the operator to re-post a memo that failed.
    const r = await env.XAI_CALL.get(env.XAI_CALL.idFromName(event.data.call_id)).fetch("https://do/resend", { method: "POST" });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (event.type !== "realtime.call.incoming" || !event.data?.call_id) {
    log("info", "xai.webhook.ignored", { type: event.type });
    return Response.json({ ok: true });
  }
  const callId = event.data.call_id;
  const direction = extractDirection(event.data.sip_headers);
  const peer = jpLocal(extractPeerNumber(event.data.sip_headers, direction));
  log("info", "xai.call.incoming", { callId, direction, peer, webhookId: request.headers.get("webhook-id") });
  const base = env.XAI_INSTRUCTIONS || INBOUND_FALLBACK_RECEPTION;
  const instructions = buildXaiInstructions(base, peer, direction, env.XAI_OUTBOUND_PURPOSE);
  const stub = env.XAI_CALL.get(env.XAI_CALL.idFromName(callId));
  ctx.waitUntil(
    stub.fetch("https://do/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, callerId: peer, direction, instructions }),
    }).then(async (r) => log(r.ok ? "info" : "error", "xai.do.start", { callId, status: r.status, body: (await r.text()).slice(0, 200) }))
      .catch((e) => log("error", "xai.do.start_failed", { callId, error: errorMessage(e) })),
  );
  return Response.json({ ok: true });
}
