import { request } from "node:http";

import { describe, expect, it } from "vitest";

import { startOAuthCallbackListener } from "./oauth-listener";

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startOAuthCallbackListener", () => {
  it("监听本地 OAuth callback 并返回 code/state", async () => {
    const listener = await startOAuthCallbackListener({ port: 0, timeoutMs: 1_000 });
    try {
      const callback = listener.waitForCallback();
      const response = await get(`${listener.origin}/oauth2callback?code=auth-code&state=expected-state`);
      const url = await callback;

      expect(response.status).toBe(200);
      expect(response.body).toContain("授权成功");
      expect(url.searchParams.get("code")).toBe("auth-code");
      expect(url.searchParams.get("state")).toBe("expected-state");
    } finally {
      await listener.close();
    }
  });

  it("忽略缺少 code/state 的不完整 callback", async () => {
    const listener = await startOAuthCallbackListener({ port: 0, timeoutMs: 100 });
    try {
      const callback = listener.waitForCallback();
      const response = await get(`${listener.origin}/oauth2callback?code=auth-code`);

      await expect(callback).rejects.toThrow("等待 OAuth callback 超时");
      expect(response.status).toBe(400);
    } finally {
      await listener.close();
    }
  });
});
