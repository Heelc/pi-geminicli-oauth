import { describe, expect, it } from "vitest";

import { GEMINI_CLIENT_ID, GEMINI_REDIRECT_URI, GEMINI_SCOPES } from "./constants";
import { createAuthorizationUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth";

describe("createAuthorizationUrl", () => {
  it("创建 Gemini CLI OAuth PKCE 授权 URL", async () => {
    const auth = await createAuthorizationUrl();
    const url = new URL(auth.url);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GEMINI_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(GEMINI_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(GEMINI_SCOPES.join(" "));
    expect(auth.verifier.length).toBeGreaterThan(40);
    expect(auth.state.length).toBeGreaterThan(20);
  });
});

describe("exchangeCodeForTokens", () => {
  it("使用授权码和 verifier 换取 OAuth 凭据", async () => {
    let body = "";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const credentials = await exchangeCodeForTokens({ code: "auth-code", verifier: "pkce-verifier", fetchImpl });

    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code");
    expect(body).toContain("code_verifier=pkce-verifier");
    expect(credentials.access).toBe("access-token");
    expect(credentials.refresh).toBe("refresh-token");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });
});

describe("refreshAccessToken", () => {
  it("使用 refresh token 刷新 access token 并保留旧 refresh token", async () => {
    let body = "";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 1800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const credentials = await refreshAccessToken(
      { access: "old-access", refresh: "old-refresh", expires: 1 },
      fetchImpl,
    );

    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
    expect(credentials.access).toBe("new-access-token");
    expect(credentials.refresh).toBe("old-refresh");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });
});
