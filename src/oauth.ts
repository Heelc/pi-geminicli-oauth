import { createHash, randomBytes } from "node:crypto";

import {
  GEMINI_CLIENT_ID,
  GEMINI_CLIENT_SECRET,
  GEMINI_REDIRECT_URI,
  GEMINI_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
} from "./constants";

export interface OAuthCredentials extends Record<string, unknown> {
  refresh: string;
  access: string;
  expires: number;
}

export interface AuthorizationResult {
  url: string;
  verifier: string;
  state: string;
}

interface TokenPayload {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

type FetchLike = typeof fetch;

export async function createAuthorizationUrl(): Promise<AuthorizationResult> {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(32).toString("hex");

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", GEMINI_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", GEMINI_REDIRECT_URI);
  url.searchParams.set("scope", GEMINI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return { url: url.toString(), verifier, state };
}

export async function exchangeCodeForTokens(input: {
  code: string;
  verifier: string;
  fetchImpl?: FetchLike;
}): Promise<OAuthCredentials> {
  const payload = await postToken(
    new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: GEMINI_REDIRECT_URI,
      code_verifier: input.verifier,
    }),
    input.fetchImpl,
  );

  if (!payload.refresh_token) throw new Error("Google OAuth 响应缺少 refresh token");
  return toCredentials(payload, payload.refresh_token);
}

export async function refreshAccessToken(
  credentials: OAuthCredentials,
  fetchImpl?: FetchLike,
): Promise<OAuthCredentials> {
  const payload = await postToken(
    new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
    }),
    fetchImpl,
  );

  return toCredentials(payload, payload.refresh_token ?? credentials.refresh);
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike = fetch): Promise<TokenPayload> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token 请求失败：${response.status} ${response.statusText}`);
  }

  return (await response.json()) as TokenPayload;
}

function toCredentials(payload: TokenPayload, refresh: string): OAuthCredentials {
  return {
    access: payload.access_token,
    refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
