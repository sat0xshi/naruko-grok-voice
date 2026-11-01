import type { TranscriptFields } from "./transcript";

const LOG_BODY_LIMIT_BYTES = 2_048;

export type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ level, event, ...fields }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CallDirection = "inbound" | "outbound";

function sipHeaderValue(sipHeaders: unknown, name: string): string {
  if (!Array.isArray(sipHeaders)) {
    return "";
  }
  const want = name.toLowerCase();
  const hit = sipHeaders.find(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      "name" in h &&
      String((h as { name: unknown }).name).toLowerCase() === want,
  ) as { value?: unknown } | undefined;
  return typeof hit?.value === "string" ? hit.value : "";
}

export function normalizePhoneToken(raw: string): string {
  if (!raw) {
    return "非通知";
  }
  const lower = raw.toLowerCase();
  if (
    lower.includes("anonymous") ||
    lower.includes("unavailable") ||
    lower.includes("unknown")
  ) {
    return "非通知";
  }
  const tel = raw.match(/\+?[0-9][0-9\-\s]{8,}/);
  if (tel) {
    return tel[0].replace(/[\s\-]/g, "");
  }
  const sipUser = raw.match(/sip:([^@>;]+)/i);
  if (sipUser && /\d{8,}/.test(sipUser[1])) {
    return sipUser[1];
  }
  return "非通知";
}

export function extractDirection(sipHeaders: unknown): CallDirection {
  const raw = sipHeaderValue(sipHeaders, "X-Naruko-Direction").toLowerCase();
  return raw === "outbound" ? "outbound" : "inbound";
}

export function extractCallerId(sipHeaders: unknown): string {
  const narukoCaller = normalizePhoneToken(
    sipHeaderValue(sipHeaders, "X-Naruko-Caller"),
  );
  if (narukoCaller !== "非通知") {
    return narukoCaller;
  }
  return normalizePhoneToken(sipHeaderValue(sipHeaders, "From"));
}

/** Peer for summary: inbound=caller, outbound=callee. */
export function extractPeerNumber(
  sipHeaders: unknown,
  direction: CallDirection,
): string {
  if (direction === "outbound") {
    const callee = normalizePhoneToken(
      sipHeaderValue(sipHeaders, "X-Naruko-Callee"),
    );
    if (callee !== "非通知") {
      return callee;
    }
  }
  return extractCallerId(sipHeaders);
}

/** Appended to every instruction set this Worker owns: always Japanese. */
export const JAPANESE_RULE =
  "Language: always speak natural, polite Japanese (丁寧語). Never switch to English, Korean or any other language, " +
  "even if the other party's audio is unclear; if you cannot understand, ask in Japanese 「恐れ入ります、もう一度お願いできますでしょうか。」.";

/**
 * Generic (non-task) outbound turn rules. Appended AFTER the base/override
 * instructions so they win over older scripts (e.g. "voice check, brief
 * thanks, and end" in one breath).
 */
export const OUTBOUND_TURN_RULES =
  "Turn rules for this outbound call (highest priority, do not read aloud):\n" +
  "1) First turn: introduce yourself (「株式会社メタスペクトです。」) plus ONE short sentence about why you are calling " +
  "(generic/test call: 「テストのお電話です。お声は聞こえますでしょうか。」), then STOP and wait for the other party's reply.\n" +
  "2) Never say the call/test is finished, never thank them for their time and never say goodbye in the first turn or before the other party has replied at least once.\n" +
  "3) Keep every turn short (one or two sentences) and wait for the reply. Short back-channel sounds (はい / ええ / うん) are not a request to stop — continue naturally.\n" +
  "4) Only after the purpose is completed in conversation, say a short closing such as 「ご確認ありがとうございました。失礼いたします。」.\n" +
  "5) Call submit_call_summary silently only at the very end (after the closing), never read it aloud.";

