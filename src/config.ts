import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ResolveProjectIdOptions {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface SaveProjectIdOptions {
  homeDir?: string;
}

interface GeminiCliOAuthConfig {
  projectId?: unknown;
}

export function resolveProjectId(options: ResolveProjectIdOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();

  return (
    normalizeProjectId(env.PI_GEMINI_CLI_PROJECT_ID) ??
    readProjectIdFromConfig(join(cwd, ".pi", "gemini-cli-oauth.json")) ??
    readProjectIdFromConfig(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json")) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export function saveUserProjectIdConfig(projectId: string, options: SaveProjectIdOptions = {}): string | undefined {
  const normalized = normalizeProjectId(projectId);
  if (!normalized) return undefined;

  const homeDir = options.homeDir ?? homedir();
  const path = join(homeDir, ".pi", "agent", "gemini-cli-oauth.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ projectId: normalized }, null, 2)}\n`, "utf8");
  return path;
}

function readProjectIdFromConfig(path: string): string | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GeminiCliOAuthConfig;
    return normalizeProjectId(parsed.projectId);
  } catch {
    return undefined;
  }
}

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
