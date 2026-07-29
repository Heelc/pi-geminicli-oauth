import { buildCodeAssistHeaders } from "./code-assist";
import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
  duetProject: "gemini-cli",
} as const;

interface CloudAiCompanionProject {
  id?: string;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | CloudAiCompanionProject;
  currentTier?: { id?: string };
  allowedTiers?: GeminiUserTier[];
}

interface GeminiUserTier {
  id?: string;
  isDefault?: boolean;
}

interface OnboardUserPayload {
  done?: boolean;
  name?: string;
  response?: {
    cloudaicompanionProject?: CloudAiCompanionProject;
  };
}

const projectContextCache = new Map<string, string | undefined>();
const projectContextPendingCache = new Map<string, Promise<string | undefined>>();

export function resetProjectContextCache(): void {
  projectContextCache.clear();
  projectContextPendingCache.clear();
}

export async function loadManagedProject(input: {
  accessToken: string;
  projectId?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { metadata: CODE_ASSIST_METADATA };
  if (input.projectId) body.cloudaicompanionProject = input.projectId;

  const response = await fetchImpl(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: buildCodeAssistHeaders({
      accessToken: input.accessToken,
      modelId: input.modelId ?? "gemini-3-flash",
      stream: false,
    }),
    body: JSON.stringify(body),
  });
  if (!response.ok) return undefined;

  const payload = (await response.json()) as LoadCodeAssistPayload;
  const managedProjectId = normalizeManagedProject(payload.cloudaicompanionProject);
  if (managedProjectId || input.projectId) return managedProjectId ?? input.projectId;

  const tierId = payload.allowedTiers?.find((tier) => tier.isDefault)?.id ?? payload.allowedTiers?.[0]?.id;
  if (tierId === "free-tier") {
    return onboardManagedProject({
      accessToken: input.accessToken,
      tierId,
      modelId: input.modelId,
      fetchImpl,
    });
  }
  return undefined;
}

export async function onboardManagedProject(input: {
  accessToken: string;
  tierId: string;
  projectId?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  pollAttempts?: number;
  pollDelayMs?: number;
}): Promise<string | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { tierId: input.tierId, metadata: CODE_ASSIST_METADATA };
  if (input.projectId) body.cloudaicompanionProject = input.projectId;

  const response = await fetchImpl(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers: buildCodeAssistHeaders({
      accessToken: input.accessToken,
      modelId: input.modelId ?? "gemini-3-flash",
      stream: false,
    }),
    body: JSON.stringify(body),
  });
  if (!response.ok) return undefined;

  let payload = (await response.json()) as OnboardUserPayload;
  if (!payload.done && payload.name) {
    payload = await pollOnboardOperation({
      ...input,
      operationName: payload.name,
      fetchImpl,
      modelId: input.modelId ?? "gemini-3-flash",
    });
  }

  return normalizeManagedProject(payload.response?.cloudaicompanionProject) ?? (payload.done ? input.projectId : undefined);
}

export async function resolveEffectiveProjectId(input: {
  configuredProjectId?: string;
  accessToken: string;
  modelId?: string;
  disableManagedProject?: boolean;
  fetchImpl?: typeof fetch;
  onManagedProjectResolved?: (projectId: string) => void | Promise<void>;
}): Promise<string | undefined> {
  if (input.configuredProjectId) return input.configuredProjectId;
  if (input.disableManagedProject) return undefined;

  const key = `${input.accessToken}|${input.modelId ?? "gemini-3-flash"}`;
  if (projectContextCache.has(key)) return projectContextCache.get(key);
  const pending = projectContextPendingCache.get(key);
  if (pending) return pending;

  const promise = loadManagedProject({ accessToken: input.accessToken, modelId: input.modelId, fetchImpl: input.fetchImpl })
    .then(async (projectId) => {
      projectContextPendingCache.delete(key);
      projectContextCache.set(key, projectId);
      if (projectId) await input.onManagedProjectResolved?.(projectId);
      return projectId;
    })
    .catch((error) => {
      projectContextPendingCache.delete(key);
      throw error;
    });
  projectContextPendingCache.set(key, promise);
  return promise;
}

async function pollOnboardOperation(input: {
  accessToken: string;
  operationName: string;
  modelId?: string;
  projectId?: string;
  fetchImpl: typeof fetch;
  pollAttempts?: number;
  pollDelayMs?: number;
}): Promise<OnboardUserPayload> {
  const attempts = input.pollAttempts ?? 10;
  const delayMs = input.pollDelayMs ?? 5_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await input.fetchImpl(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal/${input.operationName}`, {
      method: "GET",
      headers: buildCodeAssistHeaders({
        accessToken: input.accessToken,
        modelId: input.modelId ?? "gemini-3-flash",
        stream: false,
      }),
    });
    if (!response.ok) return { done: false };
    const payload = (await response.json()) as OnboardUserPayload;
    if (payload.done) return payload;
  }
  return { done: false };
}

function normalizeManagedProject(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const id = (value as CloudAiCompanionProject).id;
    return typeof id === "string" ? id.trim() || undefined : undefined;
  }
  return undefined;
}
