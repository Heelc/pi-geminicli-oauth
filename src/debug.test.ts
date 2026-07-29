import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGeminiDebugLogger, maskSensitiveHeaders } from "./debug";

describe("Gemini debug logger", () => {
  it("未启用 PI_GEMINI_CLI_OAUTH_DEBUG 时不写日志", ({ task }) => {
    const dir = task.file!.filepath.replace(/debug\.test\.ts$/, "tmp-debug-disabled");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "gemini-debug.log");
    const logger = createGeminiDebugLogger({ env: {}, logPath });

    logger.logRequest({ url: "https://example.com", method: "POST", headers: { authorization: "Bearer token" }, projectId: "p", modelId: "m" });

    expect(logger.enabled).toBe(false);
  });

  it("启用后写入脱敏请求、响应与 retry 信息", ({ task }) => {
    const dir = task.file!.filepath.replace(/debug\.test\.ts$/, "tmp-debug-enabled");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "gemini-debug.log");
    const logger = createGeminiDebugLogger({ env: { PI_GEMINI_CLI_OAUTH_DEBUG: "1" }, logPath });

    logger.logRequest({
      url: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      method: "POST",
      headers: { authorization: "Bearer secret-token", "x-activity-request-id": "abc" },
      projectId: "codeassist-preview",
      modelId: "gemini-3-flash",
      body: JSON.stringify({ prompt: "x".repeat(3000) }),
    });
    logger.logRetry({ attempt: 1, delayMs: 250, reason: "RATE_LIMIT_EXCEEDED" });
    logger.logResponse({ status: 429, statusText: "Too Many Requests", traceId: "trace-123", durationMs: 1234 });

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("codeassist-preview");
    expect(content).toContain("gemini-3-flash");
    expect(content).toContain("RATE_LIMIT_EXCEEDED");
    expect(content).toContain("trace-123");
    expect(content).toContain("[redacted]");
    expect(content).not.toContain("secret-token");
    expect(content).toContain("truncated");
  });

  it("maskSensitiveHeaders 会隐藏 authorization 和 api key", () => {
    expect(maskSensitiveHeaders({ Authorization: "Bearer token", "x-goog-api-key": "key", Accept: "text/event-stream" })).toEqual({
      authorization: "[redacted]",
      "x-goog-api-key": "[redacted]",
      accept: "text/event-stream",
    });
  });
});
