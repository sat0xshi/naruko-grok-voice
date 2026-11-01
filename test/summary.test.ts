import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioInputMatches,
  buildGreetingInstructions,
  buildOutboundTaskInstructions,
  enrichOutboundSummary,
  firstAssistantLine,
  mergeSummaries,
  normalizeSummary,
  OUTBOUND_GENERIC_PURPOSE,
  REALTIME_AUDIO_INPUT,
} from "../src/shared.ts";

const defaults = {
  callId: "rtc_x",
  callerId: "09012345678",
  startedAt: "2026-10-03T11:01:16+09:00",
  direction: "outbound" as const,
};
const unknown = normalizeSummary({}, defaults);

test("outbound memo never leaves 宛先/用件/名乗り as 不明", () => {
  const out = enrichOutboundSummary(unknown, {
    direction: "outbound",
    peerNumber: "09012345678",
    purpose: OUTBOUND_GENERIC_PURPOSE,
    botIntro: "株式会社メタスペクトです。テストのお電話です。",
  });
  assert.equal(out.宛先, "09012345678（発信先）");
  assert.match(out.用件, /^【発信 → 09012345678】用件: テスト\/汎用発信 \/ 結果: 不明$/);
  assert.equal(out.名乗り, "相手: 不明 / こちら: 株式会社メタスペクトです。テストのお電話です。");
  assert.equal(out.通話方向, "発信（こちらから発信）");
  assert.equal(out.発信先番号, "09012345678");
  assert.equal(out.発信目的, "テスト/汎用発信");
  assert.equal(out.着信番号, "09012345678");
});

test("task purpose + named callee are kept", () => {
  const s = normalizeSummary(
    { 宛先: "メガネスーパー お客様センター", 用件: "解約受付済み", 名乗り: "メガネスーパー 田中" },
    { ...defaults, callerId: "0120000000" },
  );
  const out = enrichOutboundSummary(s, {
    direction: "outbound",
    peerNumber: "0120000000",
    purpose: "メガネスーパー定期便（契約番号0000000）解約",
    botIntro: "鈴木の代理の者です。",
  });
  assert.equal(out.宛先, "メガネスーパー お客様センター（0120000000）");
  assert.equal(out.用件, "【発信 → 0120000000】用件: メガネスーパー定期便（契約番号0000000）解約 / 結果: 解約受付済み");
  assert.equal(out.名乗り, "相手: メガネスーパー 田中 / こちら: 鈴木の代理の者です。");
});

test("inbound summaries are unchanged", () => {
  const s = normalizeSummary({ 宛先: "ななみ" }, { ...defaults, direction: "inbound" });
  assert.deepEqual(enrichOutboundSummary(s, { direction: "inbound", peerNumber: "0311112222", purpose: "", botIntro: "x" }), s);
});

test("mergeSummaries fills 不明 from the secondary (tool) summary", () => {
  const a = normalizeSummary({ 用件: "通話確認OK" }, defaults);
  const b = normalizeSummary({ 用件: "テスト", 名乗り: "鈴木" }, defaults);
  const m = mergeSummaries(a, b);
  assert.equal(m.用件, "通話確認OK");
  assert.equal(m.名乗り, "鈴木");
  assert.equal(m.宛先, "不明");
});

test("firstAssistantLine picks the bot's opener", () => {
  assert.equal(
    firstAssistantLine([
      { role: "caller", text: "もしもし" },
      { role: "assistant", text: " 株式会社メタスペクトです。 " },
    ]),
    "株式会社メタスペクトです。",
  );
  assert.equal(firstAssistantLine([]), "");
});

test("audio input config: Japanese transcription + debounced VAD", () => {
  assert.equal(REALTIME_AUDIO_INPUT.transcription.language, "ja");
  assert.equal(REALTIME_AUDIO_INPUT.turn_detection.interrupt_response, false);
  assert.ok(audioInputMatches({ audio: { input: REALTIME_AUDIO_INPUT } }));
  assert.ok(
    audioInputMatches({
      audio: { input: { ...REALTIME_AUDIO_INPUT, turn_detection: { ...REALTIME_AUDIO_INPUT.turn_detection, threshold: 0.699999988 } } },
    }),
  );
  assert.ok(!audioInputMatches({ audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } }));
  assert.ok(!audioInputMatches(null));
});

test("outbound instructions: Japanese, wait for reply, no early finish", () => {
  const g = buildGreetingInstructions("BASE", "09012345678", "outbound", OUTBOUND_GENERIC_PURPOSE);
  assert.match(g, /polite Japanese/);
  assert.match(g, /STOP and wait/);
  assert.match(g, /Never say the call\/test is finished/);
  assert.match(g, /テスト\/汎用発信/);
  const t = buildOutboundTaskInstructions("TASK", "0120000000", "P");
  assert.match(t, /polite Japanese/);
  assert.match(t, /用件は「P」/);
  assert.match(t, /wait_silently/);
});

