import {
  type AssistantMessage,
  type Context,
  type Api,
  type Model,
  type SimpleStreamOptions as PiSimpleStreamOptions,
  type StopReason,
  type Tool,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import { buildCodeAssistRequest, formatCodeAssistError, parseCodeAssistSse, unwrapCodeAssistBody } from "./code-assist";
import { PROVIDER_ID } from "./constants";
import { resolveProjectId, saveUserProjectIdConfig } from "./config";
import { refreshAccessToken, type OAuthCredentials } from "./oauth";
import {
  getCodeAssistRetryDelayMs,
  getRetryCooldownMs,
  isRetryableNetworkError,
  recordRetryCooldown,
  shouldRetryCodeAssistResponse,
  wait,
} from "./retry";
import { resolveEffectiveProjectId } from "./project";
import { createGeminiDebugLogger, type GeminiDebugLogger } from "./debug";

type GeminiCliOAuthApi = "gemini-cli-oauth-api";

interface SimpleStreamOptions extends PiSimpleStreamOptions {
  cwd?: string;
  homeDir?: string;
  toolChoice?: "auto" | "none" | "any";
  includeThoughts?: boolean;
  thinking?: { budgetTokens?: number; level?: string; includeThoughts?: boolean; enabled?: boolean };
  oauthCredentials?: OAuthCredentials;
  disableManagedProject?: boolean;
  onCredentialsRefreshed?: (credentials: OAuthCredentials) => void | Promise<void>;
  debugLogPath?: string;
}

interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: GeminiResponsePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  traceId?: string;
  responseId?: string;
}

interface TextStreamState {
  contentIndex?: number;
  type?: "text" | "thinking";
  text: string;
}

