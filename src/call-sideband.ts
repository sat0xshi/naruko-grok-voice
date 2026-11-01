import { DurableObject } from "cloudflare:workers";
import type { ResponseCreateEvent } from "openai/resources/realtime/realtime";
import {
  BARGE_IN_SUSTAIN_MS,
  END_CALL_TOOL,
  INBOUND_TASK_MARKER,
  INBOUND_TASK_OUTCOME_KEYS,
  composeInboundTaskInstructions,
  enrichInboundTaskSummary,
  matchesInboundTaskSwitch,
  OUTBOUND_GENERIC_PURPOSE,
  REALTIME_AUDIO_INPUT,
  SUBMIT_CALL_SUMMARY_TOOL,
  WAIT_SILENTLY_TOOL,
  audioInputMatches,
  describeAudioInput,
  enrichOutboundSummary,
  firstAssistantLine,
  mergeSummaries,
  type CallContext,
  type CallDirection,
  type CallSummary,
  errorMessage,
  formatTokyoIso,
  log,
  normalizeSummary,
  readTruncatedBody,
  brand,
  setBrand,
} from "./shared";
import { buildTranscriptFields, type TranscriptLine } from "./transcript";

const ALARM_MS = 8 * 60_000;
// Task mode: alarm every 60 s (< 70 s DO inactivity window) so a long hold
// never lets the DO be evicted; also drives the 30-min nudge / 40-min cap.
const TASK_ALARM_MS = 60_000;
const TASK_NUDGE_MS = 30 * 60_000;
const TASK_HARD_CAP_MS = 40 * 60_000;
const TASK_NO_SPEECH_MS = 20_000;
const END_CALL_DELAY_MS = 4_000;
const COMPLETIONS_MODEL = "gpt-4.1-mini";

type StartBody = {
  callId: string;
  callerId: string;
  instructions: string;
  direction?: CallDirection;
  taskMode?: boolean;
  /** Outbound purpose for the memo (task purpose or generic). */
  purpose?: string;
  /** Inbound task mode (v3): append `appendInstructions` to Naruko's instructions. */
  inboundTask?: boolean;
  appendInstructions?: string;
};

const OUTBOUND_SILENCE_MS = 10_000;

// First outbound turn: introduce + one purpose sentence, then STOP and wait.
// (The old text "…テストコールです。 then a short voice check" made the model
// run the whole check and declare the test finished in one breath.)
const OUTBOUND_FIRST_UTTERANCE =
  "Speak now in Japanese (do not wait further). Say only your self-introduction and ONE short sentence about the purpose, " +
  "for a generic/test call exactly: {{COMPANY}}です。テストのお電話です。お声は聞こえますでしょうか。 " +
  "Then stop and wait for the other party's reply. In this turn do NOT thank them, do NOT say goodbye and do NOT say the test/call is finished. " +
  "Do not use the inbound reception line.";
// Max extra session.update re-sends when the effective session (e.g. after a
// Naruko-side update) lost our transcription language / VAD settings.
const MAX_AUDIO_REASSERTS = 3;

const TX_PREFIX = "tx:";
const txKey = (index: number): string =>
  `${TX_PREFIX}${String(index).padStart(6, "0")}`;

export class CallSideband extends DurableObject<Env> {
  protected sendBranded(data: string): void {
    this.socket?.send(brand(data));
  }

  protected socket: WebSocket | null = null;
  protected callId = "";
  protected callerId = "非通知";
  protected startedAt = "";
  protected transcripts: TranscriptLine[] = [];
  protected toolsEnabled = false;
  protected summaryPosted = false;
  protected running = false;
  protected closingHandled = false;
  protected handledToolCalls = new Set<string>();
  protected pendingGreeting = "";
  protected greetingSent = false;
  protected heardAssistant = false;
  protected greetingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  protected silenceTimer: ReturnType<typeof setTimeout> | null = null;
  protected direction: CallDirection = "inbound";
  protected taskMode = false;
  protected startedAtMs = 0;
  protected peerSpokeOnce = false;
  protected waitSilentlyCount = 0;
  protected hangupRequested = false;
  protected taskSessionResent = false;
  protected purpose = "";
  protected inboundTask = false;
  protected appendInstructions = "";
  /** Naruko's own session instructions (null until seen in session.created/updated). */
  protected nativeInstructions: string | null = null;
  protected inboundAppendAttempts = 0;
  protected inboundAppendOk = false;
  protected inboundSwitchNudged = false;
  protected outboundSilenceArmed = false;
  protected audioReasserts = 0;
  // Debounced barge-in state (interrupt_response=false; see shared.ts).
  protected responseActive = false;
  protected audioPlaying = false;
  protected sawAudioBufferEvents = false;
  protected responseStartedMs = 0;
  protected playbackUntilMs = 0;
  protected bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  protected finalizePromise: Promise<void> | null = null;

  async fetch(request: Request): Promise<Response> {
    setBrand(this.env);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      let body: StartBody;
      try {
        body = (await request.json()) as StartBody;
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      if (!body.callId || !body.instructions) {
        return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });
      }

      const already = await this.ctx.storage.get<boolean>("started");
      if (already || this.running) {
        log("info", "sideband.start.idempotent", { callId: body.callId });
        return Response.json({ ok: true, already: true });
      }

