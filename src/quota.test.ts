import { describe, expect, it } from "vitest";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";
import { formatGeminiQuota, retrieveUserQuota } from "./quota";

describe("retrieveUserQuota", () => {
  it("调用 Code Assist retrieveUserQuota 并返回 quota buckets", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          buckets: [
            { modelId: "gemini-3-flash", limit: 100, consumed: 25 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const quota = await retrieveUserQuota({
      accessToken: "token-123",
      projectId: "codeassist-preview",
      modelId: "gemini-3-flash",
      fetchImpl,
    });

    expect(capturedUrl).toBe(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`);
    expect(capturedBody).toEqual({ project: "codeassist-preview" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer token-123");
    expect(quota?.buckets?.[0]?.modelId).toBe("gemini-3-flash");
  });
});

describe("formatGeminiQuota", () => {
  it("格式化 quota buckets 便于命令展示", () => {
    const output = formatGeminiQuota("codeassist-preview", {
      buckets: [
        { modelId: "gemini-3-flash", limit: 100, consumed: 25 },
        { modelId: "gemini-3.1-pro-preview", limit: 10, consumed: 10, resetTime: "2026-07-01T13:00:00Z" },
      ],
    });

    expect(output).toContain("codeassist-preview");
    expect(output).toContain("gemini-3-flash");
    expect(output).toContain("25/100");
    expect(output).toContain("gemini-3.1-pro-preview");
    expect(output).toContain("2026-07-01 21:00:00");
  });

  it("格式化 Code Assist 真实返回的 remainingFraction quota 信息", () => {
    const output = formatGeminiQuota("codeassist-preview", {
      buckets: [
        { modelId: "gemini-3-flash", remainingFraction: 0.5595, resetTime: "2026-07-02T04:45:17Z", tokenType: "REQUESTS" },
        { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.986, remainingAmount: "493", resetTime: "2026-07-03T02:34:55Z", tokenType: "REQUESTS" },
      ],
    });

    expect(output).toContain("gemini-3-flash");
    expect(output).toContain("56.0%");
    expect(output).toContain("REQUESTS");
    expect(output).toContain("gemini-3.1-pro-preview");
    expect(output).toContain("98.6% (493 left)");
    expect(output).not.toContain("quota 信息不可用");
  });

  it("按 Flash/Pro/Other 分组并使用 UTC+8 易读时间", () => {
    const output = formatGeminiQuota("codeassist-preview", {
      buckets: [
        { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.986, remainingAmount: "493", resetTime: "2026-07-03T02:34:55Z", tokenType: "REQUESTS" },
        { modelId: "custom-model", remainingFraction: 0.25, resetTime: "2026-07-02T00:00:00Z", tokenType: "TOKENS" },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 1, resetTime: "2026-07-03T03:25:44Z", tokenType: "REQUESTS" },
        { modelId: "gemini-3-flash", remainingFraction: 0.5595, resetTime: "2026-07-02T04:45:17Z", tokenType: "REQUESTS" },
      ],
    });

    expect(output).toContain("时区：UTC+8");
    expect(output).toContain("Flash");
    expect(output).toContain("Pro");
    expect(output).toContain("Other");
    expect(output.indexOf("Flash")).toBeLessThan(output.indexOf("Pro"));
    expect(output.indexOf("Pro")).toBeLessThan(output.indexOf("Other"));
    expect(output.indexOf("gemini-2.5-flash-lite")).toBeGreaterThan(output.indexOf("Flash"));
    expect(output.indexOf("gemini-2.5-flash-lite")).toBeLessThan(output.indexOf("Pro"));
    expect(output).toContain("gemini-3-flash");
    expect(output).toContain("56.0%");
    expect(output).toContain("gemini-3.1-pro-preview");
    expect(output).toContain("98.6% (493 left)");
    expect(output).toContain("custom-model");
    expect(output).toContain("2026-07-02 12:45:17");
    expect(output).toContain("2026-07-03 10:34:55");
    expect(output).not.toContain("重置时间：2026-07-02T04:45:17Z");
    expect(output).not.toContain("，类型：");
  });
});
