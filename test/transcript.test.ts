import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTranscriptFields,
  formatTranscript,
  planTranscript,
  transcriptKey,
  TRANSCRIPT_HEAD_CHARS,
  TRANSCRIPT_INLINE_LIMIT,
  type TranscriptBucket,
  type TranscriptLine,
} from "../src/transcript.ts";

const load = (name: string): TranscriptLine[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const short = load("short-call.json");
const long = load("long-call.json");
const meta = {
  callId: "rtc_test123",
  direction: "inbound" as const,
  peer: "09012345678",
  startedAt: "2026-09-25T11:46:00+09:00",
};
const len = (s: string) => [...s].length;

class FakeBucket implements TranscriptBucket {
  objects = new Map<string, { value: string; options?: unknown }>();
  fail: boolean;
  constructor(fail = false) {
    this.fail = fail;
  }
  async put(key: string, value: string, options?: unknown) {
    if (this.fail) throw new Error("simulated R2 outage");
    this.objects.set(key, { value, options });
    return {};
  }
}

test("formats ordered 相手/ボット lines", () => {
  const text = formatTranscript(short);
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "ボット：株式会社サンプルです。ご用件はいかがでしょうか。");
  assert.equal(lines[1], "相手：山田商事の山田です。佐藤さんに折り返しをお願いしたいです。");
  assert.equal(lines[3], "相手：09012345678です。");
});

test("<= 6000 chars stays inline in 全文 (no R2 write)", async () => {
  const bucket = new FakeBucket();
  const f = await buildTranscriptFields(short, meta, { bucket, bucketName: "naruko-transcripts-prod" });
  assert.equal(f.全文, formatTranscript(short));
  assert.equal(f.全文冒頭, undefined);
  assert.equal(f.全文_保存先, undefined);
  assert.equal(bucket.objects.size, 0);
});

test("boundary: exactly 6000 inline, 6001 goes to R2", () => {
  assert.equal(planTranscript("あ".repeat(TRANSCRIPT_INLINE_LIMIT)).mode, "inline");
  const p = planTranscript("あ".repeat(TRANSCRIPT_INLINE_LIMIT + 1));
  assert.equal(p.mode, "r2");
  assert.equal(p.mode === "r2" && len(p.head), TRANSCRIPT_HEAD_CHARS);
});

test("> 6000 chars: full text in R2 (.txt + .json), head in payload", async () => {
  const full = formatTranscript(long);
  assert.ok(len(full) > TRANSCRIPT_INLINE_LIMIT, `fixture is ${len(full)} chars`);
  const bucket = new FakeBucket();
  const f = await buildTranscriptFields(long, meta, { bucket, bucketName: "naruko-transcripts-prod" });
  const key = "transcripts/2026/09/rtc_test123.txt";
  assert.equal(f.全文, undefined);
  assert.equal(f.全文_保存先, `naruko-transcripts-prod/${key}`);
  assert.equal(f.全文冒頭, [...full].slice(0, TRANSCRIPT_HEAD_CHARS).join(""));
  assert.equal(f.全文_文字数, len(full));
  assert.equal(f.全文リンク, undefined, "no link without an Access-protected viewer");
  assert.equal(bucket.objects.get(key)?.value, full, "complete text stored verbatim");
  const json = JSON.parse(bucket.objects.get("transcripts/2026/09/rtc_test123.json")!.value);
  assert.equal(json.lines.length, long.length);
  assert.equal(json.call_id, "rtc_test123");
  assert.equal(json.text_key, key);
});

test("> 6000 with viewer base URL adds 全文リンク", async () => {
  const f = await buildTranscriptFields(long, meta, {
    bucket: new FakeBucket(),
    bucketName: "naruko-transcripts-prod",
    viewerBaseUrl: "https://transcripts.example.com/",
  });
  assert.equal(f.全文リンク, "https://transcripts.example.com/transcripts/2026/09/rtc_test123.txt");
});

test("R2 put failure falls back to full 全文 and logs", async () => {
  const errors: string[] = [];
  const f = await buildTranscriptFields(long, meta, {
    bucket: new FakeBucket(true),
    bucketName: "naruko-transcripts-prod",
    logError: (e) => errors.push(e),
  });
  assert.equal(f.全文, formatTranscript(long));
  assert.equal(f.全文_保存先, undefined);
  assert.deepEqual(errors, ["transcript.r2.put_failed"]);
});

test("no R2 binding falls back to full 全文 and logs", async () => {
  const errors: string[] = [];
  const f = await buildTranscriptFields(long, meta, { bucketName: "x", logError: (e) => errors.push(e) });
  assert.equal(f.全文, formatTranscript(long));
  assert.deepEqual(errors, ["transcript.r2.unavailable"]);
});

test("key sanitizes call_id and uses Tokyo YYYY/MM", () => {
  assert.equal(transcriptKey("rtc/../x y", "2026-01-31T23:59:59+09:00"), "transcripts/2026/01/rtc_.._x_y.txt");
});
