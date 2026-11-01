// xAI Grok Voice SIP path: Naruko -> FreeSWITCH (Vultr) -> sip.voice.x.ai -> webhook here.
// Reuses CallSideband's transcript persistence + summary/memo posting (same destination).
import { CallSideband } from "./call-sideband";
import {
  JAPANESE_RULE,
  errorMessage,
  formatTokyoIso,
  log,
  readTruncatedBody,
  type CallDirection,
  brand,
  setBrand,
} from "./shared";

export const XAI_GREETING = "お電話ありがとうございます。{{COMPANY}}のAIアシスタントです。ご用件をお伺いいたします。";

const STAFF_RULE =
  "Internal staff (uchi/soto keigo): {{OWNER}} and every other {{COMPANY}} staff member are OUR side. " +
  "Never add さん/様 to them and never use honorific verbs for their actions (no {{OWNER}}さん, {{OWNER}}様, いらっしゃいます, おっしゃいます). " +
  "Refer to them plainly and humbly: 「{{OWNER}}」「担当の{{OWNER}}」「{{OWNER}}より折り返しご連絡いたします」「{{OWNER}}は只今席を外しております」. " +
  "Use honorifics only for the caller and the caller's company.";

const CLOSING_RULE =
  "Ending the call (strict): before closing, ALWAYS ask 「その他ご用件はございませんでしょうか。」 and wait for the answer. " +
  "If the caller has another matter, continue helping. Only when the caller says there is nothing else, say exactly " +
  "「お電話ありがとうございました。失礼いたします。」 and then call the end_call tool (silently, never read it aloud). " +
  "After the closing line say NOTHING more: never announce that the call is ending/ended (no 「通話は終了しております」 etc.), never respond again. Never end or hang up abruptly, and never call end_call before saying that closing line. If the caller says goodbye first, still say the closing line before end_call.";

const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description: "Hang up the phone call. Call ONLY right after you have said 「お電話ありがとうございました。失礼いたします。」 following the caller confirming they have no other matters.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
};

// Distilled from 3 Japanese business phone-manner guides; see naruko-pbx/phone-manners.md.
const MANNERS_RULE =
  "Phone manners: never say もしもし/はーい; answer 「はい」. Repeat the caller's company and name: 「〇〇の〇〇様でいらっしゃいますね。いつもお世話になっております。」 (いらっしゃる for the caller, never ございます). " +
  "If no name was given: 「恐れ入りますが、お名前をお伺いしてもよろしいでしょうか。」 (never お名前を頂戴). If hard to hear: 「恐れ入ります、少しお電話が遠いようですので、もう一度お願いいたします。」 never blame the caller. " +
  "Read callback numbers back digit by digit in groups (e.g. ゼロキュウゼロ、イチニサンヨン、ゴロクナナハチ) and confirm; also confirm dates/times. " +
  "Cushion words (恐れ入りますが / 差し支えなければ / あいにく / 申し訳ございませんが) ONLY when asking a favor or declining; never put them before repeating back or confirming the caller's info (say e.g. 「〇〇様でいらっしゃいますね」 directly). " +
  "If the caller asks for {{OWNER}}: 「申し訳ございません。あいにく{{OWNER}}は只今電話に出ることができません。よろしければ、{{OWNER}}より折り返しご連絡いたしましょうか。」 then take the message (name, company, callback number, preferred time, matter) and repeat it back; say 「{{OWNER}}に申し伝えます」. " +
  "Never give out staff phone numbers or personal details (「本人に確認のうえ、必要な場合は折り返しご連絡いたします」). If you cannot answer: 「確認のうえ、折り返しご連絡いたします」. " +
  "Avoid よろしかったでしょうか (use よろしいでしょうか), 〜のほう, とんでもございません. If the caller is upset, first acknowledge (「さようでございましたか」). " +
  "Outbound: 「お世話になっております。{{COMPANY}}でございます。」, state the purpose in one sentence, ask 「ただいまお時間よろしいでしょうか。」; if the person is out, ask when they return and say we will call again.";

