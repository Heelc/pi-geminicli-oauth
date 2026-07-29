import { createServer, type Server } from "node:http";

import { GEMINI_REDIRECT_URI } from "./constants";

export interface OAuthCallbackListener {
  origin: string;
  waitForCallback(): Promise<URL>;
  close(): Promise<void>;
}

interface StartOAuthCallbackListenerOptions {
  port?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function startOAuthCallbackListener(
  options: StartOAuthCallbackListenerOptions = {},
): Promise<OAuthCallbackListener> {
  const redirectUri = new URL(GEMINI_REDIRECT_URI);
  const port = options.port ?? Number.parseInt(redirectUri.port || "80", 10);
  const callbackPath = redirectUri.pathname || "/";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const callbackQueue: URL[] = [];
  const waiters: Array<{ resolve: (url: URL) => void; reject: (error: Error) => void }> = [];
  let terminalError: Error | undefined;
  let origin = `${redirectUri.protocol}//${redirectUri.hostname}:${port}`;

  const deliver = (url: URL) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(url);
      return;
    }
    callbackQueue.push(url);
  };

  const failWaiters = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    while (waiters.length > 0) waiters.shift()?.reject(error);
  };

  const timeout = setTimeout(() => failWaiters(new Error("等待 OAuth callback 超时")), timeoutMs);
  timeout.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("无效请求");
      return;
    }

    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const hasError = !!url.searchParams.get("error");
    const hasCode = !!url.searchParams.get("code");
    const hasState = !!url.searchParams.get("state");
    if (!hasError && (!hasCode || !hasState)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("OAuth callback 缺少 code 或 state，请回到 Google 授权流程。");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Gemini CLI OAuth</title></head><body><h1>授权成功</h1><p>可以关闭此窗口并返回 Pi。</p></body></html>`);
    deliver(url);
  });

  await listen(server, port);
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  origin = `${redirectUri.protocol}//${redirectUri.hostname}:${actualPort}`;

  server.on("error", (error) => failWaiters(error instanceof Error ? error : new Error(String(error))));

  return {
    origin,
    waitForCallback: async () => {
      if (callbackQueue.length > 0) return callbackQueue.shift() as URL;
      if (terminalError) throw terminalError;
      return await new Promise<URL>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    close: async () => {
      clearTimeout(timeout);
      await close(server);
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
