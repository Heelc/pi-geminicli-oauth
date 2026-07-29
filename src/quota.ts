import { buildCodeAssistHeaders } from "./code-assist";
import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";

export interface RetrieveUserQuotaBucket {
  modelId?: string;
  limit?: number;
  consumed?: number;
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  [key: string]: unknown;
}

export interface RetrieveUserQuotaResponse {
  buckets?: RetrieveUserQuotaBucket[];
  [key: string]: unknown;
}

export async function retrieveUserQuota(input: {
  accessToken: string;
  projectId: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
}): Promise<RetrieveUserQuotaResponse | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`, {
    method: "POST",
    headers: buildCodeAssistHeaders({ accessToken: input.accessToken, modelId: input.modelId ?? "gemini-3-flash", stream: false }),
    body: JSON.stringify({ project: input.projectId }),
  });

  if (!response.ok) return null;
  return (await response.json()) as RetrieveUserQuotaResponse;
}

export function formatGeminiQuota(projectId: string, quota: RetrieveUserQuotaResponse | null): string {
  if (!quota?.buckets?.length) return `Gemini quota：项目 ${projectId} 未返回 quota buckets。`;

  const groups = groupQuotaBuckets(quota.buckets);
  const visibleBuckets = groups.flatMap((group) => group.buckets);
  const modelWidth = Math.max("模型".length, ...visibleBuckets.map((bucket) => (bucket.modelId ?? "unknown-model").length));
  const usageWidth = Math.max("剩余额度".length, ...visibleBuckets.map((bucket) => formatBucketUsage(bucket).length));
  const typeWidth = Math.max("类型".length, ...visibleBuckets.map((bucket) => (bucket.tokenType ?? "-").length));
  const lines = [`Gemini quota：项目 ${projectId}`, "时区：UTC+8", ""];

  for (const group of groups) {
    if (!group.buckets.length) continue;
    lines.push(group.title);
    lines.push(`  ${pad("模型", modelWidth)}  ${pad("剩余额度", usageWidth)}  ${pad("类型", typeWidth)}  重置时间`);
    for (const bucket of group.buckets) {
      const model = bucket.modelId ?? "unknown-model";
      const usage = formatBucketUsage(bucket);
      const tokenType = bucket.tokenType ?? "-";
      const reset = formatEast8Time(bucket.resetTime) ?? "-";
      lines.push(`  ${pad(model, modelWidth)}  ${pad(usage, usageWidth)}  ${pad(tokenType, typeWidth)}  ${reset}`);
    }
    lines.push("");
  }

  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function formatBucketUsage(bucket: RetrieveUserQuotaBucket): string {
  if (typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)) {
    const percent = `${(clamp(bucket.remainingFraction, 0, 1) * 100).toFixed(1)}%`;
    return bucket.remainingAmount ? `${percent} (${formatRemainingAmount(bucket.remainingAmount)} left)` : percent;
  }
  if (bucket.remainingAmount) return `${formatRemainingAmount(bucket.remainingAmount)} left`;
  if (typeof bucket.consumed === "number" && typeof bucket.limit === "number") {
    return `${bucket.consumed}/${bucket.limit}`;
  }
  if (typeof bucket.limit === "number") return `limit=${bucket.limit}`;
  return "quota 信息不可用";
}

interface QuotaGroup {
  title: "Flash" | "Pro" | "Other";
  buckets: RetrieveUserQuotaBucket[];
}

function groupQuotaBuckets(buckets: RetrieveUserQuotaBucket[]): QuotaGroup[] {
  return [
    { title: "Flash", buckets: buckets.filter((bucket) => getQuotaGroupTitle(bucket) === "Flash").sort(compareQuotaBuckets) },
    { title: "Pro", buckets: buckets.filter((bucket) => getQuotaGroupTitle(bucket) === "Pro").sort(compareQuotaBuckets) },
    { title: "Other", buckets: buckets.filter((bucket) => getQuotaGroupTitle(bucket) === "Other").sort(compareQuotaBuckets) },
  ];
}

function getQuotaGroupTitle(bucket: RetrieveUserQuotaBucket): QuotaGroup["title"] {
  const model = (bucket.modelId ?? "").toLowerCase();
  if (model.includes("flash")) return "Flash";
  if (model.includes("pro")) return "Pro";
  return "Other";
}

function compareQuotaBuckets(left: RetrieveUserQuotaBucket, right: RetrieveUserQuotaBucket): number {
  const leftModel = left.modelId ?? "";
  const rightModel = right.modelId ?? "";
  const variantDiff = getVariantRank(leftModel) - getVariantRank(rightModel);
  if (variantDiff !== 0) return variantDiff;

  const versionDiff = extractModelVersion(rightModel) - extractModelVersion(leftModel);
  if (versionDiff !== 0) return versionDiff;

  const previewDiff = getPreviewRank(leftModel) - getPreviewRank(rightModel);
  if (previewDiff !== 0) return previewDiff;

  return leftModel.localeCompare(rightModel);
}

function getVariantRank(modelId: string): number {
  return modelId.toLowerCase().includes("lite") ? 1 : 0;
}

function getPreviewRank(modelId: string): number {
  return modelId.toLowerCase().endsWith("preview") ? 1 : 0;
}

function extractModelVersion(modelId: string): number {
  const match = modelId.match(/gemini-(\d+(?:\.\d+)?)/i);
  return match ? Number.parseFloat(match[1] ?? "0") : 0;
}

function formatEast8Time(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

function formatRemainingAmount(value: string): string {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