export function streamGeminiCliOAuth(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
) {
  const stream = createAssistantMessageEventStream();

  (async () => {
    try {
      if (!options.apiKey) {
        throw new Error("缺少 Gemini CLI OAuth access token。请先运行 /login gemini-cli-oauth。");
      }

      let accessToken = options.apiKey;
      let oauthCredentials = options.oauthCredentials;
      if (shouldRefreshOauthCredentials(oauthCredentials)) {
        oauthCredentials = await refreshAccessToken(oauthCredentials);
        accessToken = oauthCredentials.access;
        await options.onCredentialsRefreshed?.(oauthCredentials);
      }

      const debugLogger = createGeminiDebugLogger({ env: options.env, logPath: options.debugLogPath });
      const configuredProjectId = resolveProjectId({ env: options.env, cwd: options.cwd, homeDir: options.homeDir });
      const projectId = await resolveEffectiveProjectId({
        configuredProjectId,
        accessToken,
        modelId: model.id,
        disableManagedProject: options.disableManagedProject,
        onManagedProjectResolved: (managedProjectId) => {
          saveUserProjectIdConfig(managedProjectId, { homeDir: options.homeDir });
        },
      });
      if (!projectId) {
        throw new Error(
          "缺少 projectId。请设置 PI_GEMINI_CLI_PROJECT_ID，或在 .pi/gemini-cli-oauth.json 中配置 projectId。",
        );
      }

      const output = createBaseMessage(model);
      stream.push({ type: "start", partial: output });

      const generationConfig = buildGenerationConfig(model.id, options);
      const basePayload = {
        systemInstruction: context.systemPrompt ? { parts: [{ text: context.systemPrompt }] } : undefined,
        contents: convertContextMessages(context, model),
        tools: context.tools?.length ? convertContextTools(context.tools) : undefined,
        toolConfig: context.tools?.length && options.toolChoice ? { functionCallingConfig: { mode: mapToolChoice(options.toolChoice) } } : undefined,
        ...(generationConfig ? { generationConfig } : {}),
      };
      const payload = await applyPayloadHook(basePayload, model, options);
      const response = await sendCodeAssistRequestWithRecovery({
        modelId: model.id,
        projectId,
        payload,
        accessToken,
        oauthCredentials,
        signal: options.signal,
        maxRetries: options.maxRetries,
        maxRetryDelayMs: options.maxRetryDelayMs,
        headers: options.headers,
        onCredentialsRefreshed: options.onCredentialsRefreshed,
        debugLogger,
      });
      await callResponseHook(response, model, options);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(formatCodeAssistError(response, errorBody));
      }

      const textState: TextStreamState = { text: "" };
      const includeThoughts = shouldIncludeThoughts(options);
      if (response.body) {
        await applyGeminiSseStream(model, output, response.body, stream, textState, includeThoughts);
      } else {
        const text = await response.text();
        applyGeminiSseText(model, output, text, stream, textState, includeThoughts);
      }
      finalizeTextBlock(output, stream, textState);

      stream.push({ type: "done", reason: getDoneReason(output.stopReason), message: output } as never);
      stream.end(output);
    } catch (error) {
      const output = createBaseMessage(model);
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();

  return stream;
}

interface CodeAssistSendInput {
  modelId: string;
  projectId: string;
  payload: unknown;
  accessToken: string;
  oauthCredentials?: OAuthCredentials;
  signal?: AbortSignal;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  headers?: SimpleStreamOptions["headers"];
  onCredentialsRefreshed?: (credentials: OAuthCredentials) => void | Promise<void>;
  debugLogger?: GeminiDebugLogger;
  }

async function sendCodeAssistRequestWithRecovery(input: CodeAssistSendInput): Promise<Response> {
  let accessToken = input.accessToken;
  let credentials = input.oauthCredentials;
  let refreshedAfter401 = false;
  let attempt = 0;
  const maxRetries = input.maxRetries ?? 2;
  const maxRetryDelayMs = input.maxRetryDelayMs ?? 60_000;

  while (true) {
    try {
      const request = buildCodeAssistRequest({ modelId: input.modelId, projectId: input.projectId, payload: input.payload, stream: true, accessToken, headers: input.headers });
      const cooldownKey = `${request.url}|${input.projectId}|${input.modelId}`;
      const cooldownMs = getRetryCooldownMs(cooldownKey);
      if (cooldownMs > 0) {
        input.debugLogger?.logRetry({ attempt, delayMs: cooldownMs, reason: "cooldown" });
        await wait(cooldownMs);
      }

      const startedAt = Date.now();
      input.debugLogger?.logRequest({ url: request.url, method: "POST", headers: request.headers, body: request.body, projectId: input.projectId, modelId: input.modelId });
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: input.signal,
      });
      input.debugLogger?.logResponse({
        status: response.status,
        statusText: response.statusText,
        traceId: response.headers.get("x-cloudaicompanion-trace-id") ?? undefined,
        durationMs: Date.now() - startedAt,
      });

      if (response.status === 401 && credentials?.refresh && !refreshedAfter401) {
        refreshedAfter401 = true;
        credentials = await refreshAccessToken(credentials);
        accessToken = credentials.access;
        await input.onCredentialsRefreshed?.(credentials);
        continue;
      }

      if (await shouldRetryCodeAssistResponse(response, attempt, maxRetries)) {
        const delayMs = await getCodeAssistRetryDelayMs(response, attempt, maxRetryDelayMs);
        if (response.status === 429) recordRetryCooldown(cooldownKey, delayMs);
        input.debugLogger?.logRetry({ attempt: attempt + 1, delayMs, reason: response.statusText || String(response.status) });
        await wait(delayMs);
        attempt += 1;
        continue;
      }

      return response;
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableNetworkError(error)) throw error;
      const delayMs = Math.min(1000 * 2 ** attempt, maxRetryDelayMs);
      input.debugLogger?.logRetry({ attempt: attempt + 1, delayMs, reason: error instanceof Error ? error.message : String(error) });
      await wait(delayMs);
      attempt += 1;
    }
  }
}

function createBaseMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function applyGeminiBodyToMessage(
  model: Model<Api>,
  output: AssistantMessage,
  rawBody: GeminiResponseBody,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  includeThoughts: boolean,
): void {
  const body = unwrapCodeAssistBody(rawBody) as GeminiResponseBody;
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.text !== undefined) {
      if (part.thought === true) {
        if (includeThoughts) appendThinking(output, stream, textState, part.text, part.thoughtSignature);
      } else appendText(output, stream, textState, part.text);
  }
  }

  for (const part of parts) {
    if (part.functionCall) {
      finalizeTextBlock(output, stream, textState);
      textState.contentIndex = undefined;
      textState.text = "";
      appendToolCall(output, stream, part);
    }
  }

  const candidate = body.candidates?.[0];
  if (candidate?.finishReason) {
    output.stopReason = mapGeminiStopReason(candidate.finishReason);
    if (output.stopReason === "error") output.errorMessage = `Gemini finishReason: ${candidate.finishReason}`;
  }
  const responseId = body.responseId ?? body.traceId;
  if (responseId) output.responseId = responseId;
  if (body.usageMetadata) {
    output.usage.input = body.usageMetadata.promptTokenCount ?? output.usage.input;
    output.usage.output = body.usageMetadata.candidatesTokenCount ?? output.usage.output;
    output.usage.cacheRead = body.usageMetadata.cachedContentTokenCount ?? output.usage.cacheRead;
    output.usage.totalTokens = body.usageMetadata.totalTokenCount ?? output.usage.input + output.usage.output;
    if (body.usageMetadata.thoughtsTokenCount !== undefined) {
      (output.usage as typeof output.usage & { reasoning?: number }).reasoning = body.usageMetadata.thoughtsTokenCount;
    }
    if ("cost" in model && model.cost) calculateCost(model, output.usage);
}
}

function appendText(
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  text: string,
): void {
  if (textState.contentIndex !== undefined && textState.type !== "text") finalizeTextBlock(output, stream, textState);
  if (textState.contentIndex === undefined) {
    textState.contentIndex = output.content.length;
    textState.type = "text";
    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: textState.contentIndex, partial: output });
  }

  const block = output.content[textState.contentIndex];
  if (block?.type === "text") block.text += text;
  textState.text += text;
  stream.push({ type: "text_delta", contentIndex: textState.contentIndex, delta: text, partial: output });
}

function appendThinking(
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  thinking: string,
  signature?: string,
): void {
  if (textState.contentIndex !== undefined && textState.type !== "thinking") finalizeTextBlock(output, stream, textState);
  if (textState.contentIndex === undefined) {
    textState.contentIndex = output.content.length;
    textState.type = "thinking";
    output.content.push({ type: "thinking", thinking: "" } as never);
    stream.push({ type: "thinking_start", contentIndex: textState.contentIndex, partial: output } as never);
  }

  const block = output.content[textState.contentIndex] as { type?: string; thinking?: string; thinkingSignature?: string } | undefined;
  if (block?.type === "thinking") {
    block.thinking = `${block.thinking ?? ""}${thinking}`;
    if (signature) block.thinkingSignature = block.thinkingSignature ?? signature;
  }
  textState.text += thinking;
  stream.push({ type: "thinking_delta", contentIndex: textState.contentIndex, delta: thinking, partial: output } as never);
}