const NAME_RULE =
  "Caller names: never guess, complete or romanize a caller's name or company. Write and repeat names only exactly as heard in Japanese; " +
  "if unsure, politely ask the caller to repeat or spell it (「恐れ入ります、お名前をもう一度お願いできますでしょうか。」). If still unclear, record it as 不明.";

export const XAI_OUTBOUND_PURPOSE_DEFAULT = "サービスの解約をしたいのですが、どのようにすればよいでしょうか。";

export function outboundGreeting(purpose?: string): string {
  return `お世話になっております。{{COMPANY}}のAIアシスタントです。${(purpose || XAI_OUTBOUND_PURPOSE_DEFAULT).trim()}`;
}

export function buildXaiInstructions(base: string, peer: string, direction: CallDirection, purpose?: string): string {
  if (direction === "outbound") {
    base =
      "You are the AI assistant of {{COMPANY}} and YOU placed this phone call (it is an outbound call, not a reception). " +
      `Your purpose: ${(purpose || XAI_OUTBOUND_PURPOSE_DEFAULT)}. ` +
      "After your opening line, listen to the other party, answer their questions, and pursue the purpose politely. " +
      "Do not act as a reception desk and do not ask 「ご用件をお伺いいたします」. If asked, say you are an AI assistant calling on behalf of {{COMPANY}}.";
  }
  const note =
    direction === "outbound"
      ? `System note (do not read aloud): これは発信通話です。発信先番号は「${peer}」です。`
      : `System note (do not read aloud): この通話の着信番号（発信者番号）は「${peer}」です。` +
        "「非通知」の場合は折り返し用の電話番号を相手に確認してください。";
  return `${base}\n\n${JAPANESE_RULE}\n\n${NAME_RULE}\n\n${STAFF_RULE}\n\n${MANNERS_RULE}\n\n${CLOSING_RULE}\n\n` +
    "Keep each turn short (one or two sentences) and wait for the caller. If the caller starts speaking while you talk, stop immediately and listen.\n\n" +
    note;
}

type XaiStart = { callId: string; callerId: string; direction: CallDirection; instructions: string };

export class XaiCall extends CallSideband {
  private itemIndex = new Map<string, number>();
  /** True once xAI sent session.created/updated (a real call). Fake/expired call_ids never post a memo. */
  private gotSession = false;
  private speechStoppedMs = 0;

  /** Retry a failed memo post (e.g. destination rate limit) every 2 min, up to 15 times. */
  async alarm(): Promise<void> {
    const tries = (await this.ctx.storage.get<number>("summaryRetries")) ?? -1;
    if (tries >= 0 && !(await this.ctx.storage.get<boolean>("summaryPosted"))) {
      await this.restoreFromStorage();
      this.finalizePromise = null;
      await this.onSocketClosed(0, "retry", "close");
      if (!(await this.ctx.storage.get<boolean>("summaryPosted")) && tries < 15) {
        await this.ctx.storage.put("summaryRetries", tries + 1);
        await this.ctx.storage.setAlarm(Date.now() + 120_000);
      }
      log("info", "xai.summary.retry", { callId: this.callId, tries });
      return;
    }
    return super.alarm();
  }

  private async restoreFromStorage(): Promise<void> {
    const st = await this.ctx.storage.get(["callId", "callerId", "startedAt", "direction", "startedAtMs"]);
    this.callId = (st.get("callId") as string) ?? this.callId;
    this.callerId = (st.get("callerId") as string) ?? this.callerId;
    this.startedAt = (st.get("startedAt") as string) ?? this.startedAt;
    this.direction = (st.get("direction") as CallDirection) ?? this.direction;
    this.summaryPosted = false;
    await this.restoreTranscripts();
  }

  private async scheduleRetryIfNeeded(): Promise<void> {
    if (!(await this.ctx.storage.get<boolean>("summaryPosted"))) {
      if ((await this.ctx.storage.get<number>("summaryRetries")) === undefined) {
        await this.ctx.storage.put("summaryRetries", 0);
      }
      await this.ctx.storage.setAlarm(Date.now() + 120_000);
      log("warn", "xai.summary.retry_scheduled", { callId: this.callId });
    }
  }