import {
  composeInboundTaskInstructions,
  enrichInboundTaskSummary,
  INBOUND_TASK_MARKER,
  INBOUND_FALLBACK_RECEPTION,
} from "../src/shared.ts";

test("inbound task: appended after Naruko's instructions under the marker, idempotent", () => {
  const once = composeInboundTaskInstructions("NARUKO BASE", "TASK SCRIPT", "09012345678", "PURPOSE");
  assert.ok(once.startsWith("NARUKO BASE\n\n" + INBOUND_TASK_MARKER));
  assert.ok(once.indexOf("TASK SCRIPT") > once.indexOf(INBOUND_TASK_MARKER));
  assert.match(once, /PURPOSE/);
  assert.match(once, /09012345678/);
  const twice = composeInboundTaskInstructions(once, "TASK SCRIPT", "09012345678", "PURPOSE");
  assert.equal(twice, once);
  assert.ok(composeInboundTaskInstructions("", "T", "x", "p").startsWith(INBOUND_FALLBACK_RECEPTION));
});

test("inbound task summary: outcome fields + purpose when the task applied", () => {
  const s = normalizeSummary(
    { 用件: "定期便の解約を受付", 名乗り: "メガネスーパー 佐藤" },
    { ...defaults, direction: "inbound", callerId: "09012345678" },
  );
  const out = enrichInboundTaskSummary(
    s,
    { タスク該当: "はい", 解約結果: "完了", 解約日: "2026-12-01分から停止", 手数料: "3,300円", 受付番号: "A123", 担当者名: "佐藤", 本人連絡の要否: "不要" },
    { peerNumber: "09012345678", purpose: "定期便の解約の折り返し", botIntro: "株式会社メタスペクトでございます。" },
  );
  assert.equal(out.タスク該当, "はい");
  assert.equal(out.タスク目的, "定期便の解約の折り返し");
  assert.equal(out.着信番号, "09012345678");
  assert.equal(out.宛先, "鈴木 聡（着信タスク）");
  assert.match(out.用件, /^【着信・折り返し 09012345678】用件: 定期便/);
  assert.match(out.用件, /手数料: 3,300円/);
  assert.match(out.用件, /受付番号: A123/);
  assert.match(out.用件, /概要: 定期便の解約を受付$/);
});

test("inbound task summary: other callers keep the normal memo", () => {
  const s = normalizeSummary({ 宛先: "ななみ", 用件: "見積依頼" }, { ...defaults, direction: "inbound" });
  const out = enrichInboundTaskSummary(s, { タスク該当: "いいえ" }, { peerNumber: "0311112222", purpose: "P", botIntro: "" });
  assert.equal(out.タスク該当, "いいえ");
  assert.equal(out.用件, "見積依頼");
  assert.equal(out.宛先, "ななみ");
  assert.equal(out.解約結果, undefined);
});

import { matchesInboundTaskSwitch, INBOUND_TASK_GREETING } from "../src/shared.ts";

test("v4 switch words (lenient) and greeting; 折り返し alone does not switch", () => {
  for (const t of ["メガネスーパーの者です", "めがねの件で", "眼鏡店です", "定期便について", "解約のご依頼", "コンタクトの件", "目がねスーパーです"]) {
    assert.ok(matchesInboundTaskSwitch(t), t);
  }
  for (const t of ["折り返しお願いします", "見積もりの件でお電話しました", "山田と申します"]) {
    assert.ok(!matchesInboundTaskSwitch(t), t);
  }
  assert.match(INBOUND_TASK_GREETING, /お電話ありがとうございます。株式会社メタスペクトです。AIアシスタントが対応いたしますので、お名前とご用件をお聞かせください。/);
});

test("v4 summary records callback window/number", () => {
  const s = normalizeSummary({ 用件: "本人からの電話が必要" }, { ...defaults, direction: "inbound" });
  const out = enrichInboundTaskSummary(
    s,
    { タスク該当: "はい", 本人連絡の要否: "必要", 折り返し希望時間帯: "平日10-18時", 折り返し先番号: "0120-000-000" },
    { peerNumber: "09012345678", purpose: "P", botIntro: "" },
  );
  assert.equal(out.折り返し希望時間帯, "平日10-18時");
  assert.equal(out.折り返し先番号, "0120-000-000");
  assert.match(out.用件, /鈴木からの折り返し: 平日10-18時・0120-000-000/);
});
