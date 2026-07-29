import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VERSION = "0.49.0";
const DEFAULT_SURFACE = "terminal";

export function buildGeminiCliUserAgent(modelId: string): string {
  return `GeminiCLI/${resolveGeminiCliVersion()}/${modelId} (${process.platform}; ${process.arch}; ${resolveGeminiCliSurface()})`;
}

export function resolveGeminiCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalize(env.PI_GEMINI_CLI_VERSION) ??
    normalize(env.GEMINI_CLI_VERSION) ??
    normalize(env.npm_package_version) ??
    readPackageVersion() ??
    DEFAULT_VERSION
  );
}

export function resolveGeminiCliSurface(env: NodeJS.ProcessEnv = process.env): string {
  return normalize(env.GEMINI_CLI_SURFACE) ?? normalize(env.SURFACE) ?? DEFAULT_SURFACE;
}

function readPackageVersion(): string | undefined {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    for (const path of [join(moduleDir, "..", "package.json"), join(process.cwd(), "package.json")]) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
        const version = normalize(parsed.version);
        if (version) return version;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalize(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
