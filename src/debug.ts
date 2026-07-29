import { appendFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY_PREVIEW_CHARS = 2000;

type HeaderInput = HeadersInit | Record<string, string | undefined> | undefined;

export interface GeminiDebugLogger {
  enabled: boolean;
  logRequest(input: { url: string; method?: string; headers?: HeaderInput; body?: unknown; projectId?: string; modelId?: string }): void;
  logResponse(input: { status: number; statusText?: string; traceId?: string; durationMs?: number }): void;
  logRetry(input: { attempt: number; delayMs: number; reason?: string }): void;
  logMessage(message: string): void;
}

export function createGeminiDebugLogger(input: { env?: NodeJS.ProcessEnv; logPath?: string } = {}): GeminiDebugLogger {
  const env = input.env ?? process.env;
  const enabled = env.PI_GEMINI_CLI_OAUTH_DEBUG?.trim() === "1";
  const logPath = input.logPath ?? join(process.cwd(), `gemini-cli-oauth-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

  const write = (line: string): void => {
    if (!enabled) return;
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
  };

  return {
    enabled,
    logRequest(request) {
      write(`[request] ${request.method ?? "POST"} ${request.url} project=${request.projectId ?? "-"} model=${request.modelId ?? "-"}`);
      if (request.headers) write(`[request.headers] ${JSON.stringify(maskSensitiveHeaders(request.headers))}`);
      const bodyPreview = formatBodyPreview(request.body);
      if (bodyPreview) write(`[request.body] ${bodyPreview}`);
    },
    logResponse(response) {
      write(`[response] ${response.status} ${response.statusText ?? ""} durationMs=${response.durationMs ?? "-"} trace=${response.traceId ?? "-"}`);
    },
    logRetry(retry) {
      write(`[retry] attempt=${retry.attempt} delayMs=${retry.delayMs} reason=${retry.reason ?? "-"}`);
    },
    logMessage(message) {
      write(`[message] ${message}`);
    },
  };
}

export function maskSensitiveHeaders(headers: HeaderInput): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const parsed = new Headers(headers as HeadersInit);
  parsed.forEach((value, key) => {
    const lower = key.toLowerCase();
    result[lower] = lower === "authorization" || lower === "x-goog-api-key" || lower === "x-api-key" ? "[redacted]" : value;
  });
  return result;
}

function formatBodyPreview(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= MAX_BODY_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${text.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}
