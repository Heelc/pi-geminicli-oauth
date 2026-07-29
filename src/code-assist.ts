import { randomUUID } from "node:crypto";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";
import { buildGeminiCliUserAgent } from "./user-agent";

const PROCESS_SESSION_ID = randomUUID();

export interface CodeAssistWrappedBody {
  project: string;
  model: string;
  user_prompt_id: string;
  request: unknown;
}

export interface CodeAssistHeadersInput {
  accessToken?: string;
  modelId: string;
  stream: boolean;
  headers?: Record<string, string | null>;
}

export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}

export function buildCodeAssistRequest(input: {
  modelId: string;
  projectId: string;
  payload: unknown;
  stream: boolean;
  accessToken?: string;
  headers?: Record<string, string | null>;
}): { url: string; body: CodeAssistWrappedBody; headers: Headers } {
  const action = input.stream ? "streamGenerateContent" : "generateContent";
  const suffix = input.stream ? "?alt=sse" : "";

  return {
    url: `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${action}${suffix}`,
    body: {
      project: input.projectId,
      model: input.modelId,
      user_prompt_id: randomUUID(),
      request: normalizeCodeAssistPayload(input.payload),
    },
    headers: buildCodeAssistHeaders(input),
  };
}

export function buildCodeAssistHeaders(input: CodeAssistHeadersInput): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.toLowerCase() === "authorization") continue;
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  if (input.accessToken) headers.set("Authorization", `Bearer ${input.accessToken}`);
  if (input.stream) headers.set("Accept", "text/event-stream");
  headers.set("User-Agent", buildGeminiCliUserAgent(input.modelId));
  headers.set("x-activity-request-id", createGeminiActivityRequestId());
  return headers;
}

export function normalizeCodeAssistPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const normalized = { ...(payload as Record<string, unknown>) };
  normalizeThinking(normalized);
  normalizeCachedContent(normalized);
  stripThoughtPartsFromHistory(normalized);
  normalizeIdentifiers(normalized);
  return normalized;
}

export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") return undefined;

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel = typeof levelRaw === "string" && levelRaw.trim() ? levelRaw.trim().toLowerCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (thinkingBudget === undefined && thinkingLevel === undefined && includeThoughts === undefined) return undefined;

  const thinkingEnabled = (thinkingBudget !== undefined && thinkingBudget > 0) || thinkingLevel !== undefined;
  return {
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    includeThoughts: thinkingEnabled ? includeThoughts ?? false : false,
  };
}

function normalizeThinking(payload: Record<string, unknown>): void {
  const generationConfig =
    payload.generationConfig && typeof payload.generationConfig === "object"
      ? { ...(payload.generationConfig as Record<string, unknown>) }
      : undefined;
  const rootThinking = Object.prototype.hasOwnProperty.call(payload, "thinkingConfig")
    ? payload.thinkingConfig
    : undefined;
  const existingThinking = generationConfig?.thinkingConfig;
  const normalizedThinking = normalizeThinkingConfig(rootThinking ?? existingThinking);

  delete payload.thinkingConfig;
  if (!normalizedThinking) return;

  payload.generationConfig = {
    ...(generationConfig ?? {}),
    thinkingConfig: normalizedThinking,
  };
}

function normalizeCachedContent(payload: Record<string, unknown>): void {
  const extraBody = payload.extra_body && typeof payload.extra_body === "object"
    ? { ...(payload.extra_body as Record<string, unknown>) }
    : undefined;
  const cachedContent =
    payload.cached_content ??
    payload.cachedContent ??
    extraBody?.cached_content ??
    extraBody?.cachedContent;

  if (typeof cachedContent === "string" && cachedContent.trim()) {
    payload.cachedContent = cachedContent.trim();
  }

  delete payload.cached_content;
  if (!extraBody) return;

  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete payload.extra_body;
  } else {
    payload.extra_body = extraBody;
  }
}

function stripThoughtPartsFromHistory(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.contents)) return;

  const sanitizedContents: unknown[] = [];
  for (const content of payload.contents) {
    if (!content || typeof content !== "object") {
      sanitizedContents.push(content);
      continue;
    }

    const record = content as Record<string, unknown>;
    if (!Array.isArray(record.parts)) {
      sanitizedContents.push(content);
      continue;
    }

    const parts = record.parts.filter((part) => {
      if (!part || typeof part !== "object") return true;
      return (part as Record<string, unknown>).thought !== true;
    });

    if (parts.length === 0 && record.role === "model") continue;
    sanitizedContents.push({ ...record, parts });
  }

  payload.contents = sanitizedContents;
}

function normalizeIdentifiers(payload: Record<string, unknown>): void {
  if (!payload.session_id) payload.session_id = PROCESS_SESSION_ID;
  delete payload.sessionId;
}


function createGeminiActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

export function unwrapCodeAssistBody<T>(body: T): unknown {
  if (body && typeof body === "object" && "response" in body) {
    const record = body as { response: unknown; traceId?: unknown };
    return injectResponseId(record.response, record.traceId);
  }
  return injectResponseId(body, undefined);
}

export function parseCodeAssistSse(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => transformSseLine(line));
}

function transformSseLine(line: string): string {
  if (!line.startsWith("data:")) return line;

  const rawJson = line.slice(5).trim();
  if (!rawJson) return line;

  try {
    return `data: ${JSON.stringify(unwrapCodeAssistBody(JSON.parse(rawJson)))}`;
  } catch {
    return line;
  }
}

function injectResponseId(body: unknown, traceId: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const source = body as Record<string, unknown>;
  const effectiveTraceId = typeof traceId === "string" ? traceId : source.traceId;
  if (typeof effectiveTraceId !== "string" && !("traceId" in source)) return body;

  const record = { ...source };
  if (typeof effectiveTraceId === "string" && typeof record.responseId !== "string") {
    record.responseId = effectiveTraceId;
  }
  delete record.traceId;
  return record;
}

export function formatCodeAssistError(response: Response, body: string): string {
  const detail = extractCodeAssistErrorMessage(body);
  const base = `Gemini Code Assist 请求失败：${response.status} ${response.statusText}`;
  return detail ? `${base} - ${detail}` : base;
}

function extractCodeAssistErrorMessage(body: string): string | undefined {
  if (!body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown; details?: unknown } };
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
    const status = typeof parsed.error?.status === "string" ? parsed.error.status : undefined;
    const detailReasons = Array.isArray(parsed.error?.details)
      ? parsed.error.details
          .flatMap((detail) => extractDetailTokens(detail))
          .filter(Boolean)
      : [];
    return [status, message, ...detailReasons].filter(Boolean).join(": ") || undefined;
  } catch {
    return body.slice(0, 500);
  }
}

function extractDetailTokens(detail: unknown): string[] {
  if (!detail || typeof detail !== "object") return [];
  const record = detail as Record<string, unknown>;
  return [record.reason, record.domain]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