  async fetch(request: Request): Promise<Response> {
    setBrand(this.env);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/resend") {
      await this.restoreFromStorage();
      if (!this.callId) return Response.json({ ok: false, error: "unknown_call" }, { status: 404 });
      if (await this.ctx.storage.get<boolean>("summaryPosted")) return Response.json({ ok: true, already: true });
      this.finalizePromise = null;
      await this.onSocketClosed(0, "manual_resend", "close");
      const posted = (await this.ctx.storage.get<boolean>("summaryPosted")) === true;
      if (!posted) await this.scheduleRetryIfNeeded();
      return Response.json({ ok: posted, transcriptCount: this.transcripts.length });
    }
    if (request.method !== "POST" || url.pathname !== "/start") {
      return new Response("Not found", { status: 404 });
    }
    const body = (await request.json()) as XaiStart;
    if ((await this.ctx.storage.get<boolean>("started")) || this.running) {
      return Response.json({ ok: true, already: true });
    }
    this.callId = body.callId;
    this.callerId = body.callerId || "非通知";
    this.direction = body.direction;
    this.startedAt = formatTokyoIso();
    this.startedAtMs = Date.now();
    await this.ctx.storage.put({
      started: true, callId: this.callId, callerId: this.callerId,
      startedAt: this.startedAt, direction: this.direction, startedAtMs: this.startedAtMs, provider: "xai",
    });
    this.ctx.waitUntil(this.runXai(body.instructions).catch((e) =>
      log("error", "xai.run.failed", { callId: this.callId, error: errorMessage(e) })));
    return Response.json({ ok: true, already: false });
  }

  private async runXai(instructions: string): Promise<void> {
    this.running = true;
    const res = await fetch(`https://api.x.ai/v1/realtime?call_id=${encodeURIComponent(this.callId)}&reasoning.effort=none`, {
      headers: { Authorization: `Bearer ${this.env.XAI_API_KEY}`, Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (!ws) {
      this.running = false;
      throw new Error(`xAI WebSocket handshake failed (${res.status}): ${await readTruncatedBody(res)}`);
    }
    this.socket = ws;
    await new Promise<void>((resolve) => {
      const done = (trigger: "close" | "socket_error", code: number, reason: string) => {
        if (this.hangupTimer) { clearTimeout(this.hangupTimer); this.hangupTimer = null; log("info", "xai.caller_hung_up_first", { callId: this.callId }); }
        this.closingHandled = true;
        const fin = this.gotSession
          ? this.finalizeOnce(trigger, code, reason)
          : Promise.resolve(log("warn", "xai.closed_without_session", { callId: this.callId, code, reason }));
        void fin
          .catch((e) => log("error", "xai.finalize_failed", { callId: this.callId, error: errorMessage(e) }))
          .finally(() => { log("info", "xai.closed", { callId: this.callId, code, reason }); resolve(); });
      };
      ws.addEventListener("message", (m) => {
        if (typeof m.data === "string") {
          try { this.onXaiEvent(m.data); } catch (e) {
            log("warn", "xai.event_failed", { callId: this.callId, error: errorMessage(e) });
          }
        }
      });
      ws.addEventListener("close", (e) => done("close", e.code, e.reason));
      ws.addEventListener("error", () => done("socket_error", 0, ""));
      ws.accept();
      this.send({
        type: "session.update",
        session: {
          instructions,
          voice: this.env.XAI_VOICE || "Ara",
          reasoning: { effort: "none" },
          turn_detection: { type: "server_vad" },
          audio: { input: { transcription: { language_hint: "ja", keyterms: ["{{COMPANY}}", "{{OWNER}}"] } } },
        },
      });
      // Tools in a separate update so a schema mismatch can never drop the instructions above.
      this.send({ type: "session.update", session: { tools: [END_CALL_TOOL] } });
      this.send({
        type: "response.create",
        response: { instructions: `Say exactly this Japanese sentence and nothing else, then wait for the other party: ${
          this.direction === "outbound" ? outboundGreeting(this.env.XAI_OUTBOUND_PURPOSE) : XAI_GREETING
        }` },
      });
      void this.ctx.storage.setAlarm(Date.now() + 8 * 60_000);
      log("info", "xai.attached", { callId: this.callId, callerId: this.callerId, direction: this.direction });
    });
    this.running = false;
    this.socket = null;
    try { await this.ctx.storage.deleteAlarm(); } catch { /* ignore */ }
    if (this.gotSession) await this.scheduleRetryIfNeeded();
  }

  private endCallRequested = false;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private onEndCall(toolCallId: string): void {
    if (this.endCallRequested) return;
    this.endCallRequested = true;
    log("info", "xai.end_call_requested", { callId: this.callId });
    // Stay silent after the closing line: no tool result (it would trigger a reply), turn off VAD auto-replies.
    void toolCallId;
    this.send({ type: "session.update", session: { turn_detection: { type: null } } });
    // Closing line (~3.5 s of audio) plays out, then wait 10 s more so the caller hangs up first.
    this.hangupTimer = setTimeout(() => {
      this.hangupTimer = null;
      if (!this.socket || this.closingHandled) return; // caller already hung up
      void fetch(`https://api.x.ai/v1/realtime/calls/${encodeURIComponent(this.callId)}/hangup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.env.XAI_API_KEY}` },
      }).then((r) => log(r.ok ? "info" : "warn", "xai.hangup", { callId: this.callId, status: r.status }))
        .catch((e) => log("error", "xai.hangup_failed", { callId: this.callId, error: errorMessage(e) }));
    }, 13_500);
  }

  private send(event: Record<string, unknown>): void {
    this.socket?.send(brand(JSON.stringify(event)));
  }

  private onXaiEvent(raw: string): void {
    const ev = JSON.parse(raw) as Record<string, unknown>;
    const type = String(ev.type ?? "");
    switch (type) {
      case "response.created":
        if (this.endCallRequested) {
          // Suppress anything generated after end_call (e.g. "通話は終了しております").
          this.send({ type: "response.cancel" });
          log("info", "xai.post_end_response_cancelled", { callId: this.callId });
          return;
        }
        this.responseActive = true;
        return;
      case "response.done":
        this.responseActive = false;
        return;
      case "input_audio_buffer.speech_started":
        // Barge-in is handled server-side by xAI (live test 2026-10-15: our response.cancel got
        // "no active response" and output_audio_buffer.clear is "Invalid event"), so only log.
        if (this.responseActive) log("info", "xai.barge_in", { callId: this.callId });
        return;
      case "input_audio_buffer.speech_stopped":
        this.speechStoppedMs = Date.now();
        return;
      case "response.output_audio.delta":
        if (this.speechStoppedMs) {
          log("info", "xai.latency", { callId: this.callId, ms: Date.now() - this.speechStoppedMs });
          this.speechStoppedMs = 0;
        }
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        const itemId = typeof ev.item_id === "string" ? ev.item_id : "";
        if (text) this.upsertLine(itemId, { role: "caller", text });
        return;
      }
      case "response.output_audio_transcript.done": {
        const text = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        const itemId = typeof ev.item_id === "string" ? `a:${ev.item_id}` : "";
        if (text) this.upsertLine(itemId, { role: "assistant", text });
        return;
      }
      case "response.function_call_arguments.done":
        if (ev.name === "end_call") this.onEndCall(String(ev.call_id ?? ""));
        return;
      case "error":
        log("warn", "xai.server_error", { callId: this.callId, error: JSON.stringify(ev.error ?? ev).slice(0, 400) });
        return;
      case "session.created":
        this.gotSession = true;
        return;
      case "session.updated":
        this.gotSession = true;
        log("info", "xai.session_updated", { callId: this.callId });
        return;
    }
  }

  /** Only the LAST transcription per item_id counts (xAI repeats `completed`). */
  private upsertLine(itemId: string, line: { role: "caller" | "assistant"; text: string }): void {
    const existing = itemId ? this.itemIndex.get(itemId) : undefined;
    if (existing !== undefined) {
      this.transcripts[existing] = line;
      void this.ctx.storage.put(`tx:${String(existing).padStart(6, "0")}`, line);
      return;
    }
    if (itemId) this.itemIndex.set(itemId, this.transcripts.length);
    this.pushTranscript(line);
  }
}
