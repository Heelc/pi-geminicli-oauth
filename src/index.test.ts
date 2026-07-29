import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const homeDir = vi.hoisted(() => ({ value: "/tmp/pi-geminicli-oauth-index-test-home" }));
const listenerState = vi.hoisted(() => ({
  startFails: false,
  callbackUrl: "http://localhost:8085/oauth2callback?code=auto-code&state=",
  close: vi.fn(async () => {}),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => homeDir.value,
  };
});

vi.mock("./oauth-listener", () => ({
  startOAuthCallbackListener: vi.fn(async () => {
    if (listenerState.startFails) throw new Error("端口被占用");
    return {
      origin: "http://localhost:8085",
      waitForCallback: async () => new URL(listenerState.callbackUrl),
      close: listenerState.close,
    };
  }),
}));

describe("registerGeminiCliOAuth login", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    listenerState.startFails = false;
    listenerState.callbackUrl = "http://localhost:8085/oauth2callback?code=auto-code&state=";
    listenerState.close.mockClear();
    delete process.env.PI_GEMINI_CLI_OAUTH_HEADLESS;
  });

  it("优先通过本地 callback listener 自动获取授权码，并可选保存用户级 projectId 配置", async ({ task }) => {
    homeDir.value = task.file!.filepath.replace(/index\.test\.ts$/, "tmp-login-home-config");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { default: registerGeminiCliOAuth } = await import("./index");
    let login: NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["oauth"]>["login"] | undefined;
    const pi = {
      registerProvider: vi.fn((_id, provider) => {
        login = provider.oauth?.login;
      }),
    } as unknown as ExtensionAPI;
    registerGeminiCliOAuth(pi);

    const onPrompt = vi.fn().mockResolvedValueOnce(" enterprise-project ");
    const credentials = await login!({
      onAuth: vi.fn(({ url }) => {
        const state = new URL(url).searchParams.get("state");
        listenerState.callbackUrl = `http://localhost:8085/oauth2callback?code=auto-code&state=${state}`;
      }),
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(),
      onPrompt,
    });

    const configPath = join(homeDir.value, ".pi", "agent", "gemini-cli-oauth.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ projectId: "enterprise-project" });
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("code=auto-code");
    expect(credentials.access).toBe("access-token");
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(listenerState.close).toHaveBeenCalledOnce();
  });

  it("本地 listener 启动失败时回退到手动粘贴授权码", async ({ task }) => {
    homeDir.value = task.file!.filepath.replace(/index\.test\.ts$/, "tmp-login-fallback-home-config");
    listenerState.startFails = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { default: registerGeminiCliOAuth } = await import("./index");
    let login: NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["oauth"]>["login"] | undefined;
    const pi = {
      registerProvider: vi.fn((_id, provider) => {
        login = provider.oauth?.login;
      }),
    } as unknown as ExtensionAPI;
    registerGeminiCliOAuth(pi);

    await login!({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(),
      onPrompt: vi.fn().mockResolvedValueOnce("manual-code").mockResolvedValueOnce("   "),
    });

    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("code=manual-code");
  });

  it("登录时 projectId 留空不创建用户级配置", async ({ task }) => {
    homeDir.value = task.file!.filepath.replace(/index\.test\.ts$/, "tmp-login-empty-home-config");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { default: registerGeminiCliOAuth } = await import("./index");
    let login: NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["oauth"]>["login"] | undefined;
    const pi = {
      registerProvider: vi.fn((_id, provider) => {
        login = provider.oauth?.login;
      }),
    } as unknown as ExtensionAPI;
    registerGeminiCliOAuth(pi);

    await login!({
      onAuth: vi.fn(({ url }) => {
        const state = new URL(url).searchParams.get("state");
        listenerState.callbackUrl = `http://localhost:8085/oauth2callback?code=auto-code&state=${state}`;
      }),
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(),
      onPrompt: vi.fn().mockResolvedValueOnce("   "),
    });

    expect(existsSync(join(homeDir.value, ".pi", "agent", "gemini-cli-oauth.json"))).toBe(false);
  });
});

describe("registerGeminiCliOAuth gemini-quota command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("access token 过期时先刷新再查询 quota", async ({ task }) => {
    homeDir.value = task.file!.filepath.replace(/index\.test\.ts$/, "tmp-quota-refresh-home-config");
    const agentDir = join(homeDir.value, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      "gemini-cli-oauth": { access: "expired-access", refresh: "refresh-token", expires: 1 },
    }));
    writeFileSync(join(agentDir, "gemini-cli-oauth.json"), JSON.stringify({ projectId: "codeassist-preview" }));

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        buckets: [
          { modelId: "gemini-3-flash", remainingFraction: 0.5595, resetTime: "2026-07-02T04:45:17Z", tokenType: "REQUESTS" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const { default: registerGeminiCliOAuth } = await import("./index");
    let handler: ((args: unknown, ctx: { cwd: string; model?: { id: string }; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
    const pi = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn((_name, command) => {
        handler = command.handler;
      }),
    } as unknown as ExtensionAPI;
    registerGeminiCliOAuth(pi);

    const notify = vi.fn();
    await handler!({}, { cwd: homeDir.value, model: { id: "gemini-3-flash" }, ui: { notify } });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[1]?.headers)).not.toContain("expired-access");
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["gemini-cli-oauth"].access).toBe("fresh-access");
    expect(notify.mock.calls[0]?.[0]).toContain("56.0%");
  });
});
