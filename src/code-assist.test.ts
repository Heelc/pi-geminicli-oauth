import { describe, expect, it } from "vitest";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";
import { buildCodeAssistRequest, formatCodeAssistError, parseCodeAssistSse, unwrapCodeAssistBody } from "./code-assist";

describe("buildCodeAssistRequest", () => {
  it("把 Gemini 请求包装为 Code Assist internal 请求", () => {
    const payload = {
      contents: [{ role: "user", parts: [{ text: "你好" }] }],
      generationConfig: { temperature: 0.2 },
    };

    const request = buildCodeAssistRequest({
      modelId: "gemini-3-flash",
      projectId: "enterprise-project",
      payload,
      stream: true,
    });

    expect(request.url).toBe(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
    expect(request.body.project).toBe("enterprise-project");
    expect(request.body.model).toBe("gemini-3-flash");
    expect(request.body.request).toMatchObject({ ...payload, session_id: expect.any(String) });
    expect(request.body.user_prompt_id).toMatch(/^[0-9a-f-]{36}$/);
  });


  it("规范化 systemInstruction、session_id 与 thinkingConfig", () => {
    const request = buildCodeAssistRequest({
      modelId: "gemini-3-flash",
      projectId: "enterprise-project",
      payload: {
        systemInstruction: { parts: [{ text: "你是编码助手" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
      },
      stream: true,
    });

    expect(request.body.request).toMatchObject({
      systemInstruction: { parts: [{ text: "你是编码助手" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
      },
      session_id: expect.any(String),
    });
    expect((request.body.request as Record<string, unknown>).thinkingConfig).toBeUndefined();
  });


  it("清洗历史中的 thought-only model turn 并归一化 cachedContent", () => {
    const request = buildCodeAssistRequest({
      modelId: "gemini-3-flash",
      projectId: "enterprise-project",
      payload: {
        contents: [
          { role: "user", parts: [{ text: "first" }] },
          { role: "model", parts: [{ text: "内部思考", thought: true }] },
          { role: "user", parts: [{ text: "second" }] },
        ],
        extra_body: { cached_content: "cachedContents/abc" },
      },
      stream: true,
    });

    const body = request.body.request as Record<string, unknown>;
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "first" }] },
      { role: "user", parts: [{ text: "second" }] },
    ]);
    expect(body.cachedContent).toBe("cachedContents/abc");
    expect(body.extra_body).toBeUndefined();
  });

  it("构造 Gemini CLI 风格请求 headers", () => {
    const headers = new Headers(
      buildCodeAssistRequest({
        modelId: "gemini-3-flash",
        projectId: "enterprise-project",
        payload: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        stream: true,
        accessToken: "token-123",
      }).headers,
    );

    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("User-Agent")).toContain("GeminiCLI/");
    expect(headers.get("User-Agent")).toContain("/gemini-3-flash ");
    expect(headers.get("x-activity-request-id")).toBeTruthy();
  });


  it("User-Agent 使用可覆盖的 Gemini CLI 版本和 surface", () => {
    const previousVersion = process.env.PI_GEMINI_CLI_VERSION;
    const previousSurface = process.env.GEMINI_CLI_SURFACE;
    process.env.PI_GEMINI_CLI_VERSION = "0.49.0";
    process.env.GEMINI_CLI_SURFACE = "pi";
    try {
      const headers = buildCodeAssistRequest({
        modelId: "gemini-3-flash",
        projectId: "enterprise-project",
        payload: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        stream: true,
      }).headers;

      expect(headers.get("User-Agent")).toBe(`GeminiCLI/0.49.0/gemini-3-flash (${process.platform}; ${process.arch}; pi)`);
    } finally {
      if (previousVersion === undefined) delete process.env.PI_GEMINI_CLI_VERSION;
      else process.env.PI_GEMINI_CLI_VERSION = previousVersion;
      if (previousSurface === undefined) delete process.env.GEMINI_CLI_SURFACE;
      else process.env.GEMINI_CLI_SURFACE = previousSurface;
    }
  });
});

describe("unwrapCodeAssistBody", () => {
  it("拆出 Code Assist JSON 响应中的 response 字段", () => {
    const body = { response: { candidates: [{ content: { parts: [{ text: "完成" }] } }] } };

    expect(unwrapCodeAssistBody(body)).toEqual(body.response);
  });

  it("非包装响应保持原样", () => {
    const body = { candidates: [] };

    expect(unwrapCodeAssistBody(body)).toBe(body);
  });
});

describe("parseCodeAssistSse", () => {
  it("拆出 SSE data 行中的 response 字段", () => {
    const lines = parseCodeAssistSse('data: {"response":{"candidates":[{"content":{"parts":[{"text":"流"}]}}]}}\n\n');

    expect(lines).toEqual(['data: {"candidates":[{"content":{"parts":[{"text":"流"}]}}]}']);
  });


  it("把 traceId 映射为 responseId", () => {
    const lines = parseCodeAssistSse('data: {"traceId":"trace-123","response":{"candidates":[]}}\n\n');

    expect(lines).toEqual(['data: {"candidates":[],"responseId":"trace-123"}']);
  });
});


describe("formatCodeAssistError", () => {
  it("保留 Google error details 中的限流原因", () => {
    const response = new Response("", { status: 429, statusText: "Too Many Requests" });
    const message = formatCodeAssistError(
      response,
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exhausted",
          details: [{ reason: "RATE_LIMIT_EXCEEDED", domain: "googleapis.com" }],
        },
      }),
    );

    expect(message).toContain("RESOURCE_EXHAUSTED");
    expect(message).toContain("Quota exhausted");
    expect(message).toContain("RATE_LIMIT_EXCEEDED");
  });
});
