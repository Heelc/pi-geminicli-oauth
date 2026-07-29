import { describe, expect, it } from "vitest";

import {
  classifyCodeAssistError,
  extractRetryDelayMs,
  getCodeAssistRetryDelayMs,
  getRetryCooldownMs,
  recordRetryCooldown,
  resetRetryCooldowns,
  shouldRetryCodeAssistResponse,
} from "./retry";

function makeErrorResponse(status: number, reason: string, retryDelay?: string): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "cloudcode-pa.googleapis.com",
    },
  ];
  if (retryDelay) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.RetryInfo",
      retryDelay,
    });
  }

  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message: `${reason} happened`,
        status: status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",
        details,
      },
    }),
    { status, statusText: status === 429 ? "Too Many Requests" : "Service Unavailable" },
  );
}

describe("Code Assist retry helpers", () => {
  it("从 RetryInfo 中解析毫秒和秒级 retryDelay", () => {
    expect(extractRetryDelayMs({ retryDelay: "250ms" })).toBe(250);
    expect(extractRetryDelayMs({ retryDelay: "2s" })).toBe(2000);
    expect(extractRetryDelayMs({ retryDelay: "1.5s" })).toBe(1500);
  });

  it("分类 RATE_LIMIT_EXCEEDED / QUOTA_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED", async () => {
    await expect(classifyCodeAssistError(await makeErrorResponse(429, "RATE_LIMIT_EXCEEDED", "100ms").text())).resolves.toEqual(
      expect.objectContaining({ reason: "RATE_LIMIT_EXCEEDED", retryable: true, retryDelayMs: 100 }),
    );
    await expect(classifyCodeAssistError(await makeErrorResponse(429, "QUOTA_EXHAUSTED").text())).resolves.toEqual(
      expect.objectContaining({ reason: "QUOTA_EXHAUSTED", retryable: false }),
    );
    await expect(classifyCodeAssistError(await makeErrorResponse(429, "MODEL_CAPACITY_EXHAUSTED", "1s").text())).resolves.toEqual(
      expect.objectContaining({ reason: "MODEL_CAPACITY_EXHAUSTED", retryable: true, retryDelayMs: 1000 }),
    );
  });

  it("只重试可恢复响应，永久 quota exhausted 不重试", async () => {
    await expect(shouldRetryCodeAssistResponse(makeErrorResponse(503, "UNAVAILABLE"), 0, 2)).resolves.toBe(true);
    await expect(shouldRetryCodeAssistResponse(makeErrorResponse(429, "RATE_LIMIT_EXCEEDED", "100ms"), 0, 2)).resolves.toBe(true);
    await expect(shouldRetryCodeAssistResponse(makeErrorResponse(429, "QUOTA_EXHAUSTED"), 0, 2)).resolves.toBe(false);
  });


  it("优先使用 retry-after-ms / Retry-After 响应头作为重试等待", async () => {
    await expect(getCodeAssistRetryDelayMs(new Response("", { status: 503, headers: { "retry-after-ms": "250" } }), 0, 1000)).resolves.toBe(250);
    await expect(getCodeAssistRetryDelayMs(new Response("", { status: 503, headers: { "Retry-After": "2" } }), 0, 5000)).resolves.toBe(2000);
  });

  it("为同一请求 key 记录并读取 cooldown，避免容量耗尽后立即重打", () => {
    resetRetryCooldowns();
    recordRetryCooldown("project:model:endpoint", 500);

    expect(getRetryCooldownMs("project:model:endpoint")).toBeGreaterThan(0);
    expect(getRetryCooldownMs("other")).toBe(0);
  });
});
