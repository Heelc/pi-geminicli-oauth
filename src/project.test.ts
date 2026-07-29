import { describe, expect, it } from "vitest";

import { loadManagedProject, onboardManagedProject, resolveEffectiveProjectId, resetProjectContextCache } from "./project";

describe("project context 稳定性", () => {
  it("并发解析同一账号和模型时复用同一个 loadCodeAssist 请求", async () => {
    resetProjectContextCache();
    let loadCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).includes(":loadCodeAssist")) {
        loadCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(JSON.stringify({ cloudaicompanionProject: { id: "managed-project" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    };

    const [left, right] = await Promise.all([
      resolveEffectiveProjectId({ accessToken: "access-token", modelId: "gemini-3-flash", fetchImpl }),
      resolveEffectiveProjectId({ accessToken: "access-token", modelId: "gemini-3-flash", fetchImpl }),
    ]);

    expect(left).toBe("managed-project");
    expect(right).toBe("managed-project");
    expect(loadCalls).toBe(1);
  });

  it("已解析出的 managed project 会被缓存，后续请求不重复探测", async () => {
    resetProjectContextCache();
    let loadCalls = 0;
    const fetchImpl = async () => {
      loadCalls += 1;
      return new Response(JSON.stringify({ cloudaicompanionProject: { id: "cached-project" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(resolveEffectiveProjectId({ accessToken: "access-token", modelId: "gemini-3-flash", fetchImpl })).resolves.toBe("cached-project");
    await expect(resolveEffectiveProjectId({ accessToken: "access-token", modelId: "gemini-3-flash", fetchImpl })).resolves.toBe("cached-project");

    expect(loadCalls).toBe(1);
  });

  it("onboardUser 返回长操作时轮询 operation 直到 managed project 完成", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes(":onboardUser")) {
        return new Response(JSON.stringify({ done: false, name: "operations/op-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("/operations/op-123")) {
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: "polled-project" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    };

    await expect(onboardManagedProject({ accessToken: "access-token", tierId: "free-tier", fetchImpl, pollDelayMs: 0 })).resolves.toBe("polled-project");
    expect(urls).toEqual(expect.arrayContaining([
      expect.stringContaining(":onboardUser"),
      expect.stringContaining("/operations/op-123"),
    ]));
  });

  it("loadCodeAssist metadata 包含 Gemini CLI 风格客户端上下文", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ cloudaicompanionProject: { id: "managed-project" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await loadManagedProject({ accessToken: "access-token", modelId: "gemini-3-flash", fetchImpl });

    expect(body?.metadata).toEqual(expect.objectContaining({
      ideType: expect.any(String),
      platform: expect.any(String),
      pluginType: "GEMINI",
      duetProject: expect.any(String),
    }));
  });
});
