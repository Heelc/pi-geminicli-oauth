import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PROVIDER_ID } from "./constants";
import { resolveProjectId, saveUserProjectIdConfig } from "./config";
import { createAuthorizationUrl, exchangeCodeForTokens, refreshAccessToken, type OAuthCredentials } from "./oauth";
import { startOAuthCallbackListener } from "./oauth-listener";
import { GEMINI_CLI_OAUTH_API, GEMINI_CLI_OAUTH_MODELS, streamGeminiCliOAuth } from "./stream";
import { formatGeminiQuota, retrieveUserQuota } from "./quota";

export default function registerGeminiCliOAuth(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Gemini CLI OAuth",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    api: GEMINI_CLI_OAUTH_API,
    models: GEMINI_CLI_OAUTH_MODELS,
    oauth: {
      name: "Gemini CLI OAuth",
      login,
      refreshToken: (credentials) => refreshAccessToken(credentials),
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: (model, context, options) => streamGeminiCliOAuth(model, context, {
      ...options,
      onCredentialsRefreshed: saveCredentials,
    } as never),
  });

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("gemini-quota", {
    description: "Show Gemini Code Assist quota for gemini-cli-oauth",
    async handler(_args, ctx) {
      try {
        const credentials = await ensureFreshCredentials(readSavedCredentials());
        if (!credentials?.access) {
          ctx.ui.notify("请先运行 /login gemini-cli-oauth。", "error");
          return;
        }

        const projectId = resolveProjectId({ cwd: ctx.cwd });
        if (!projectId) {
          ctx.ui.notify("缺少 projectId，无法查询 Gemini quota。", "error");
          return;
        }

        const quota = await retrieveUserQuota({
          accessToken: credentials.access,
          projectId,
          modelId: ctx.model?.id,
        });
        ctx.ui.notify(formatGeminiQuota(projectId, quota), quota?.buckets?.length ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Gemini quota 查询失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function readSavedCredentials(): Partial<OAuthCredentials> | undefined {
  try {
    const auth = JSON.parse(readFileSync(getAuthPath(), "utf8")) as Record<string, Partial<OAuthCredentials>>;
    return auth[PROVIDER_ID];
  } catch {
    return undefined;
  }
}

async function ensureFreshCredentials(credentials: Partial<OAuthCredentials> | undefined): Promise<Partial<OAuthCredentials> | undefined> {
  if (!credentials?.access || !shouldRefreshCredentials(credentials)) return credentials;
  if (!credentials.refresh || typeof credentials.expires !== "number") return credentials;

  const refreshed = await refreshAccessToken(credentials as OAuthCredentials);
  saveCredentials(refreshed);
  return refreshed;
}

function shouldRefreshCredentials(credentials: Partial<OAuthCredentials>): boolean {
  return typeof credentials.expires === "number" && credentials.expires <= Date.now() + 60_000;
}

function saveCredentials(credentials: OAuthCredentials): void {
  const authPath = getAuthPath();
  let auth: Record<string, Partial<OAuthCredentials>> = {};
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Partial<OAuthCredentials>>;
  } catch {
    auth = {};
  }
  auth[PROVIDER_ID] = { ...auth[PROVIDER_ID], ...credentials };
  writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
}

function getAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

async function login(callbacks: Parameters<NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["oauth"]>["login"]>[0]) {
  const authorization = await createAuthorizationUrl();
  const listener = await maybeStartCallbackListener();
  callbacks.onAuth({ url: authorization.url });

  const code = listener
    ? await waitForAuthorizationCode(listener, authorization.state)
    : await promptForAuthorizationCode(callbacks);

  const projectId = await callbacks.onPrompt({
    message: "请输入 Google Cloud projectId（可留空；非空时会保存到 ~/.pi/agent/gemini-cli-oauth.json）：",
  });
  saveUserProjectIdConfig(projectId);

  return exchangeCodeForTokens({ code, verifier: authorization.verifier });
}

function extractCode(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("code") ?? trimmed;
  } catch {
    return trimmed;
  }
}

async function maybeStartCallbackListener(): Promise<Awaited<ReturnType<typeof startOAuthCallbackListener>> | undefined> {
  if (isHeadlessLogin()) return undefined;

  try {
    return await startOAuthCallbackListener();
  } catch {
    return undefined;
  }
}

function isHeadlessLogin(): boolean {
  return Boolean(
    process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.PI_GEMINI_CLI_OAUTH_HEADLESS,
  );
}

async function waitForAuthorizationCode(
  listener: Awaited<ReturnType<typeof startOAuthCallbackListener>>,
  expectedState: string,
): Promise<string> {
  try {
    while (true) {
      const callbackUrl = await listener.waitForCallback();
      const error = callbackUrl.searchParams.get("error");
      if (error) throw new Error(callbackUrl.searchParams.get("error_description") ?? error);

      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");
      if (!code || state !== expectedState) continue;
      return code;
    }
  } finally {
    await listener.close();
  }
}

async function promptForAuthorizationCode(
  callbacks: Parameters<NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["oauth"]>["login"]>[0],
): Promise<string> {
  const code = await callbacks.onPrompt({
    message: "请完成 Google 授权后，粘贴回调 URL 中的 code 参数或直接粘贴授权码：",
  });
  return extractCode(code);
}
