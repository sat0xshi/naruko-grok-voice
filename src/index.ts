import OpenAI from "openai";
import { CallSideband } from "./call-sideband";
import { XaiCall } from "./xai-call";
import { handleXaiWebhook } from "./xai-webhook";
import {
  buildGreetingInstructions,
  buildOutboundTaskInstructions,
  DEFAULT_TASK_PURPOSE,
  DEFAULT_INBOUND_TASK_PURPOSE,
  INBOUND_TASK_GREETING,
  OUTBOUND_GENERIC_PURPOSE,
  sameCallee,
  errorMessage,
  extractDirection,
  extractPeerNumber,
  log,
  narukoHeaders,
  readTruncatedBody,
  type CallDirection,
} from "./shared";

export { CallSideband, XaiCall };

// v4: same opener with or without inbound task mode (AI disclosure up front).
const DEFAULT_GREETING = INBOUND_TASK_GREETING;
const DEFAULT_OUTBOUND =
  "Outbound call for 株式会社メタスペクト (generic / test call). Wait for the other party to answer first. " +
  "If they stay silent for about 10 seconds, then speak first. " +
  "First turn only: 「株式会社メタスペクトです。テストのお電話です。お声は聞こえますでしょうか。」 — then stop and wait for the reply. " +
  "After they reply, briefly confirm you can hear each other (one or two short sentences per turn). " +
  "Only after that exchange, close with 「ご確認ありがとうございました。失礼いたします。」. " +
  "Do not use the inbound reception line 「ご用件はいかがでしょうか」. " +
  "When the task is done (after the closing), call submit_call_summary silently and never speak the summary.";
const NARUKO_TIMEOUT_MS = 3_000;

async function forwardToNaruko(
  rawBody: ArrayBuffer,
  sourceHeaders: Headers,
  url: string,
  callId: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NARUKO_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: narukoHeaders(sourceHeaders),
      body: rawBody,
      redirect: "manual",
      signal: controller.signal,
    });
    const responseText = await readTruncatedBody(response);
    log(response.ok ? "info" : "warn", "naruko.forward.completed", {
      callId,
      status: response.status,
      responseText,
    });
  } catch (error) {
    log(
      error instanceof DOMException && error.name === "AbortError"
        ? "warn"
        : "error",
      "naruko.forward.failed",
      {
        callId,
        error:
          error instanceof DOMException && error.name === "AbortError"
            ? `Timed out after ${NARUKO_TIMEOUT_MS}ms`
            : errorMessage(error),
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function startCallSideband(
  env: Env,
  callId: string,
  callerId: string,
  instructions: string,
  direction: CallDirection,
  taskMode = false,
  purpose = "",
  inboundTask = false,
  appendInstructions = "",
): Promise<void> {
  const id = env.CALL_SIDEBAND.idFromName(callId);
  const stub = env.CALL_SIDEBAND.get(id);
  const response = await stub.fetch("https://do/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callId,
      callerId,
      instructions,
      direction,
      taskMode,
      purpose,
      inboundTask,
      appendInstructions,
    }),
  });
  const responseText = await readTruncatedBody(response);
  log(response.ok ? "info" : "error", "sideband.do.start", {
    callId,
    callerId,
    status: response.status,
    responseText,
  });
}

const FORCE_OUTBOUND_OPEN =
  "Outbound open rule (sideband also enforces this): wait for the other party's self-introduction. " +
  "If about 10 seconds pass with no speech from them, speak first. " +
  "When you speak, open with exactly: 株式会社メタスペクトです。 Then continue with the outbound task.\n\n";

