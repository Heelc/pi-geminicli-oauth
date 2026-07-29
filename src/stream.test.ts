import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROVIDER_ID } from "./constants";
import registerExtension from "./index";
import { streamGeminiCliOAuth } from "./stream";
import { resetProjectContextCache } from "./project";

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("extension provider registration", () => {
  it("注册 gemini-cli-oauth provider、OAuth、模型列表和 quota 命令", () => {
    const registrations: Array<{ id: string; config: Record<string, unknown> }> = [];
    const commands: Array<{ name: string; options: Record<string, unknown> }> = [];
    const pi = {
      registerProvider(id: string, config: Record<string, unknown>) {
        registrations.push({ id, config });
      },
      registerCommand(name: string, options: Record<string, unknown>) {
        commands.push({ name, options });
      },
    };

    registerExtension(pi as never);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].id).toBe(PROVIDER_ID);
    expect(registrations[0].config.oauth).toBeTruthy();
    expect(registrations[0].config.streamSimple).toEqual(expect.any(Function));
    expect(registrations[0].config.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "gemini-3-flash" })]),
    );
    expect(commands).toEqual([
      expect.objectContaining({
        name: "gemini-quota",
        options: expect.objectContaining({ description: expect.stringContaining("quota") }),
      }),
    ]);
  });


  it("仅注册 Gemini 3 Flash 与 Gemini 3.1 Pro Preview 模型", () => {
    const registrations: Array<{ id: string; config: Record<string, unknown> }> = [];
    const pi = {
      registerProvider(id: string, config: Record<string, unknown>) {
        registrations.push({ id, config });
      },
      registerCommand() {},
    };

    registerExtension(pi as never);

    const models = registrations[0].config.models as Array<Record<string, unknown>>;
    expect(models.map((model) => model.id)).toEqual(["gemini-3-flash", "gemini-3.1-pro-preview"]);
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gemini-3-flash", aliases: expect.arrayContaining(["preview", "flash-preview", "gemini-preview"]) }),
      expect.objectContaining({ id: "gemini-3.1-pro-preview", aliases: expect.arrayContaining(["pro", "pro-preview", "gemini-pro-preview"]) }),
    ]));
    expect(models.map((model) => model.id)).not.toContain("gemini-2.5-flash");
    expect(models.map((model) => model.id)).not.toContain("gemini-2.5-pro");
    expect(models.map((model) => model.id)).not.toContain("gemini-3-pro-preview");
    for (const model of models) {
      const cost = model.cost as Record<string, number>;
      expect(cost.input).toBeGreaterThan(0);
      expect(cost.output).toBeGreaterThan(0);
    }
  });
});