export function buildGreetingInstructions(
  base: string,
  peerNumber: string,
  direction: CallDirection = "inbound",
  purpose = "",
): string {
  if (direction === "outbound") {
    return (
      `${base}\n\n${OUTBOUND_TURN_RULES}\n\n${JAPANESE_RULE}\n\n` +
      `System note (do not read aloud): これは発信通話（こちらから相手へかけた電話）です。発信先番号は「${peerNumber}」、用件は「${purpose || OUTBOUND_GENERIC_PURPOSE}」です。` +
      `相手の名乗りを先に待ってください。約10秒無音ならこちらから話し始めてください。` +
      `要約の「宛先」には発信先（相手の会社名・担当者名が分かればそれと番号「${peerNumber}」）、「着信番号」には発信先番号「${peerNumber}」を入れてください（発信でもこのキー名を使う）。` +
      `「用件」には用件「${purpose || OUTBOUND_GENERIC_PURPOSE}」とその結果、「名乗り」には相手の名乗り（会社名・担当者名）を書いてください。` +
      `用件が終わったら読み上げずに submit_call_summary ツールだけを呼び出してください。`
    );
  }
  return (
    `${base}\n\n` +
    `System note (do not read aloud): この通話の着信番号（発信者番号）は「${peerNumber}」です。` +
    `通話後の要約・記録には必ず「着信番号: ${peerNumber}」を含めてください。` +
    `「非通知」の場合は折り返し用の電話番号を相手に確認し、取れなければ着信番号は「非通知」と書いてください。` +
    `用件がまとまったら読み上げずに submit_call_summary ツールだけを呼び出してください。`
  );
}

export function formatTokyoIso(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

export function narukoHeaders(source: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      lower === "content-type" ||
      lower.startsWith("webhook-") ||
      lower.startsWith("openai-")
    ) {
      forwarded.set(name, value);
    }
  }
  return forwarded;
}