function appendToolCall(
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  part: GeminiResponsePart,
): void {
  const functionCall = part.functionCall;
  if (!functionCall) return;

  const contentIndex = output.content.length;
  const toolCall = {
    type: "toolCall" as const,
    id: functionCall.id || `${functionCall.name ?? "tool"}_${Date.now()}_${contentIndex}`,
    name: functionCall.name ?? "",
    arguments: functionCall.args ?? {},
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function finalizeTextBlock(
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
): void {
  if (textState.contentIndex === undefined) return;
  if (textState.type === "thinking") {
    stream.push({ type: "thinking_end", contentIndex: textState.contentIndex, content: textState.text, partial: output } as never);
  } else {
    stream.push({ type: "text_end", contentIndex: textState.contentIndex, content: textState.text, partial: output });
  }
  textState.contentIndex = undefined;
  textState.type = undefined;
  textState.text = "";
}

function applyGeminiSseText(
  model: Model<Api>,
  output: AssistantMessage,
  text: string,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  includeThoughts: boolean,
): void {
  for (const line of parseCodeAssistSse(text)) {
    applyGeminiSseLine(model, output, line, stream, textState, includeThoughts);
  }
}

async function applyGeminiSseStream(
  model: Model<Api>,
  output: AssistantMessage,
  body: ReadableStream<Uint8Array>,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  includeThoughts: boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      applyGeminiSseText(model, output, `${line}\n`, stream, textState, includeThoughts);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) applyGeminiSseText(model, output, buffer, stream, textState, includeThoughts);
}

function applyGeminiSseLine(
  model: Model<Api>,
  output: AssistantMessage,
  line: string,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  textState: TextStreamState,
  includeThoughts: boolean,
): void {
  if (!line.startsWith("data:")) return;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return;
  try {
    applyGeminiBodyToMessage(model, output, JSON.parse(json) as GeminiResponseBody, stream, textState, includeThoughts);
  } catch {
    // 忽略无法解析的 SSE 行，保持与流式协议容错一致。
  }
}

function shouldIncludeThoughts(options: SimpleStreamOptions): boolean {
  if (options.thinking?.enabled === false) return false;
  if (options.thinking?.includeThoughts !== undefined) return options.thinking.includeThoughts;
  return options.includeThoughts !== false;
}

function buildGenerationConfig(modelId: string, options: SimpleStreamOptions): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
  const thinkingConfig = buildThinkingConfig(modelId, options.reasoning, options.thinkingBudgets, shouldIncludeThoughts(options), options.thinking);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;
  return Object.keys(config).length > 0 ? config : undefined;
}

async function applyPayloadHook(payload: Record<string, unknown>, model: Model<Api>, options: SimpleStreamOptions): Promise<unknown> {
  if (!options.onPayload) return payload;
  const replaced = await options.onPayload(payload, model);
  return replaced === undefined ? payload : replaced;
}

async function callResponseHook(response: Response, model: Model<Api>, options: SimpleStreamOptions): Promise<void> {
  if (!options.onResponse) return;
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  await options.onResponse({ status: response.status, headers }, model);
}


function buildThinkingConfig(
  modelId: string,
  reasoning: SimpleStreamOptions["reasoning"],
  customBudgets?: SimpleStreamOptions["thinkingBudgets"],
  includeThoughts = false,
  explicitThinking?: SimpleStreamOptions["thinking"],
): Record<string, unknown> | undefined {
  if (explicitThinking) {
    if (explicitThinking.enabled === false) return { includeThoughts: false };
    if (explicitThinking.budgetTokens !== undefined) return { thinkingBudget: explicitThinking.budgetTokens, includeThoughts: explicitThinking.includeThoughts ?? includeThoughts };
    if (explicitThinking.level !== undefined) return { thinkingLevel: explicitThinking.level, includeThoughts: explicitThinking.includeThoughts ?? includeThoughts };
    if (explicitThinking.includeThoughts !== undefined && reasoning) includeThoughts = explicitThinking.includeThoughts;
  }
  if (!reasoning) return undefined;
  if (modelId.includes("2.5-flash")) {
    return { thinkingBudget: getCustomThinkingBudget(customBudgets, reasoning) ?? getThinkingBudget(reasoning, 24576), includeThoughts };
  }
  if (modelId.includes("2.5-pro")) {
    return { thinkingBudget: getCustomThinkingBudget(customBudgets, reasoning) ?? getThinkingBudget(reasoning, 32768), includeThoughts };
  }
  return { thinkingLevel: reasoning, includeThoughts };
}

function getCustomThinkingBudget(
  customBudgets: SimpleStreamOptions["thinkingBudgets"] | undefined,
  reasoning: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): number | undefined {
  if (reasoning === "xhigh") return customBudgets?.high;
  return customBudgets?.[reasoning];
}

function getThinkingBudget(reasoning: Exclude<SimpleStreamOptions["reasoning"], undefined>, highBudget: number): number {
  switch (reasoning) {
    case "minimal":
      return 128;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
    case "xhigh":
    default:
      return highBudget;
  }
}

