export type CodeAssistQuotaReason = "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED" | "MODEL_CAPACITY_EXHAUSTED" | string;

export interface CodeAssistErrorClassification {
  status?: string;
  message?: string;
  reason?: CodeAssistQuotaReason;
  domain?: string;
  retryable: boolean;
  retryDelayMs?: number;
}

const retryCooldownByKey = new Map<string, number>();

export async function classifyCodeAssistError(body: string): Promise<CodeAssistErrorClassification> {
  if (!body.trim()) return { retryable: false };

  try {
    const parsed = JSON.parse(body) as { error?: { status?: unknown; message?: unknown; details?: unknown } };
    const details = Array.isArray(parsed.error?.details) ? parsed.error.details : [];
    const errorInfo = details.find(isErrorInfo) as Record<string, unknown> | undefined;
    const retryInfo = details.find(isRetryInfo) as Record<string, unknown> | undefined;
    const reason = typeof errorInfo?.reason === "string" ? errorInfo.reason : undefined;
    const retryDelayMs = extractRetryDelayMs(retryInfo);

    return {
      status: typeof parsed.error?.status === "string" ? parsed.error.status : undefined,
      message: typeof parsed.error?.message === "string" ? parsed.error.message : undefined,
      reason,
      domain: typeof errorInfo?.domain === "string" ? errorInfo.domain : undefined,
      retryable: isRetryableReason(reason),
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    };
  } catch {
    return { retryable: false };
  }
}

export function extractRetryDelayMs(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const retryDelay = (value as Record<string, unknown>).retryDelay;
  if (typeof retryDelay !== "string") return undefined;

  const match = retryDelay.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === "s" ? Math.round(amount * 1000) : Math.round(amount);
}

export async function shouldRetryCodeAssistResponse(response: Response, attempt: number, maxRetries: number): Promise<boolean> {
  if (attempt >= maxRetries) return false;
  if (response.status >= 500 && response.status < 600) return true;
  if (response.status !== 429) return false;

  const classification = await classifyCodeAssistError(await response.clone().text());
  return classification.retryable;
}

export async function getCodeAssistRetryDelayMs(response: Response, attempt: number, maxRetryDelayMs = 60_000): Promise<number> {
  const headerDelay = getRetryAfterHeaderDelayMs(response.headers);
  if (headerDelay !== undefined) return Math.min(headerDelay, maxRetryDelayMs);

  const fallback = Math.min(getExponentialDelayWithJitter(attempt), maxRetryDelayMs);
  if (response.status !== 429) return fallback;

  const classification = await classifyCodeAssistError(await response.clone().text());
  const delay = classification.retryDelayMs ?? fallback;
  return Math.min(delay, maxRetryDelayMs);
}

export function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

export function recordRetryCooldown(key: string, delayMs: number): void {
  if (delayMs <= 0) return;
  const next = Date.now() + delayMs;
  retryCooldownByKey.set(key, Math.max(retryCooldownByKey.get(key) ?? 0, next));
}

export function getRetryCooldownMs(key: string): number {
  const until = retryCooldownByKey.get(key);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    retryCooldownByKey.delete(key);
    return 0;
  }
  return remaining;
}

export function resetRetryCooldowns(): void {
  retryCooldownByKey.clear();
}

export function getExponentialDelayWithJitter(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.min(250, base));
  return base + jitter;
}

function getRetryAfterHeaderDelayMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseInt(retryAfterMs, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(retryAfter);
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  return undefined;
}

export function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrorInfo(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
}

function isRetryInfo(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
}

function isRetryableReason(reason: string | undefined): boolean {
  return reason === "RATE_LIMIT_EXCEEDED" || reason === "MODEL_CAPACITY_EXHAUSTED";
}
