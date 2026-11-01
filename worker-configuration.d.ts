interface Env {
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  NARUKO_WEBHOOK_URL: string;
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_AUTH: string;
  GREETING_INSTRUCTIONS?: string;
  OUTBOUND_INSTRUCTIONS?: string;
  /** Private R2 bucket for >6000-char transcripts (optional until R2 is enabled). */
  TRANSCRIPTS?: R2Bucket;
  TRANSCRIPTS_BUCKET_NAME?: string;
  /** Only set when an Access-protected viewer exists. */
  TRANSCRIPT_VIEWER_BASE_URL?: string;
  XAI_API_KEY: string;
  XAI_WEBHOOK_SECRET: string;
  XAI_VOICE?: string;
  XAI_INSTRUCTIONS?: string;
  XAI_OUTBOUND_PURPOSE?: string;
  XAI_CALL: DurableObjectNamespace<import("./src/xai-call").XaiCall>;
  CALL_SIDEBAND: DurableObjectNamespace<import("./src/call-sideband").CallSideband>;
}