      this.callId = body.callId;
      this.callerId = body.callerId || "非通知";
      this.direction = body.direction === "outbound" ? "outbound" : "inbound";
      this.taskMode = this.direction === "outbound" && body.taskMode === true;
      this.purpose =
        typeof body.purpose === "string" && body.purpose.trim()
          ? body.purpose.trim()
          : this.direction === "outbound"
            ? OUTBOUND_GENERIC_PURPOSE
            : "";
      this.inboundTask =
        this.direction === "inbound" &&
        body.inboundTask === true &&
        typeof body.appendInstructions === "string" &&
        body.appendInstructions.trim().length > 0;
      this.appendInstructions = this.inboundTask ? String(body.appendInstructions) : "";
      this.startedAt = formatTokyoIso();
      this.startedAtMs = Date.now();
      await this.ctx.storage.put({
        started: true,
        callId: this.callId,
        callerId: this.callerId,
        startedAt: this.startedAt,
        direction: this.direction,
        taskMode: this.taskMode,
        startedAtMs: this.startedAtMs,
        purpose: this.purpose,
        inboundTask: this.inboundTask,
        appendInstructions: this.appendInstructions,
      });

      this.ctx.waitUntil(
        this.runSideband(body.instructions).catch((error) => {
          log("error", "sideband.run.failed", {
            callId: this.callId,
            error: errorMessage(error),
          });
        }),
      );

      return Response.json({ ok: true, already: false });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const stored = await this.ctx.storage.get([
        "started",
        "summaryPosted",
        "callId",
        "callerId",
        "summaryVia",
        "direction",
      ]);
      return Response.json({
        ok: true,
        running: this.running,
        toolsEnabled: this.toolsEnabled,
        transcriptCount: this.transcripts.length,
        started: stored.get("started") ?? false,
        summaryPosted: stored.get("summaryPosted") ?? false,
        callId: stored.get("callId") ?? null,
        callerId: stored.get("callerId") ?? null,
        summaryVia: stored.get("summaryVia") ?? null,
        direction: stored.get("direction") ?? this.direction,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  protected alarmIntervalMs(): number {
    return this.taskMode || this.inboundTask ? TASK_ALARM_MS : ALARM_MS;
  }

  async alarm(): Promise<void> {
    if (!this.running || !this.socket) {
      return;
    }
    const elapsedMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
    log("info", "sideband.alarm.keepalive", {
      callId: this.callId,
      transcriptCount: this.transcripts.length,
      taskMode: this.taskMode,
      elapsedSec: Math.round(elapsedMs / 1000),
      waitSilentlyCount: this.waitSilentlyCount,
    });
    if (this.taskMode && this.startedAtMs) {
      if (elapsedMs >= TASK_HARD_CAP_MS) {
        log("warn", "task.hard_cap_hangup", { callId: this.callId });
        await this.hangupCall("hard_cap_40min");
        return;
      }
      if (
        elapsedMs >= TASK_NUDGE_MS &&
        (await this.ctx.storage.get<boolean>("nudged30")) !== true
      ) {
        await this.ctx.storage.put("nudged30", true);
        log("info", "task.nudge_30min", { callId: this.callId });
        this.sendBranded(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions:
                "System note: 発信から約30分が経過しました。まだ人間のオペレーターにつながっておらず保留・自動音声のままなら、何も言わずに end_call ツールを呼び出して終了してください。" +
                "人間のオペレーターと会話中なら、そのまま用件を続けてください（このメモは読み上げない）。",
            },
          }),
        );
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + this.alarmIntervalMs());
  }