function convertContextMessages(context: Context, model: Model<Api>): Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> {
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      const parts = Array.isArray(message.content)
        ? (message.content.map(contentToGeminiPart).filter(Boolean) as Array<Record<string, unknown>>)
        : [{ text: cleanUnicodeSurrogates(message.content) }];
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant") {
      const parts = message.content
        .map((content) => {
          if (content.type === "text") return { text: content.text };
          if (content.type === "toolCall") {
            return {
              functionCall: {
                name: content.name,
                args: content.arguments ?? {},
                ...(requiresToolCallId(model.id) ? { id: content.id } : {}),
              },
              ...(content.thoughtSignature ? { thoughtSignature: content.thoughtSignature } : {}),
            };
          }
          return undefined;
        })
        .filter(Boolean) as Array<Record<string, unknown>>;
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (message.role === "toolResult") {
      const text = message.content
        .map((content) => (content.type === "text" ? cleanUnicodeSurrogates(content.text) : ""))
        .join("\n")
        .trimEnd();
      const imageParts = message.content
        .map((content) => (content.type === "image" ? contentToGeminiPart(content) : undefined))
        .filter(Boolean) as Array<Record<string, unknown>>;
      const functionResponseBody: Record<string, unknown> = {
        name: message.toolName,
        response: message.isError ? { error: text } : { output: text },
        ...(requiresToolCallId(model.id) ? { id: message.toolCallId } : {}),
      };
      if (requiresToolCallId(model.id) && imageParts.length > 0) functionResponseBody.parts = imageParts;
      const functionResponse = { functionResponse: functionResponseBody };
      const lastContent = contents[contents.length - 1];
      if (lastContent?.role === "user" && lastContent.parts.some((part) => "functionResponse" in part)) {
        lastContent.parts.push(functionResponse);
      } else {
        contents.push({ role: "user", parts: [functionResponse] });
      }
      if (!requiresToolCallId(model.id) && imageParts.length > 0) contents.push({ role: "user", parts: imageParts });
    }
  }

  return contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }];
}

function contentToGeminiPart(content: { type: string; text?: string; data?: string; mimeType?: string }): Record<string, unknown> | undefined {
  if (content.type === "text") return { text: cleanUnicodeSurrogates(content.text ?? "") };
  if (content.type === "image" && content.data && content.mimeType) {
    return { inlineData: { data: content.data, mimeType: content.mimeType } };
  }
  return undefined;
}

function convertContextTools(tools: Tool[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

function requiresToolCallId(modelId: string): boolean {
  return modelId.includes("gemini-3");
}

function mapToolChoice(choice: "auto" | "none" | "any"): "AUTO" | "NONE" | "ANY" {
  switch (choice) {
    case "none":
      return "NONE";
    case "any":
      return "ANY";
    case "auto":
    default:
      return "AUTO";
  }
}

function getDoneReason(stopReason: StopReason): StopReason {
  return stopReason === "toolUse" || stopReason === "length" || stopReason === "error" ? stopReason : "stop";
}

function shouldRefreshOauthCredentials(credentials: OAuthCredentials | undefined): credentials is OAuthCredentials {
  return Boolean(credentials?.refresh && typeof credentials.expires === "number" && credentials.expires <= Date.now() + 60_000);
}

function cleanUnicodeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function mapGeminiStopReason(reason: string): StopReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "FUNCTION_CALL":
      return "toolUse";
    case "SAFETY":
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "error";
    case "STOP":
    default:
      return "stop";
  }
}

const GEMINI_CODE_ASSIST_COST = { input: 0.000000125, output: 0.000000375, cacheRead: 0.00000003125, cacheWrite: 0.000000125 };

export const GEMINI_CLI_OAUTH_MODELS = [
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash (Gemini CLI OAuth)",
    aliases: ["preview", "flash-preview", "gemini-preview"],
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: GEMINI_CODE_ASSIST_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview (Gemini CLI OAuth)",
    aliases: ["pro", "pro-preview", "gemini-pro-preview"],
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0.00000125, output: 0.00001, cacheRead: 0.0000003125, cacheWrite: 0.00000125 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
];

export const GEMINI_CLI_OAUTH_API = "gemini-cli-oauth-api";
export { PROVIDER_ID };
