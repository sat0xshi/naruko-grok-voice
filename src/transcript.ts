// Full-transcript attachment for call memos. Pure logic + an injectable R2-like
// bucket so it can be unit-tested under plain Node (no Cloudflare imports).

export type TranscriptRole = "caller" | "assistant";

export type TranscriptLine = {
  role: TranscriptRole;
  text: string;
};

/** Inline limit (Unicode code points) for the `全文` field. */
export const TRANSCRIPT_INLINE_LIMIT = 6000;
/** Head length (code points) sent as `全文冒頭` when the full text goes to R2. */
export const TRANSCRIPT_HEAD_CHARS = 1500;

/** Fields added to the CallSummary payload. All optional/backward-compatible. */
export type TranscriptFields = {
  /** Full transcript (<= 6000 chars, or any length when R2 is unavailable/failed). */
  全文?: string;
  /** First ~1500 chars when the full text is stored in R2. */
  全文冒頭?: string;
  /** "<bucket>/<key>" of the complete .txt in private R2. */
  全文_保存先?: string;
  /** Access-protected viewer URL; only when a viewer base URL is configured. */
  全文リンク?: string;
  /** Total length (code points) of the formatted transcript. */
  全文_文字数?: number;
};

/** Minimal subset of R2Bucket used here (lets tests pass a fake). */
export type TranscriptBucket = {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
};

export type TranscriptMeta = {
  callId: string;
  direction: "inbound" | "outbound";
  peer: string;
  startedAt: string; // Asia/Tokyo ISO8601 (+09:00)
};

export type TranscriptPlan =
  | { mode: "inline"; text: string; chars: number }
  | { mode: "r2"; text: string; head: string; chars: number };

function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function codePointSlice(text: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
}

/** Ordered `相手：...` (caller) / `ボット：...` (assistant) lines. Nothing dropped. */
export function formatTranscript(lines: readonly TranscriptLine[]): string {
  return lines
    .map((line) => `${line.role === "caller" ? "相手" : "ボット"}：${line.text}`)
    .join("\n");
}

export function planTranscript(
  text: string,
  limit = TRANSCRIPT_INLINE_LIMIT,
  headChars = TRANSCRIPT_HEAD_CHARS,
): TranscriptPlan {
  const chars = codePointLength(text);
  if (chars <= limit) {
    return { mode: "inline", text, chars };
  }
  return { mode: "r2", text, head: codePointSlice(text, headChars), chars };
}

/** transcripts/<YYYY>/<MM>/<call_id>.txt (YYYY/MM from the Tokyo start time). */
export function transcriptKey(callId: string, startedAt: string, ext = "txt"): string {
  const m = /^(\d{4})-(\d{2})/.exec(startedAt);
  const now = new Date();
  const yyyy = m ? m[1] : String(now.getUTCFullYear());
  const mm = m ? m[2] : String(now.getUTCMonth() + 1).padStart(2, "0");
  const safeId = (callId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);
  return `transcripts/${yyyy}/${mm}/${safeId}.${ext}`;
}

export type AttachOptions = {
  bucket?: TranscriptBucket;
  bucketName?: string;
  /** e.g. https://transcripts.example.com — only set when Access-protected. */
  viewerBaseUrl?: string;
  logError?: (event: string, fields: Record<string, unknown>) => void;
};

/**
 * Builds the transcript fields for the memo payload. Never loses content:
 * if R2 is not bound or the write fails, the full text goes into `全文`.
 */
export async function buildTranscriptFields(
  lines: readonly TranscriptLine[],
  meta: TranscriptMeta,
  opts: AttachOptions = {},
): Promise<TranscriptFields> {
  const text = formatTranscript(lines);
  const plan = planTranscript(text);
  if (plan.mode === "inline") {
    return { 全文: plan.text, 全文_文字数: plan.chars };
  }

  const { bucket, bucketName } = opts;
  if (!bucket || !bucketName) {
    opts.logError?.("transcript.r2.unavailable", {
      callId: meta.callId,
      chars: plan.chars,
      hasBinding: Boolean(bucket),
      hasBucketName: Boolean(bucketName),
    });
    return { 全文: plan.text, 全文_文字数: plan.chars };
  }

  const key = transcriptKey(meta.callId, meta.startedAt, "txt");
  const jsonKey = transcriptKey(meta.callId, meta.startedAt, "json");
  const customMetadata = {
    call_id: meta.callId,
    direction: meta.direction,
    peer: meta.peer,
    started_at: meta.startedAt,
    chars: String(plan.chars),
    lines: String(lines.length),
  };
  try {
    await bucket.put(key, plan.text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata,
    });
    await bucket.put(
      jsonKey,
      JSON.stringify(
        {
          call_id: meta.callId,
          direction: meta.direction,
          着信番号: meta.peer,
          時刻: meta.startedAt,
          chars: plan.chars,
          text_key: key,
          lines: lines.map((l) => ({ role: l.role, text: l.text })),
        },
        null,
        2,
      ),
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata,
      },
    );
  } catch (error) {
    opts.logError?.("transcript.r2.put_failed", {
      callId: meta.callId,
      key,
      chars: plan.chars,
      error: error instanceof Error ? error.message : String(error),
    });
    return { 全文: plan.text, 全文_文字数: plan.chars };
  }

  const fields: TranscriptFields = {
    全文冒頭: plan.head,
    全文_保存先: `${bucketName}/${key}`,
    全文_文字数: plan.chars,
  };
  const base = opts.viewerBaseUrl?.trim().replace(/\/+$/, "");
  if (base && /^https:\/\//.test(base)) {
    fields.全文リンク = `${base}/${key}`;
  }
  return fields;
}