  protected async hangupCall(reason: string): Promise<void> {
    if (this.hangupRequested) {
      return;
    }
    this.hangupRequested = true;
    try {
      const response = await fetch(
        `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(this.callId)}/hangup`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
        },
      );
      const text = await readTruncatedBody(response, 500);
      log(response.ok ? "info" : "warn", "task.hangup", {
        callId: this.callId,
        reason,
        status: response.status,
        responseText: text,
      });
    } catch (error) {
      log("error", "task.hangup_failed", {
        callId: this.callId,
        reason,
        error: errorMessage(error),
      });
    }
  }

  protected async runSideband(instructions: string): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.summaryPosted =
      (await this.ctx.storage.get<boolean>("summaryPosted")) === true;

    const stored = await this.ctx.storage.get([
      "callId",
      "callerId",
      "startedAt",
      "direction",
      "taskMode",
      "startedAtMs",
      "purpose",
      "inboundTask",
      "appendInstructions",
    ]);
    this.callId = (stored.get("callId") as string | undefined) ?? this.callId;
    this.callerId =
      (stored.get("callerId") as string | undefined) ?? this.callerId;
    this.startedAt =
      (stored.get("startedAt") as string | undefined) ??
      this.startedAt ??
      formatTokyoIso();
    const storedDirection = stored.get("direction") as string | undefined;
    if (storedDirection === "outbound" || storedDirection === "inbound") {
      this.direction = storedDirection;
    }
    this.taskMode =
      this.direction === "outbound" && stored.get("taskMode") === true;
    this.startedAtMs =
      (stored.get("startedAtMs") as number | undefined) ?? this.startedAtMs ?? Date.now();
    this.purpose = (stored.get("purpose") as string | undefined) ?? this.purpose;
    this.inboundTask =
      this.direction === "inbound" && stored.get("inboundTask") === true;
    this.appendInstructions =
      (stored.get("appendInstructions") as string | undefined) ?? this.appendInstructions;
    if (!this.appendInstructions) {
      this.inboundTask = false;
    }
    await this.restoreTranscripts();

    const apiKey = this.env.OPENAI_API_KEY;
    const wsUrl = `https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.callId)}`;
    const response = await fetch(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Upgrade: "websocket",
      },
    });
    const socket = response.webSocket;
    if (!socket) {
      const responseText = await readTruncatedBody(response);
      this.running = false;
      throw new Error(
        `OpenAI WebSocket handshake failed (${response.status}): ${responseText}`,
      );
    }

    this.socket = socket;
    await new Promise<void>((resolve) => {
      const finish = (
        event: string,
        fields: Record<string, unknown> = {},
      ): void => {
        if (this.closingHandled) {
          return;
        }
        this.closingHandled = true;
        log("info", event, { callId: this.callId, ...fields });
        resolve();
      };

      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") {
          return;
        }
        void this.onServerEvent(message.data).catch((error) => {
          log("warn", "sideband.event_handler_failed", {
            callId: this.callId,
            error: errorMessage(error),
          });
        });
      });

      socket.addEventListener("close", (event) => {
        void this.finalizeOnce("close", event.code, event.reason)
          .catch((error) => {
            log("error", "sideband.close_handler_failed", {
              callId: this.callId,
              error: errorMessage(error),
            });
          })
          .finally(() => {
            finish("openai.sideband.closed", {
              code: event.code,
              reason: event.reason,
            });
          });
      });

      socket.addEventListener("error", () => {
        log("error", "openai.sideband.socket_error", { callId: this.callId });
        // Still deliver the memo (deferred tool summary + full transcript).
        void this.finalizeOnce("socket_error", 0, "")
          .catch((error) => {
            log("error", "sideband.error_finalize_failed", {
              callId: this.callId,
              error: errorMessage(error),
            });
          })
          .finally(() => {
            finish("openai.sideband.ended_after_error");
          });
      });

      socket.accept();
      this.pendingGreeting = instructions;
      // Task mode: no scripted greeting; the session instructions drive the
      // whole call (IVR/hold first, then the operator line).
      this.greetingSent = this.taskMode;
      this.heardAssistant = false;
      this.sendSessionUpdate();
      // Greeting waits for session.updated so outbound media is ready.
      void this.ctx.storage.setAlarm(Date.now() + this.alarmIntervalMs());
      log("info", "openai.sideband.attached", {
        callId: this.callId,
        callerId: this.callerId,
      });
    });

    this.running = false;
    this.socket = null;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // ignore
    }
  }

  protected sendSessionUpdate(): void {
    if (!this.socket) {
      return;
    }
    const tools = this.taskMode
      ? [SUBMIT_CALL_SUMMARY_TOOL, WAIT_SILENTLY_TOOL, END_CALL_TOOL]
      : this.inboundTask
        ? [SUBMIT_CALL_SUMMARY_TOOL, WAIT_SILENTLY_TOOL]
        : [SUBMIT_CALL_SUMMARY_TOOL];
    // Outbound (task AND generic): this Worker owns the session instructions
    // (Japanese rule + turn rules), so a platform-side opener script cannot
    // make the bot finish the call in one breath. Inbound keeps Naruko's.
    const ownInstructions = this.direction === "outbound";
    // Inbound task: Naruko's instructions + our task block (only once we have
    // read Naruko's instructions from session.created/updated).
    const inboundTaskInstructions =
      this.inboundTask && this.nativeInstructions !== null
        ? composeInboundTaskInstructions(
            this.nativeInstructions,
            this.appendInstructions,
            this.callerId,
            this.purpose,
          )
        : null;
    const event = {
      type: "session.update",
      session: {
        type: "realtime",
        ...(ownInstructions ? { instructions: this.pendingGreeting } : {}),
        ...(inboundTaskInstructions !== null
          ? { instructions: inboundTaskInstructions }
          : {}),
        audio: {
          input: REALTIME_AUDIO_INPUT,
        },
        tools,
        tool_choice: "auto",
      },
    };
    this.sendBranded(JSON.stringify(event));
    this.toolsEnabled = true;
    log("info", "openai.sideband.session_update_sent", {
      callId: this.callId,
      tools: tools.map((t) => t.name),
      taskMode: this.taskMode,
      ownInstructions,
      inboundTask: this.inboundTask,
      inboundTaskAppended: inboundTaskInstructions !== null,
      transcriptionLanguage: REALTIME_AUDIO_INPUT.transcription.language,
      turnDetection: REALTIME_AUDIO_INPUT.turn_detection,
    });
  }

  protected clearGreetingRetry(): void {
    if (this.greetingRetryTimer !== null) {
      clearTimeout(this.greetingRetryTimer);
      this.greetingRetryTimer = null;
    }
  }

  protected clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  protected armOutboundSilenceWait(): void {
    if (this.outboundSilenceArmed || this.greetingSent || this.heardAssistant) {
      return;
    }
    this.outboundSilenceArmed = true;
    this.clearSilenceTimer();
    log("info", "openai.sideband.outbound_silence_armed", {
      callId: this.callId,
      ms: OUTBOUND_SILENCE_MS,
    });
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.heardAssistant && !this.greetingSent) {
        log("info", "openai.sideband.outbound_silence_fire", {
          callId: this.callId,
        });
        this.ensureGreeting("silence_10s");
      }
    }, OUTBOUND_SILENCE_MS);
  }

  protected onPeerSpoke(): void {
    if (this.direction !== "outbound" || this.heardAssistant || this.greetingSent) {
      return;
    }
    this.clearSilenceTimer();
    if (this.responseActive) {
      // server_vad already auto-created a reply (session instructions carry the
      // opener rules); a second response.create would collide / double-speak.
      this.greetingSent = true;
      log("info", "openai.sideband.greeting_skipped_auto_response", {
        callId: this.callId,
      });
      return;
    }
    this.ensureGreeting("peer_spoke");
  }

  protected ensureGreeting(reason: string): void {
    if (!this.socket || !this.pendingGreeting || this.heardAssistant) {
      return;
    }
    if (this.greetingSent && reason === "session.updated") {
      return;
    }
    if (this.greetingSent && reason !== "retry") {
      return;
    }
    const instructions =
      this.direction === "outbound"
        ? `${OUTBOUND_FIRST_UTTERANCE}\n\n${this.pendingGreeting}`
        : this.pendingGreeting;
    this.sendGreeting(instructions, reason);
    this.greetingSent = true;
    this.clearSilenceTimer();
    this.clearGreetingRetry();
    this.greetingRetryTimer = setTimeout(() => {
      if (!this.heardAssistant && this.socket && this.pendingGreeting) {
        log("warn", "openai.sideband.greeting_retry", {
          callId: this.callId,
        });
        this.sendGreeting(
          this.direction === "outbound"
            ? `${OUTBOUND_FIRST_UTTERANCE}\n\n${this.pendingGreeting}`
            : this.pendingGreeting,
          "retry",
        );
      }
    }, 2_500);
  }

  protected sendGreeting(instructions: string, reason = "initial"): void {
    if (!this.socket) {
      return;
    }
    const event: ResponseCreateEvent = {
      type: "response.create",
      response: { instructions },
    };
    this.sendBranded(JSON.stringify(event));
    log("info", "openai.sideband.response_create_sent", {
      callId: this.callId,
      reason,
      direction: this.direction,
    });
  }

  protected async onServerEvent(raw: string): Promise<void> {
    let serverEvent: unknown;
    try {
      serverEvent = JSON.parse(raw);
    } catch (error) {
      log("warn", "openai.sideband.invalid_event", {
        callId: this.callId,
        error: errorMessage(error),
      });
      return;
    }
    if (
      typeof serverEvent !== "object" ||
      serverEvent === null ||
      !("type" in serverEvent)
    ) {
      return;
    }

    const event = serverEvent as Record<string, unknown>;
    const type = String(event.type);

    if (type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      const message =
        typeof err?.message === "string"
          ? err.message
          : JSON.stringify(err ?? {});
      log("warn", "openai.sideband.server_error", {
        callId: this.callId,
        message,
      });
      if (/tool|session|instruction/i.test(message)) {
        this.toolsEnabled = false;
        log("warn", "sideband.tools_disabled_fallback", {
          callId: this.callId,
        });
      }
      return;
    }

    if (type === "session.created") {
      log("info", "openai.sideband.session_created", {
        callId: this.callId,
        ...describeAudioInput(event.session),
      });
      this.maybeAppendInboundTask(event.session);
      return;
    }

    if (type === "session.updated") {
      const matches = audioInputMatches(event.session);
      log("info", "openai.sideband.session_updated", {
        callId: this.callId,
        direction: this.direction,
        audioConfigOk: matches,
        ...describeAudioInput(event.session),
      });
      if (!matches && this.audioReasserts < MAX_AUDIO_REASSERTS) {
        // Someone (e.g. Naruko) replaced transcription language / VAD: re-assert.
        this.audioReasserts += 1;
        log("warn", "openai.sideband.audio_config_reassert", {
          callId: this.callId,
          attempt: this.audioReasserts,
        });
        setTimeout(() => this.sendSessionUpdate(), 300);
      }
      this.maybeAppendInboundTask(event.session);
      if (this.taskMode) {
        if (!this.taskSessionResent) {
          // Insurance against a later Naruko session.update overwriting our
          // instructions/tools: re-assert once after a few seconds.
          this.taskSessionResent = true;
          this.armTaskNoSpeechWait();
          setTimeout(() => {
            log("info", "task.session_update_resend", { callId: this.callId });
            this.sendSessionUpdate();
          }, 5_000);
        }
      } else if (this.direction === "outbound") {
        this.armOutboundSilenceWait();
      } else {
        this.ensureGreeting("session.updated");
      }
      return;
    }

    if (type === "input_audio_buffer.dtmf_event_received") {
      log("info", "task.dtmf_received", { callId: this.callId, event: event.event });
      return;
    }

    if (type === "response.created") {
      this.responseActive = true;
      this.responseStartedMs = Date.now();
      return;
    }

    if (type === "response.done") {
      this.responseActive = false;
      return;
    }

    if (type === "output_audio_buffer.started") {
      this.sawAudioBufferEvents = true;
      this.audioPlaying = true;
      return;
    }

    if (
      type === "output_audio_buffer.stopped" ||
      type === "output_audio_buffer.cleared"
    ) {
      this.sawAudioBufferEvents = true;
      this.audioPlaying = false;
      this.playbackUntilMs = 0;
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      if (this.bargeInTimer !== null) {
        clearTimeout(this.bargeInTimer);
        this.bargeInTimer = null;
        const s = Number(event.audio_end_ms) - Number(this.lastSpeechStartAudioMs);
        log("info", "bargein.ignored_short", {
          callId: this.callId,
          speechMs: Number.isFinite(s) ? s : null,
        });
      }
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.peerSpokeOnce = true;
      this.lastSpeechStartAudioMs = Number(event.audio_start_ms);
      this.armBargeIn();
      if (this.direction === "outbound") {
        this.clearSilenceTimer();
        log("info", "openai.sideband.outbound_peer_speech_started", {
          callId: this.callId,
        });
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript =
        typeof event.transcript === "string" ? event.transcript.trim() : "";
      if (transcript) {
        this.pushTranscript({ role: "caller", text: transcript });
        this.onPeerSpoke();
        this.maybeNudgeInboundSwitch(transcript);
        log("info", "sideband.transcript.caller", {
          callId: this.callId,
          chars: transcript.length,
          ...(this.taskMode
            ? { text: transcript, tSec: this.elapsedSec() }
            : {}),
        });
      }
      return;
    }

    if (
      type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done"
    ) {
      const transcript =
        typeof event.transcript === "string" ? event.transcript.trim() : "";
      if (transcript) {
        this.heardAssistant = true;
        this.clearGreetingRetry();
        if (!this.sawAudioBufferEvents && this.responseStartedMs) {
          // No output_audio_buffer.* events: estimate playback end (~140 ms/char).
          this.playbackUntilMs = Math.max(
            this.playbackUntilMs,
            this.responseStartedMs + [...transcript].length * 140 + 500,
          );
        }
        this.pushTranscript({ role: "assistant", text: transcript });
        log("info", "sideband.transcript.assistant", {
          callId: this.callId,
          chars: transcript.length,
          ...(this.taskMode
            ? { text: transcript, tSec: this.elapsedSec() }
            : {}),
        });
      }
      return;
    }

    if (type === "response.output_text.done") {
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text) {
        this.heardAssistant = true;
        this.clearGreetingRetry();
        this.pushTranscript({ role: "assistant", text });
      }
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const name = typeof event.name === "string" ? event.name : "";
      const callId = typeof event.call_id === "string" ? event.call_id : "";
      const argsRaw =
        typeof event.arguments === "string" ? event.arguments : "{}";
      if (name === "submit_call_summary" && callId) {
        await this.handleSubmitCallSummary(callId, argsRaw);
      } else if ((this.taskMode || this.inboundTask) && callId && name === "wait_silently") {
        this.handleWaitSilently(callId, argsRaw);
      } else if (this.taskMode && callId && name === "end_call") {
        this.handleEndCall(callId, argsRaw);
      }
      return;
    }

    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (
        item &&
        item.type === "function_call" &&
        item.name === "submit_call_summary" &&
        typeof item.call_id === "string" &&
        typeof item.arguments === "string"
      ) {
        await this.handleSubmitCallSummary(item.call_id, item.arguments);
      } else if (
        (this.taskMode || this.inboundTask) &&
        item &&
        item.type === "function_call" &&
        typeof item.call_id === "string"
      ) {
        const args = typeof item.arguments === "string" ? item.arguments : "{}";
        if (item.name === "wait_silently") {
          this.handleWaitSilently(item.call_id, args);
        } else if (this.taskMode && item.name === "end_call") {
          this.handleEndCall(item.call_id, args);
        }
      }
    }
  }

  protected lastSpeechStartAudioMs = 0;

  /**
   * Inbound task: when the caller's transcript contains a switch word
   * (定期/解約…), add a one-time system item so the
   * next turn follows the callback flow even if the model misheard. No
   * response.create (server VAD already answers the turn).
   */
  protected maybeNudgeInboundSwitch(transcript: string): void {
    if (!this.inboundTask || this.inboundSwitchNudged || !this.socket) {
      return;
    }
    if (!matchesInboundTaskSwitch(transcript)) {
      return;
    }
    this.inboundSwitchNudged = true;
    log("info", "inbound_task.switch_detected", { callId: this.callId });
    this.sendBranded(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "System note (do not read aloud): 相手の発言に切り替えキーワード（定期/解約 等）が含まれました。" +
                "まだなら「{{TASK}}の対応」に切り替えてください（最初は「折り返しありがとうございます。私は{{OWNER}}のAIアシスタントの{{ASSISTANT}}です。…ご契約の内容をお伝えしてもよろしいでしょうか。」）。" +
                "すでに切り替え済みなら、この注記は無視して会話を続けてください。",
            },
          ],
        },
      }),
    );
  }

  /**
   * Inbound task mode: once Naruko's instructions are visible, re-send the
   * session with them + our task block (marker). Re-appends (max 3) if a later
   * session.updated shows the block was overwritten.
   */
  protected maybeAppendInboundTask(session: unknown): void {
    if (!this.inboundTask || !this.socket) {
      return;
    }
    const raw =
      typeof session === "object" && session !== null
        ? (session as { instructions?: unknown }).instructions
        : undefined;
    const instr = typeof raw === "string" ? raw : "";
    if (instr.includes(INBOUND_TASK_MARKER)) {
      if (!this.inboundAppendOk) {
        this.inboundAppendOk = true;
        log("info", "inbound_task.instructions_ok", {
          callId: this.callId,
          instructionsChars: instr.length,
        });
      }
      return;
    }
    if (this.inboundAppendAttempts >= 3) {
      return;
    }
    this.inboundAppendAttempts += 1;
    this.inboundAppendOk = false;
    this.nativeInstructions = instr;
    log("info", "inbound_task.instructions_append", {
      callId: this.callId,
      attempt: this.inboundAppendAttempts,
      nativeChars: instr.length,
    });
    this.sendSessionUpdate();
  }

  protected isBotSpeaking(): boolean {
    return (
      this.responseActive ||
      this.audioPlaying ||
      Date.now() < this.playbackUntilMs
    );
  }

  /**
   * Debounced barge-in: the server no longer interrupts on VAD start
   * (interrupt_response=false). Cut the bot off only when the other party's
   * speech lasts BARGE_IN_SUSTAIN_MS without a speech_stopped, so back-channel
   * sounds (はい/ええ/あっ), coughs and short line noise don't stop it.
   */
  protected armBargeIn(): void {
    if (this.bargeInTimer !== null || !this.isBotSpeaking()) {
      return;
    }
    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = null;
      if (!this.socket || !this.isBotSpeaking()) {
        return;
      }
      log("info", "bargein.cancel", {
        callId: this.callId,
        responseActive: this.responseActive,
        audioPlaying: this.audioPlaying,
        sustainMs: BARGE_IN_SUSTAIN_MS,
      });
      if (this.responseActive) {
        this.sendBranded(JSON.stringify({ type: "response.cancel" }));
      }
      this.sendBranded(JSON.stringify({ type: "output_audio_buffer.clear" }));
      this.audioPlaying = false;
      this.playbackUntilMs = 0;
    }, BARGE_IN_SUSTAIN_MS);
  }

  protected callContext(): CallContext {
    return {
      direction: this.direction,
      peerNumber: this.callerId,
      purpose: this.purpose,
      botIntro: firstAssistantLine(this.transcripts),
    };
  }

  protected elapsedSec(): number {
    return this.startedAtMs ? Math.round((Date.now() - this.startedAtMs) / 1000) : 0;
  }

  protected armTaskNoSpeechWait(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.peerSpokeOnce && !this.heardAssistant && this.socket) {
        log("info", "task.no_speech_hello", { callId: this.callId });
        this.sendBranded(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions:
                "まだ相手が何も話していません。「もしもし」と一度だけ短く言って、あとは相手の応答を待ってください。",
            },
          }),
        );
      }
    }, TASK_NO_SPEECH_MS);
  }

  /** No-op tool: acknowledge without triggering a new (spoken) response. */
  protected handleWaitSilently(toolCallId: string, argsRaw: string): void {
    if (this.handledToolCalls.has(toolCallId)) {
      return;
    }
    this.handledToolCalls.add(toolCallId);
    this.waitSilentlyCount += 1;
    let reason = "";
    try {
      reason = String((JSON.parse(argsRaw) as { reason?: unknown }).reason ?? "");
    } catch {
      reason = "";
    }
    log("info", "task.wait_silently", {
      callId: this.callId,
      reason,
      count: this.waitSilentlyCount,
      tSec: this.elapsedSec(),
    });
    this.sendBranded(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ ok: true }),
        },
      }),
    );
  }

  protected handleEndCall(toolCallId: string, argsRaw: string): void {
    if (this.handledToolCalls.has(toolCallId)) {
      return;
    }
    this.handledToolCalls.add(toolCallId);
    let reason = "";
    try {
      reason = String((JSON.parse(argsRaw) as { reason?: unknown }).reason ?? "");
    } catch {
      reason = "";
    }
    log("info", "task.end_call_requested", {
      callId: this.callId,
      reason,
      tSec: this.elapsedSec(),
    });
    this.sendBranded(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ ok: true, hanging_up: true }),
        },
      }),
    );
    // Let the closing words finish playing before hanging up.
    setTimeout(() => {
      void this.hangupCall(`model:${reason}`.slice(0, 120));
    }, END_CALL_DELAY_MS);
  }

  protected async handleSubmitCallSummary(
    toolCallId: string,
    argsRaw: string,
  ): Promise<void> {
    if (this.handledToolCalls.has(toolCallId)) {
      return;
    }
    this.handledToolCalls.add(toolCallId);

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const summary = normalizeSummary(parsed, {
      callId: this.callId,
      callerId: this.callerId,
      startedAt: this.startedAt || formatTokyoIso(),
      direction: this.direction,
    });

    // Deferred: the memo is posted once at hangup together with the complete
    // transcript (avoids a second, confusing memo). A later tool call overwrites
    // this with a more complete summary.
    await this.ctx.storage.put("pendingToolSummary", summary);
    log("info", "sideband.tool_summary.deferred", {
      callId: this.callId,
      toolCallId,
      transcriptCount: this.transcripts.length,
    });
    this.sendFunctionCallOutput(toolCallId, {
      ok: true,
      recorded: true,
    });
  }

  protected pushTranscript(line: TranscriptLine): void {
    const index = this.transcripts.length;
    this.transcripts.push(line);
    void this.ctx.storage.put(txKey(index), line).catch((error) => {
      log("warn", "sideband.transcript.persist_failed", {
        callId: this.callId,
        index,
        error: errorMessage(error),
      });
    });
  }

  /** Reload persisted lines (DO restore). Keeps whichever copy is longer. */
  protected async restoreTranscripts(): Promise<void> {
    try {
      const stored = await this.ctx.storage.list<TranscriptLine>({
        prefix: TX_PREFIX,
      });
      const lines = [...stored.values()].filter(
        (l) => l && (l.role === "caller" || l.role === "assistant") && typeof l.text === "string",
      );
      if (lines.length > this.transcripts.length) {
        this.transcripts = lines;
      }
    } catch (error) {
      log("warn", "sideband.transcript.restore_failed", {
        callId: this.callId,
        error: errorMessage(error),
      });
    }
  }

  protected finalizeOnce(
    trigger: "close" | "socket_error",
    code: number,
    reason: string,
  ): Promise<void> {
    if (!this.finalizePromise) {
      this.finalizePromise = this.onSocketClosed(code, reason, trigger);
    }
    return this.finalizePromise;
  }

  protected sendFunctionCallOutput(
    toolCallId: string,
    output: Record<string, unknown>,
  ): void {
    if (!this.socket) {
      return;
    }
    this.sendBranded(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify(output),
        },
      }),
    );
    // Text-only so the summary is never spoken to the caller.
    this.sendBranded(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["text"],
          instructions: this.taskMode
            ? "Do not speak. The call summary was saved silently. If you have already said the closing greeting (ありがとうございました。失礼いたします。), call the end_call tool now; otherwise wait quietly."
            : "Do not speak to the caller. The call summary was saved silently. Wait quietly for the caller or the end of the call.",
        },
      }),
    );
    log("info", "sideband.function_call_output_sent", {
      callId: this.callId,
      toolCallId,
    });
  }

  protected async onSocketClosed(
    code: number,
    reason: string,
    trigger: "close" | "socket_error" = "close",
  ): Promise<void> {
    log("info", "sideband.hangup_signal", {
      callId: this.callId,
      trigger,
      code,
      reason,
      transcriptCount: this.transcripts.length,
      summaryPosted: this.summaryPosted,
      toolsEnabled: this.toolsEnabled,
    });

    if (this.summaryPosted) {
      return;
    }

    await this.restoreTranscripts();
    const pending = await this.ctx.storage.get<CallSummary>("pendingToolSummary");
    // Always summarise the FULL transcript when there is one: a mid-call
    // submit_call_summary can be premature (it fired after the first line in
    // the 2026-10-03 test → 宛先/用件/名乗り = 不明). Tool values only fill gaps.
    let via: "tool" | "ws_close_fallback" | "tool+transcript";
    let summary: CallSummary;
    const fromTx = await this.summarizeFromTranscript();
    const extra: Record<string, unknown> = fromTx.extra ?? {};
    if (pending && fromTx.ok && this.transcripts.length > 0) {
      summary = mergeSummaries(fromTx.summary, pending);
      via = "tool+transcript";
    } else if (pending) {
      summary = pending;
      via = "tool";
    } else {
      summary = fromTx.summary;
      via = "ws_close_fallback";
    }
    summary = enrichOutboundSummary(summary, this.callContext());
    if (this.inboundTask) {
      summary = enrichInboundTaskSummary(summary, extra, this.callContext());
      log("info", "inbound_task.summary", {
        callId: this.callId,
        タスク該当: summary.タスク該当 ?? null,
        keys: INBOUND_TASK_OUTCOME_KEYS.filter((k) => summary[k] && summary[k] !== "不明"),
      });
    }
    const withTranscript = await this.attachTranscript(summary);
    await this.postGrokSummary(withTranscript, via);
  }

  protected async attachTranscript(summary: CallSummary): Promise<CallSummary> {
    try {
      const fields = await buildTranscriptFields(
        this.transcripts,
        {
          callId: this.callId,
          direction: this.direction,
          peer: summary.着信番号 || this.callerId,
          startedAt: this.startedAt || summary.時刻 || formatTokyoIso(),
        },
        {
          bucket: this.env.TRANSCRIPTS,
          bucketName: this.env.TRANSCRIPTS_BUCKET_NAME,
          viewerBaseUrl: this.env.TRANSCRIPT_VIEWER_BASE_URL,
          logError: (event, fields) => log("error", event, fields),
        },
      );
      return { ...summary, ...fields };
    } catch (error) {
      // Last resort: never lose the text.
      log("error", "transcript.attach_failed", {
        callId: this.callId,
        error: errorMessage(error),
      });
      return {
        ...summary,
        全文: this.transcripts
          .map((l) => `${l.role === "caller" ? "相手" : "ボット"}：${l.text}`)
          .join("\n"),
      };
    }
  }

  protected async summarizeFromTranscript(): Promise<{
    summary: CallSummary;
    ok: boolean;
    extra?: Record<string, unknown>;
  }> {
    const defaults = {
      callId: this.callId,
      callerId: this.callerId,
      startedAt: this.startedAt || formatTokyoIso(),
      direction: this.direction,
    };
    const peerLabel =
      this.direction === "outbound" ? "相手" : "発信者";
    const directionJa =
      this.direction === "outbound" ? "発信（こちらからかけた）" : "着信（相手からかかってきた）";

    const cc = this.callContext();
    const purpose = cc.purpose || OUTBOUND_GENERIC_PURPOSE;
    const contextJa =
      this.direction === "outbound"
        ? `こちら（{{COMPANY}}の電話ボット）から発信先「${this.callerId}」へかけた電話です。用件は「${purpose}」。` +
          `ボットの最初の発話（こちらの名乗り）は「${cc.botIntro || "なし"}」。` +
          `「宛先」は発信先の相手（会社名・部署・担当者が分かればそれ、分からなければ「${this.callerId}」）。` +
          `「用件」は用件「${purpose}」の結果（完了/未完了、相手の回答、受付番号・日付、次のアクション）を簡潔に。` +
          "「名乗り」は相手が名乗った会社名・担当者名（名乗らなければ「不明」）。"
        : this.inboundTask
          ? `この番号には「${cc.purpose}」の電話がかかってくる想定で、ボットは{{OWNER}}のAIアシスタント「{{ASSISTANT}}」として対応する指示を受けていました。` +
            "相手がこの件（例: {{TASK}}）で電話してきた場合は「タスク該当」を「はい」、それ以外は「いいえ」。" +
            "追加キー（必ず含める、不明なら「不明」）: 「タスク該当」「解約結果」（完了／受付のみ／不可／本人連絡が必要 など）「解約日」（解約の効力日・どのお届けから止まるか）" +
            "「手数料」（差額・違約金の有無と金額）「受付番号」「担当者名」「本人連絡の要否」（本人が電話する必要があるか）" +
            "「折り返し希望時間帯」（{{OWNER}}から折り返す場合の相手の都合の良い時間帯）「折り返し先番号」（{{OWNER}}が電話すべき番号）。" +
            "「宛先」は伝言の宛先（タスク該当なら「{{OWNER}}」）、「用件」は結果の要約、「名乗り」は相手の会社名・担当者名。"
          : "";

    if (this.transcripts.length === 0) {
      return { ok: false, summary: normalizeSummary(
        {
          宛先: "不明",
          用件: "通話内容の文字起こしなし（短時間切断の可能性）",
          折り返し希望: "不明",
          名乗り: "不明",
          着信番号: this.callerId,
          時刻: defaults.startedAt,
        },
        defaults,
      ) };
    }

    const transcriptText = this.transcripts
      .map(
        (line) =>
          `${line.role === "caller" ? peerLabel : this.direction === "outbound" ? "ボット（{{COMPANY}}）" : "Naruko"}: ${line.text}`,
      )
      .join("\n");

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: brand(JSON.stringify({
            model: COMPLETIONS_MODEL,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  `あなたは電話の要約係です。この通話は${directionJa}です。${contextJa}文字起こしから JSON だけを返してください。` +
                  'キーは必ず「宛先」「用件」「折り返し希望」「名乗り」「着信番号」「時刻」。' +
                  `「着信番号」には相手番号（既定「${this.callerId}」）を入れる。時刻は「${defaults.startedAt}」を使う。` +
                  "不明な項目は「不明」。読み上げ用の文は不要です。",
              },
              {
                role: "user",
                content: transcriptText.slice(0, 12_000),
              },
            ],
          })),
        },
      );
      const bodyText = await response.text();
      if (!response.ok) {
        log("warn", "sideband.completions.failed", {
          callId: this.callId,
          status: response.status,
          body: bodyText.slice(0, 500),
        });
        return { ok: false, summary: normalizeSummary(
          {
            宛先: "不明",
            用件: transcriptText.slice(0, 500),
            折り返し希望: "不明",
            名乗り: "不明",
            着信番号: this.callerId,
            時刻: defaults.startedAt,
          },
          defaults,
        ) };
      }
      const json = JSON.parse(bodyText) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return { ok: true, summary: normalizeSummary(parsed, defaults), extra: parsed };
    } catch (error) {
      log("warn", "sideband.completions.error", {
        callId: this.callId,
        error: errorMessage(error),
      });
      return { ok: false, summary: normalizeSummary(
        {
          宛先: "不明",
          用件: transcriptText.slice(0, 500),
          折り返し希望: "不明",
          名乗り: "不明",
          着信番号: this.callerId,
          時刻: defaults.startedAt,
        },
        defaults,
      ) };
    }
  }

  protected async postGrokSummary(
    summary: CallSummary,
    via: "tool" | "ws_close_fallback" | "tool+transcript",
  ): Promise<boolean> {
    if (this.summaryPosted) {
      log("info", "grok.summary.deduped", { callId: this.callId, via });
      return true;
    }

    const claimed = await this.ctx.blockConcurrencyWhile(async () => {
      const already =
        (await this.ctx.storage.get<boolean>("summaryPosted")) === true;
      if (already) {
        return false;
      }
      await this.ctx.storage.put("summaryPosted", true);
      return true;
    });

    if (!claimed) {
      this.summaryPosted = true;
      log("info", "grok.summary.deduped", { callId: this.callId, via });
      return true;
    }

    this.summaryPosted = true;

    const url = this.env.GROK_WEBHOOK_URL;
    const auth = this.env.GROK_WEBHOOK_AUTH;
    if (!url || !auth) {
      log("error", "grok.summary.config_missing", {
        callId: this.callId,
        via,
        hasUrl: Boolean(url),
        hasAuth: Boolean(auth),
      });
      await this.ctx.storage.delete("summaryPosted");
      this.summaryPosted = false;
      return false;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth}`,
        },
        body: brand(JSON.stringify(summary)),
      });
      const responseText = await readTruncatedBody(response);
      log(response.ok ? "info" : "warn", "grok.summary.posted", {
        callId: this.callId,
        via,
        status: response.status,
        responseText,
        direction: summary.direction,
        宛先: summary.宛先,
        発信目的: summary.発信目的 ?? null,
        用件Chars: summary.用件.length,
        全文Chars: summary.全文_文字数 ?? null,
        全文Inline: typeof summary.全文 === "string",
        全文Stored: summary.全文_保存先 ?? null,
      });
      if (!response.ok) {
        await this.ctx.storage.delete("summaryPosted");
        this.summaryPosted = false;
        return false;
      }
      await this.ctx.storage.put("summaryVia", via);
      return true;
    } catch (error) {
      log("error", "grok.summary.failed", {
        callId: this.callId,
        via,
        error: errorMessage(error),
      });
      await this.ctx.storage.delete("summaryPosted");
      this.summaryPosted = false;
      return false;
    }
  }
}