export async function readTruncatedBody(
  response: Response,
  limit = LOG_BODY_LIMIT_BYTES,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = limit - size;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    if (size === limit && !truncated) {
      const next = await reader.read();
      truncated = !next.done;
    }
  } finally {
    if (truncated) {
      await reader.cancel();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return `${new TextDecoder().decode(bytes)}${truncated ? "…" : ""}`;
}

export type CallSummary = {
  direction: CallDirection;
  宛先: string;
  用件: string;
  折り返し希望: string;
  名乗り: string;
  /** Peer phone: inbound=caller, outbound=callee. Kept as 着信番号 for webhook compat. */
  着信番号: string;
  時刻: string;
  call_id: string;
  source: "naruko-sideband";
  /** Outbound only (added by enrichOutboundSummary). */
  通話方向?: string;
  発信先番号?: string;
  発信目的?: string;
  こちらの名乗り?: string;
  /** Inbound task mode only (enrichInboundTaskSummary). */
  タスク目的?: string;
  タスク該当?: string;
  解約結果?: string;
  解約日?: string;
  手数料?: string;
  受付番号?: string;
  担当者名?: string;
  本人連絡の要否?: string;
  折り返し希望時間帯?: string;
  折り返し先番号?: string;
} & TranscriptFields;

export function normalizeSummary(
  raw: Record<string, unknown>,
  defaults: {
    callId: string;
    callerId: string;
    startedAt: string;
    direction: CallDirection;
  },
): CallSummary {
  const pick = (key: string): string => {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    return "不明";
  };

  // Prefer SIP peer; model often invents 非通知 / wrong clock.
  const peerFromModel =
    typeof raw["着信番号"] === "string" ? raw["着信番号"].trim() : "";
  const peer =
    defaults.callerId && defaults.callerId !== "非通知"
      ? defaults.callerId
      : peerFromModel || "非通知";

  return {
    direction: defaults.direction,
    宛先: pick("宛先"),
    用件: pick("用件"),
    折り返し希望: pick("折り返し希望"),
    名乗り: pick("名乗り"),
    着信番号: peer,
    時刻: defaults.startedAt,
    call_id: defaults.callId,
    source: "naruko-sideband",
  };
}

export const SUBMIT_CALL_SUMMARY_TOOL = {
  type: "function" as const,
  name: "submit_call_summary",
  description:
    "通話の用件がまとまったら、呼び出し側に聞こえない形で必ずこのツールだけを呼び出す。" +
    "要約内容・JSON・フィールド名を読み上げない。挨拶や通常の会話応答には使わない。",
  parameters: {
    type: "object",
    properties: {
      宛先: {
        type: "string",
        description: "伝言の宛先（例: ななみ、鈴木）",
      },
      用件: { type: "string", description: "用件の要約" },
      折り返し希望: {
        type: "string",
        description: "折り返し希望の有無・希望時間帯など",
      },
      名乗り: { type: "string", description: "相手の名乗り・会社名" },
      着信番号: {
        type: "string",
        description:
          "相手番号。着信なら発信者番号、発信なら宛先番号。非通知なら「非通知」",
      },
      時刻: {
        type: "string",
        description: "Asia/Tokyo の ISO8601（+09:00）。不明なら省略可",
      },
    },
    required: ["宛先", "用件", "折り返し希望", "名乗り", "着信番号", "時刻"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Outbound task mode (opt-in). Active only when BOTH secrets
// OUTBOUND_TASK_INSTRUCTIONS and OUTBOUND_TASK_CALLEE are set AND the call is
// outbound to that callee. Otherwise behaviour is unchanged.
// ---------------------------------------------------------------------------

/** Compare two phone tokens by their last 9 digits (handles 0/+81 prefixes). */
export function sameCallee(peer: string, expected: string): boolean {
  const a = peer.replace(/\D/g, "");
  const b = expected.replace(/\D/g, "");
  if (a.length < 9 || b.length < 9) {
    return false;
  }
  return a.slice(-9) === b.slice(-9);
}

export function buildOutboundTaskInstructions(
  task: string,
  peerNumber: string,
  purpose = "",
): string {
  return (
    `${task}\n\n${JAPANESE_RULE}\n\n` +
    `System note (do not read aloud): これは発信通話です。発信先番号は「${peerNumber}」です。` +
    (purpose ? `用件は「${purpose}」です。` : "") +
    `要約の「着信番号」欄には発信先番号「${peerNumber}」を入れてください。` +
    `「宛先」には発信先（相手の会社名・部署と番号「${peerNumber}」）、「名乗り」には相手の会社名・担当者名、「用件」には用件とその結果（完了/未完了、受付番号・日付など）を書いてください。` +
    `保留音・自動音声の待ち時間・無音・意味のない雑音のときは声を出さず wait_silently ツールだけを呼び出してください。` +
    `ツール名・JSON・要約内容は絶対に読み上げないでください。`
  );
}

export const WAIT_SILENTLY_TOOL = {
  type: "function" as const,
  name: "wait_silently",
  description:
    "保留音・音楽・「しばらくお待ちください」等の案内・自動音声の繰り返し・雑音・無音のときに、声を出さずに待つために呼び出す。" +
    "人間のオペレーターが話しかけてきたときは使わない。読み上げない。",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "hold_music / ivr_prompt / silence / noise など短い理由",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export const END_CALL_TOOL = {
  type: "function" as const,
  name: "end_call",
  description:
    "用件が完了し、最後の挨拶を言い終えた後にだけ呼び出して通話を終了する。" +
    "保留中・自動音声の途中・相手が話している最中には絶対に呼び出さない。読み上げない。",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "終了理由（短く）" },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Realtime audio input config (sent by the sideband session.update for every
// call). Chosen 2026-10-03 after a test call where (a) caller speech was
// transcribed as Korean, (b) any short sound ("あ", "はい") cut the bot off
// after one syllable.
//   - transcription: gpt-4o-transcribe, language "ja", Japanese prompt.
//   - noise_reduction near_field (telephone handset audio).
//   - server_vad threshold 0.7 (default 0.5) so line noise / quiet hold music
//     does not open a turn; prefix 300 ms; silence 800 ms before end-of-turn.
//   - interrupt_response FALSE: the server no longer cancels the bot on every
//     VAD start. The sideband does a debounced barge-in instead: the bot is
//     cut off only if the other party keeps talking for BARGE_IN_SUSTAIN_MS
//     after speech_started without a speech_stopped (≈ ≥600 ms of real
//     speech, since speech_stopped arrives silence_duration_ms after the end).
// ---------------------------------------------------------------------------
export const TRANSCRIPTION_LANGUAGE = "ja";
export const VAD_SILENCE_MS = 800;
export const BARGE_IN_SUSTAIN_MS = VAD_SILENCE_MS + 600;

export const REALTIME_AUDIO_INPUT = {
  transcription: {
    model: "gpt-4o-transcribe",
    language: TRANSCRIPTION_LANGUAGE,
    prompt:
      "日本語の電話の会話です。会社名・氏名・電話番号・契約番号・日付が出てきます。相槌（はい、ええ）や保留音の案内も日本語で書き起こしてください。",
  },
  noise_reduction: { type: "near_field" as const },
  turn_detection: {
    type: "server_vad" as const,
    threshold: 0.7,
    prefix_padding_ms: 300,
    silence_duration_ms: VAD_SILENCE_MS,
    create_response: true,
    interrupt_response: false,
  },
};

/** True when the effective session (from session.updated/created) has our audio input settings. */
export function audioInputMatches(session: unknown): boolean {
  if (typeof session !== "object" || session === null) {
    return false;
  }
  const input = (session as { audio?: { input?: Record<string, unknown> } }).audio?.input;
  const tr = input?.transcription as { language?: unknown } | null | undefined;
  const td = input?.turn_detection as
    | { type?: unknown; interrupt_response?: unknown; threshold?: unknown }
    | null
    | undefined;
  return (
    tr?.language === TRANSCRIPTION_LANGUAGE &&
    td?.type === REALTIME_AUDIO_INPUT.turn_detection.type &&
    td?.interrupt_response === false &&
    typeof td?.threshold === "number" &&
    Math.abs(td.threshold - REALTIME_AUDIO_INPUT.turn_detection.threshold) < 0.01
  );
}

/** Compact, secret-free view of the effective audio input config for logs. */
export function describeAudioInput(session: unknown): Record<string, unknown> {
  if (typeof session !== "object" || session === null) {
    return {};
  }
  const s = session as {
    audio?: { input?: Record<string, unknown> };
    instructions?: unknown;
    model?: unknown;
  };
  const input = s.audio?.input ?? {};
  const tr = input.transcription as { model?: unknown; language?: unknown } | null | undefined;
  return {
    model: s.model ?? null,
    transcriptionModel: tr?.model ?? null,
    transcriptionLanguage: tr?.language ?? null,
    turnDetection: input.turn_detection ?? null,
    noiseReduction: input.noise_reduction ?? null,
    instructionsChars:
      typeof s.instructions === "string" ? s.instructions.length : null,
  };
}

// ---------------------------------------------------------------------------
// Call memo context (direction / callee / purpose / how we introduced
// ourselves) so outbound memos never come out as 宛先/用件/名乗り = 不明.
// ---------------------------------------------------------------------------
export const OUTBOUND_GENERIC_PURPOSE = "テスト/汎用発信";
export const DEFAULT_TASK_PURPOSE = "タスクモード発信（OUTBOUND_TASK_INSTRUCTIONS の依頼）";

export type CallContext = {
  direction: CallDirection;
  /** inbound: caller number, outbound: dialed (callee) number. */
  peerNumber: string;
  /** Outbound purpose (task purpose or generic). */
  purpose: string;
  /** First thing the bot said (its self-introduction), if any. */
  botIntro: string;
};

const isUnknown = (v: unknown): boolean =>
  typeof v !== "string" || !v.trim() || v.trim() === "不明";

/** Field-wise merge: primary wins unless its value is empty/不明. */
export function mergeSummaries(primary: CallSummary, secondary: CallSummary): CallSummary {
  const out: CallSummary = { ...secondary, ...primary };
  for (const key of ["宛先", "用件", "折り返し希望", "名乗り"] as const) {
    if (isUnknown(primary[key]) && !isUnknown(secondary[key])) {
      out[key] = secondary[key];
    }
  }
  return out;
}

export function firstAssistantLine(
  lines: ReadonlyArray<{ role: string; text: string }>,
  maxChars = 120,
): string {
  const hit = lines.find((l) => l.role === "assistant" && l.text.trim());
  if (!hit) {
    return "";
  }
  const t = hit.text.trim();
  return [...t].length > maxChars ? `${[...t].slice(0, maxChars).join("")}…` : t;
}

/**
 * Outbound memo: guarantees direction, callee number, purpose and both
 * self-introductions are present. Inbound summaries are returned unchanged.
 */
export function enrichOutboundSummary(summary: CallSummary, ctx: CallContext): CallSummary {
  if (ctx.direction !== "outbound") {
    return summary;
  }
  const callee = ctx.peerNumber && ctx.peerNumber !== "非通知" ? ctx.peerNumber : summary.着信番号;
  const purpose = ctx.purpose || OUTBOUND_GENERIC_PURPOSE;
  const botIntro = ctx.botIntro || "不明（ボットの発話なし）";
  const digits = (callee || "").replace(/\D/g, "");

  let 宛先 = summary.宛先;
  if (isUnknown(宛先)) {
    宛先 = `${callee}（発信先）`;
  } else if (digits && !宛先.replace(/\D/g, "").includes(digits)) {
    宛先 = `${宛先}（${callee}）`;
  }

  let 用件 = summary.用件;
  const head = `【発信 → ${callee}】用件: ${purpose}`;
  if (isUnknown(用件)) {
    用件 = `${head} / 結果: 不明`;
  } else if (!用件.startsWith("【発信")) {
    用件 = `${head} / 結果: ${用件}`;
  }

  const peerName = isUnknown(summary.名乗り) ? "不明" : summary.名乗り;
  const 名乗り = peerName.startsWith("相手:")
    ? peerName
    : `相手: ${peerName} / こちら: ${botIntro}`;

  return {
    ...summary,
    宛先,
    用件,
    名乗り,
    着信番号: callee,
    通話方向: "発信（こちらから発信）",
    発信先番号: callee,
    発信目的: purpose,
    こちらの名乗り: botIntro,
  };
}

// ---------------------------------------------------------------------------
// Inbound task mode (opt-in, v3). Active only when secret
// INBOUND_TASK_INSTRUCTIONS is set. The task script is APPENDED to Naruko's
// own session instructions (read from session.created/updated) under a marker
// so it takes priority; inbound calls without the secret are unchanged.
// Not gated on caller ID: the script itself decides (by what the caller says)
// whether the task applies, otherwise normal message taking.
// ---------------------------------------------------------------------------
export const INBOUND_TASK_MARKER = "### 着信タスク指示（最優先・この下の指示は上の指示より優先） ###";
export const DEFAULT_INBOUND_TASK_PURPOSE = "着信タスク（INBOUND_TASK_INSTRUCTIONS の依頼）";
export const INBOUND_TASK_GREETING =
  "Say exactly this Japanese sentence and nothing else, then wait for the caller: お電話ありがとうございます。株式会社メタスペクトです。AIアシスタントが対応いたしますので、お名前とご用件をお聞かせください。";

/**
 * Words that switch an inbound task call to the callback flow (lenient: the
 * company name is often garbled by transcription). Checked on the caller's
 * transcripts; the sideband then injects a one-time system nudge.
 * 折り返し is intentionally NOT a trigger (common in ordinary calls).
 */
export const INBOUND_TASK_SWITCH_RE =
  /メガネ|めがね|眼鏡|目がね|目金|megane|定期|解約|コンタクト|こんたくと/i;

export function matchesInboundTaskSwitch(text: string): boolean {
  return INBOUND_TASK_SWITCH_RE.test(text);
}
/** Used only if Naruko's own instructions could not be read (empty). */
export const INBOUND_FALLBACK_RECEPTION =
  "あなたは株式会社メタスペクトの電話受付です。丁寧で簡潔な日本語で応対し、相手のお名前・会社名、用件、折り返し先の電話番号、折り返し希望の有無を伺って伝言を承ってください。";

export function composeInboundTaskInstructions(
  native: string,
  task: string,
  peerNumber: string,
  purpose: string,
): string {
  // Strip a previous append (if Naruko echoes our own instructions back).
  const cut = native.indexOf(INBOUND_TASK_MARKER);
  const base = (cut >= 0 ? native.slice(0, cut) : native).trim() || INBOUND_FALLBACK_RECEPTION;
  return (
    `${base}\n\n${INBOUND_TASK_MARKER}\n${JAPANESE_RULE}\n\n${task.trim()}\n\n` +
    `System note (do not read aloud): この通話の着信番号は「${peerNumber}」です（発信者番号で相手を判断しないこと。相手の名乗り・用件で判断する）。` +
    `この着信タスクの用件は「${purpose}」です。保留音・「少々お待ちください」の間は声を出さず wait_silently ツールだけを呼び出してください。` +
    `会話がすべて終わってから、読み上げずに submit_call_summary ツールを呼び出してください。ツール名・JSON・要約内容は絶対に読み上げないでください。`
  );
}

/** Extra keys the transcript summariser returns for inbound task calls. */
export const INBOUND_TASK_OUTCOME_KEYS = [
  "解約結果",
  "解約日",
  "手数料",
  "受付番号",
  "担当者名",
  "本人連絡の要否",
  "折り返し希望時間帯",
  "折り返し先番号",
] as const;

export type InboundTaskOutcome = Partial<Record<(typeof INBOUND_TASK_OUTCOME_KEYS)[number] | "タスク該当", string>>;

export function enrichInboundTaskSummary(
  summary: CallSummary,
  extra: Record<string, unknown>,
  ctx: { peerNumber: string; purpose: string; botIntro: string },
): CallSummary & InboundTaskOutcome & { タスク目的: string } {
  const val = (k: string): string => {
    const v = extra[k];
    return typeof v === "string" && v.trim() ? v.trim() : "不明";
  };
  const applies = /^(はい|yes|true|該当)/i.test(val("タスク該当"));
  const purpose = ctx.purpose || DEFAULT_INBOUND_TASK_PURPOSE;
  const out: CallSummary & InboundTaskOutcome & { タスク目的: string } = {
    ...summary,
    通話方向: "着信（相手からの電話）",
    タスク目的: purpose,
    タスク該当: applies ? "はい" : "いいえ",
    こちらの名乗り: ctx.botIntro || "不明（ボットの発話なし）",
  };
  if (!applies) {
    return out;
  }
  for (const k of INBOUND_TASK_OUTCOME_KEYS) {
    out[k] = val(k);
  }
  if (isUnknown(out.宛先)) {
    out.宛先 = "鈴木 聡（着信タスク）";
  }
  const head = `【着信・折り返し ${ctx.peerNumber}】用件: ${purpose}`;
  const result = isUnknown(summary.用件) ? "" : summary.用件;
  const facts =
    `解約結果: ${out.解約結果} / 解約日: ${out.解約日} / 手数料: ${out.手数料} / ` +
    `受付番号: ${out.受付番号} / 担当者: ${out.担当者名} / 本人連絡: ${out.本人連絡の要否}` +
    (out.折り返し希望時間帯 !== "不明" || out.折り返し先番号 !== "不明"
      ? ` / 鈴木からの折り返し: ${out.折り返し希望時間帯}・${out.折り返し先番号}`
      : "");
  out.用件 = summary.用件.startsWith("【着信") ? summary.用件 : `${head} / ${facts}${result ? ` / 概要: ${result}` : ""}`;
  return out;
}