async function handleIncomingCall(
  rawBody: ArrayBuffer,
  headers: Headers,
  env: Env,
  callId: string,
  peerNumber: string,
  direction: CallDirection,
): Promise<void> {
  // Inbound needs Naruko accept first. Outbound is already dialing — attach sideband ASAP.
  const forwardP = forwardToNaruko(rawBody, headers, env.NARUKO_WEBHOOK_URL, callId);
  if (direction === "inbound") {
    await forwardP;
  }

  // Opt-in outbound task mode: both secrets set AND callee matches.
  const taskInstructions = Reflect.get(env, "OUTBOUND_TASK_INSTRUCTIONS");
  const taskCallee = Reflect.get(env, "OUTBOUND_TASK_CALLEE");
  const taskMode =
    direction === "outbound" &&
    typeof taskInstructions === "string" &&
    taskInstructions.length > 0 &&
    typeof taskCallee === "string" &&
    sameCallee(peerNumber, taskCallee);
  if (direction === "outbound") {
    log("info", "outbound.task_mode", {
      callId,
      taskMode,
      taskConfigured:
        typeof taskInstructions === "string" && taskInstructions.length > 0,
    });
  }

  // Opt-in inbound task mode (v3): secret present → append the task script to
  // Naruko's inbound instructions. Never gated on caller ID.
  const inboundTaskText = Reflect.get(env, "INBOUND_TASK_INSTRUCTIONS");
  const inboundTask =
    direction === "inbound" &&
    typeof inboundTaskText === "string" &&
    inboundTaskText.trim().length > 0;
  if (direction === "inbound") {
    log("info", "inbound.task_mode", { callId, inboundTask });
  }

  let base: string;
  if (taskMode) {
    base = String(taskInstructions);
  } else if (direction === "outbound") {
    const outboundOverride = Reflect.get(env, "OUTBOUND_INSTRUCTIONS");
    const task =
      typeof outboundOverride === "string" && outboundOverride.length > 0
        ? outboundOverride
        : DEFAULT_OUTBOUND;
    base = FORCE_OUTBOUND_OPEN + task;
  } else {
    const greetingOverride = Reflect.get(env, "GREETING_INSTRUCTIONS");
    base =
      typeof greetingOverride === "string" && greetingOverride.length > 0
        ? greetingOverride
        : inboundTask
          ? INBOUND_TASK_GREETING
          : DEFAULT_GREETING;
  }
  // Purpose for the call memo (and the in-call summary tool).
  const taskPurpose = Reflect.get(env, "OUTBOUND_TASK_PURPOSE");
  const inboundPurpose = Reflect.get(env, "INBOUND_TASK_PURPOSE");
  const purpose = inboundTask
    ? typeof inboundPurpose === "string" && inboundPurpose.trim()
      ? inboundPurpose.trim()
      : DEFAULT_INBOUND_TASK_PURPOSE
    : taskMode
    ? typeof taskPurpose === "string" && taskPurpose.trim()
      ? taskPurpose.trim()
      : DEFAULT_TASK_PURPOSE
    : direction === "outbound"
      ? OUTBOUND_GENERIC_PURPOSE
      : "";
  const instructions = taskMode
    ? buildOutboundTaskInstructions(base, peerNumber, purpose)
    : buildGreetingInstructions(base, peerNumber, direction, purpose);

  try {
    await startCallSideband(
      env,
      callId,
      peerNumber,
      instructions,
      direction,
      taskMode,
      purpose,
      inboundTask,
      inboundTask ? String(inboundTaskText) : "",
    );
  } catch (error) {
    log("error", "openai.sideband.failed", {
      callId,
      peerNumber,
      direction,
      error: errorMessage(error),
    });
  }

  if (direction === "outbound") {
    await forwardP;
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/xai/webhook") {
      return handleXaiWebhook(request, env, ctx);
    }
    if (pathname !== "/" && pathname !== "/openai/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    if (
      !env.OPENAI_API_KEY ||
      !env.OPENAI_WEBHOOK_SECRET ||
      !env.NARUKO_WEBHOOK_URL ||
      !env.CALL_SIDEBAND
    ) {
      log("error", "worker.configuration_missing");
      return new Response("Server configuration error", { status: 500 });
    }

    const rawBody = await request.arrayBuffer();
    const rawText = new TextDecoder().decode(rawBody);
    const openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      webhookSecret: env.OPENAI_WEBHOOK_SECRET,
    });

    let event;
    try {
      event = await openai.webhooks.unwrap(rawText, request.headers);
    } catch (error) {
      log("warn", "openai.webhook.invalid", {
        error: errorMessage(error),
      });
      return new Response("Invalid webhook", { status: 400 });
    }

    if (event.type !== "realtime.call.incoming") {
      return Response.json({ ok: true });
    }

    const callId = event.data.call_id;
    const sipHeaders = (event.data as { sip_headers?: unknown }).sip_headers;
    const direction = extractDirection(sipHeaders);
    const peerNumber = extractPeerNumber(sipHeaders, direction);
    const webhookId = request.headers.get("webhook-id") ?? undefined;
    log("info", "call.incoming", {
      callId,
      direction,
      peerNumber,
      webhookId,
    });
    ctx.waitUntil(
      handleIncomingCall(
        rawBody,
        request.headers,
        env,
        callId,
        peerNumber,
        direction,
      ).catch((error) => {
        log("error", "call.background_task_failed", {
          callId,
          direction,
          peerNumber,
          error: errorMessage(error),
        });
      }),
    );

    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<Env>;