describe("streamGeminiCliOAuth", () => {
  it("缺少 OAuth access token 时返回错误事件", async () => {
    const stream = streamGeminiCliOAuth(
      { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
      { messages: [] } as never,
      {},
    );

    const events = await collectEvents(stream);

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        reason: "error",
        error: expect.objectContaining({ errorMessage: expect.stringContaining("/login gemini-cli-oauth") }),
      }),
    ]);
  });

  it("缺少 projectId 时返回企业额度配置提示", async () => {
    const stream = streamGeminiCliOAuth(
      { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
      { messages: [] } as never,
      { apiKey: "access-token", env: {}, cwd: mkdtempSync(join(tmpdir(), "gemini-cli-oauth-cwd-")), homeDir: mkdtempSync(join(tmpdir(), "gemini-cli-oauth-home-")), disableManagedProject: true },
    );

    const events = await collectEvents(stream);

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ errorMessage: expect.stringContaining("projectId") }),
      }),
    ]);
  });


  it("未显式配置 projectId 时通过 loadCodeAssist 发现 managed project 并用于生成请求", async () => {
    resetProjectContextCache();
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
      if (String(url).includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({ cloudaicompanionProject: { id: "managed-project-123" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const homeDir = mkdtempSync(join(tmpdir(), "gemini-cli-oauth-managed-home-"));
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "access-token",
          env: {},
          cwd: mkdtempSync(join(tmpdir(), "gemini-cli-oauth-managed-cwd-")),
          homeDir,
        },
      );

      const events = await collectEvents(stream);

      expect(urls[0]).toContain(":loadCodeAssist");
      expect(bodies[0]).toEqual({ metadata: expect.any(Object) });
      expect(urls[1]).toContain(":streamGenerateContent");
      expect(bodies[1].project).toBe("managed-project-123");
      expect(JSON.parse(readFileSync(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json"), "utf8"))).toEqual({ projectId: "managed-project-123" });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("loadCodeAssist 未返回 managed project 时使用 free-tier onboardUser 引导项目", async () => {
    resetProjectContextCache();
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
      if (String(url).includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes(":onboardUser")) {
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: "onboarded-project-456" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const homeDir = mkdtempSync(join(tmpdir(), "gemini-cli-oauth-onboard-home-"));
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "access-token",
          env: {},
          cwd: mkdtempSync(join(tmpdir(), "gemini-cli-oauth-onboard-cwd-")),
          homeDir,
        },
      );

      await collectEvents(stream);

      expect(urls[0]).toContain(":loadCodeAssist");
      expect(urls[1]).toContain(":onboardUser");
      expect(bodies[1]).toEqual({ tierId: "free-tier", metadata: expect.any(Object) });
      expect(urls[2]).toContain(":streamGenerateContent");
      expect(bodies[2].project).toBe("onboarded-project-456");
      expect(JSON.parse(readFileSync(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json"), "utf8"))).toEqual({ projectId: "onboarded-project-456" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Code Assist 非 2xx 响应时保留响应 body 中的错误详情", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "You have exhausted your capacity on this model. Your quota will reset after 42s.",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({
            errorMessage: expect.stringContaining("quota will reset after 42s"),
          }),
        }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Code Assist 请求 401 后使用 refresh token 刷新并重试一次", async () => {
    const originalFetch = globalThis.fetch;
    const requestAuthorizations: string[] = [];
    globalThis.fetch = async (url, init) => {
      const urlText = String(url);
      if (urlText.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200 });
      }

      requestAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (requestAuthorizations.length === 1) {
        return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "expired" } }), {
          status: 401,
          statusText: "Unauthorized",
        });
      }
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "old-access",
          oauthCredentials: { access: "old-access", refresh: "refresh-token", expires: Date.now() + 3600_000 },
          env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" },
        } as never,
      );

      const events = await collectEvents(stream);

      expect(requestAuthorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("access token 临近过期时请求前主动 refresh，并通知调用方持久化新凭据", async () => {
    const originalFetch = globalThis.fetch;
    const requestAuthorizations: string[] = [];
    let refreshedCredentials: unknown;
    globalThis.fetch = async (url, init) => {
      const urlText = String(url);
      if (urlText.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-before-request", expires_in: 3600 }), { status: 200 });
      }

      requestAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "old-access",
          oauthCredentials: { access: "old-access", refresh: "refresh-token", expires: Date.now() + 30_000 },
          env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" },
          onCredentialsRefreshed: (credentials: unknown) => {
            refreshedCredentials = credentials;
          },
        } as never,
      );

      const events = await collectEvents(stream);

      expect(requestAuthorizations).toEqual(["Bearer fresh-before-request"]);
      expect(refreshedCredentials).toEqual(expect.objectContaining({ access: "fresh-before-request", refresh: "refresh-token" }));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("按 RetryInfo 重试 429 后返回成功响应", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              status: "RESOURCE_EXHAUSTED",
              message: "rate limited",
              details: [
                { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", domain: "cloudcode-pa.googleapis.com" },
                { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1ms" },
              ],
            },
          }),
          { status: 429, statusText: "Too Many Requests" },
        );
      }
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, maxRetries: 1, maxRetryDelayMs: 10 },
      );

      const events = await collectEvents(stream);

      expect(requestCount).toBe(2);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("永久配额耗尽不重试并输出明确分类", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "quota exhausted",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", domain: "cloudcode-pa.googleapis.com" },
            ],
          },
        }),
        { status: 429, statusText: "Too Many Requests" },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, maxRetries: 2 },
      );

      const events = await collectEvents(stream);

      expect(requestCount).toBe(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({ errorMessage: expect.stringContaining("QUOTA_EXHAUSTED") }),
        }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("按参考实现把 systemPrompt 作为 systemInstruction 发送", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        {
          systemPrompt: "你是编码助手",
          messages: [{ role: "user", content: "hi" }],
        } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, reasoning: "high" },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as Record<string, unknown>;
      expect(request.systemInstruction).toEqual({ parts: [{ text: "你是编码助手" }] });
      expect(request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
      expect((request.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
        thinkingLevel: "high",
        includeThoughts: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("Gemini 2.5 模型按 Pi thinking budget 发送 thinkingConfig", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, reasoning: "high" },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as Record<string, unknown>;
      expect((request.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
        thinkingBudget: 24576,
        includeThoughts: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("把 Pi toolCall 历史和 toolResult 转成 Gemini functionCall/functionResponse", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "读 README" }] },
            {
              role: "assistant",
              provider: PROVIDER_ID,
              model: "gemini-3-flash",
              content: [
                { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" }, thoughtSignature: "sig-1" },
              ],
              api: "gemini-cli-oauth-api",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "toolUse",
              timestamp: 1,
            },
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: [{ type: "text", text: "# 标题" }],
              isError: false,
              timestamp: 2,
            },
          ],
        } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as Record<string, unknown>;
      expect(request.contents).toEqual([
        { role: "user", parts: [{ text: "读 README" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: { path: "README.md" }, id: "call-1" },
              thoughtSignature: "sig-1",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "read",
                response: { output: "# 标题" },
                id: "call-1",
              },
            },
          ],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("把 toolChoice 和工具声明转成 Gemini toolConfig", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              name: "read",
              description: "读取文件",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
        } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, toolChoice: "any" },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as Record<string, unknown>;
      expect(request.tools).toEqual([
        {
          functionDeclarations: [
            expect.objectContaining({
              name: "read",
              description: "读取文件",
              parametersJsonSchema: expect.objectContaining({ type: "object" }),
            }),
          ],
        },
      ]);
      expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("把 Gemini functionCall 响应转成 Pi toolcall 事件并保留 thoughtSignature", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"README.md"},"id":"call-1"},"thoughtSignature":"sig-1"}],"role":"model"},"finishReason":"FUNCTION_CALL"}]}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "读 README" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "toolcall_start", contentIndex: 0 }),
          expect.objectContaining({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ path: "README.md" }) }),
          expect.objectContaining({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" }, thoughtSignature: "sig-1" },
          }),
          expect.objectContaining({ type: "done", reason: "toolUse", message: expect.objectContaining({ stopReason: "toolUse" }) }),
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("不把 Gemini thought part 当作普通正文输出", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"内部思考","thought":true}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"thoughtsTokenCount":3,"totalTokenCount":5}}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, reasoning: "high" },
      );

      const events = await collectEvents(stream);

      expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "内部思考" })]));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("合并 Code Assist 多段 SSE 文本并输出完整回复", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text_end", content: "Hello world" }),
          expect.objectContaining({ type: "done", message: expect.objectContaining({ stopReason: "stop" }) }),
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("按 SSE 到达顺序增量输出 text_delta", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3},"traceId":"trace-123"}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);
      const deltas = events
        .filter((event): event is { type: string; delta: string } =>
          typeof event === "object" && event !== null && (event as { type?: unknown }).type === "text_delta",
        )
        .map((event) => event.delta);

      expect(deltas).toEqual(["Hello", " world"]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "done", message: expect.objectContaining({ stopReason: "stop" }) }),
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("把 Code Assist usageMetadata 映射为 Pi usage、reasoning、cacheRead 和 cost", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"cachedContentTokenCount":3,"thoughtsTokenCount":2,"totalTokenCount":20}}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        {
          id: "gemini-2.5-flash",
          api: "gemini-cli-oauth-api",
          provider: PROVIDER_ID,
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
        } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);
      const done = events.find((event) => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "done") as { message: { usage: Record<string, unknown> } };

      expect(done.message.usage).toEqual(expect.objectContaining({
        input: 10,
        output: 5,
        cacheRead: 3,
        reasoning: 2,
        totalTokens: 20,
        cost: expect.objectContaining({ total: expect.any(Number) }),
      }));
      expect((done.message.usage.cost as { total: number }).total).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("把安全类 finishReason 映射为错误停止而不是 stop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"blocked"}],"role":"model"},"finishReason":"SAFETY"}]}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "done", reason: "error", message: expect.objectContaining({ stopReason: "error", errorMessage: expect.stringContaining("SAFETY") }) }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("把 Code Assist traceId 写回 AssistantMessage.responseId", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"traceId":"trace-123"}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      const events = await collectEvents(stream);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "done", message: expect.objectContaining({ responseId: "trace-123" }) }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("发送请求前清洗用户消息中的非法 Unicode surrogate", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "bad\uD800text" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as { contents: Array<{ parts: Array<{ text: string }> }> };
      expect(request.contents[0].parts[0].text).toBe("bad\uFFFDtext");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("默认把 Gemini thought part 输出为 thinking 事件", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"思考中","thought":true,"thoughtSignature":"think-sig"}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, reasoning: "high" } as never,
      );

      const events = await collectEvents(stream);
      const request = capturedBody?.request as { generationConfig: { thinkingConfig: { includeThoughts: boolean } } };

      expect(request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "thinking_start", contentIndex: 0 }),
        expect.objectContaining({ type: "thinking_delta", contentIndex: 0, delta: "思考中" }),
        expect.objectContaining({ type: "thinking_end", contentIndex: 0, content: "思考中" }),
        expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: "ok" }),
        expect.objectContaining({ type: "done", message: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: "thinking", thinking: "思考中", thinkingSignature: "think-sig" })]) }) }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("显式 includeThoughts=false 时不输出 Gemini thinking 事件", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"内部思考","thought":true}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, reasoning: "high", includeThoughts: false } as never,
      );

      const events = await collectEvents(stream);
      const request = capturedBody?.request as { generationConfig: { thinkingConfig: { includeThoughts: boolean } } };

      expect(request.generationConfig.thinkingConfig.includeThoughts).toBe(false);
      expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "thinking_delta" })]));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", delta: "ok" })]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Gemini 3 toolResult 图片放入 functionResponse.parts", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-3-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        {
          messages: [
            { role: "assistant", provider: PROVIDER_ID, model: "gemini-3-flash", content: [{ type: "toolCall", id: "call-1", name: "read_image", arguments: {} }], api: "gemini-cli-oauth-api", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
            { role: "toolResult", toolCallId: "call-1", toolName: "read_image", content: [{ type: "text", text: "截图" }, { type: "image", data: "abc", mimeType: "image/png" }], isError: false, timestamp: 2 },
          ],
        } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as { contents: Array<{ parts: Array<{ functionResponse?: Record<string, unknown> }> }> };
      expect(request.contents[1].parts[0].functionResponse).toEqual(expect.objectContaining({
        name: "read_image",
        response: { output: "截图" },
        id: "call-1",
        parts: [{ inlineData: { data: "abc", mimeType: "image/png" } }],
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Gemini 2.5 toolResult 图片拆成单独 user image turn", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        {
          messages: [
            { role: "assistant", provider: PROVIDER_ID, model: "gemini-2.5-flash", content: [{ type: "toolCall", id: "call-1", name: "read_image", arguments: {} }], api: "gemini-cli-oauth-api", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
            { role: "toolResult", toolCallId: "call-1", toolName: "read_image", content: [{ type: "text", text: "截图" }, { type: "image", data: "abc", mimeType: "image/png" }], isError: false, timestamp: 2 },
          ],
        } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" } },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
      expect(request.contents).toEqual([
        expect.objectContaining({ role: "model" }),
        expect.objectContaining({ role: "user", parts: [expect.objectContaining({ functionResponse: expect.objectContaining({ name: "read_image", response: { output: "截图" } }) })] }),
        { role: "user", parts: [{ inlineData: { data: "abc", mimeType: "image/png" } }] },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("把 temperature 和 maxTokens 写入 Gemini generationConfig", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        { apiKey: "access-token", env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" }, temperature: 0.2, maxTokens: 1234 },
      );

      await collectEvents(stream);

      const request = capturedBody?.request as { generationConfig: { temperature: number; maxOutputTokens: number } };
      expect(request.generationConfig.temperature).toBe(0.2);
      expect(request.generationConfig.maxOutputTokens).toBe(1234);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("合并自定义 headers 但不允许覆盖 OAuth Authorization", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "access-token",
          env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" },
          headers: { "x-debug-mode": "1", authorization: "Bearer wrong" },
        },
      );

      await collectEvents(stream);

      expect(capturedHeaders?.get("x-debug-mode")).toBe("1");
      expect(capturedHeaders?.get("authorization")).toBe("Bearer access-token");
      expect(capturedHeaders?.get("content-type")).toBe("application/json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("调用 onPayload 和 onResponse 钩子以便调试请求与响应", async () => {
    const originalFetch = globalThis.fetch;
    const seenPayloads: unknown[] = [];
    const seenResponses: unknown[] = [];
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream", "x-response-id": "resp-1" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "access-token",
          env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" },
          onPayload(payload) {
            seenPayloads.push(payload);
            return { ...(payload as Record<string, unknown>), cachedContent: "cachedContents/abc" };
          },
          onResponse(response) {
            seenResponses.push(response);
          },
        },
      );

      await collectEvents(stream);

      expect(seenPayloads).toHaveLength(1);
      expect(capturedBody?.request).toEqual(expect.objectContaining({ cachedContent: "cachedContents/abc" }));
      expect(seenResponses).toEqual([expect.objectContaining({ status: 200, headers: expect.objectContaining({ "x-response-id": "resp-1" }) })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("thinking 默认值优先级允许 options.thinking 覆盖 reasoning 派生配置", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    try {
      const stream = streamGeminiCliOAuth(
        { id: "gemini-2.5-flash", api: "gemini-cli-oauth-api", provider: PROVIDER_ID } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "access-token",
          env: { PI_GEMINI_CLI_PROJECT_ID: "codeassist-preview" },
          reasoning: "high",
          thinking: { budgetTokens: 2048, includeThoughts: true },
        } as never,
      );

      await collectEvents(stream);

      const request = capturedBody?.request as { generationConfig: { thinkingConfig: { thinkingBudget: number; includeThoughts: boolean } } };
      expect(request.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 2048, includeThoughts: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
