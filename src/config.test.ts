import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveProjectId, saveUserProjectIdConfig } from "./config";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("resolveProjectId", () => {
  it("优先使用 PI_GEMINI_CLI_PROJECT_ID", () => {
    const actual = resolveProjectId({
      cwd: "/missing/project",
      homeDir: "/missing/home",
      env: {
        PI_GEMINI_CLI_PROJECT_ID: " enterprise-project ",
        GOOGLE_CLOUD_PROJECT: "fallback-project",
      },
    });

    expect(actual).toBe("enterprise-project");
  });

  it("读取项目级 .pi/gemini-cli-oauth.json", ({ task }) => {
    const cwd = task.file!.filepath.replace(/config\.test\.ts$/, "tmp-project-config");
    writeJson(join(cwd, ".pi", "gemini-cli-oauth.json"), { projectId: "project-config-id" });

    const actual = resolveProjectId({ cwd, homeDir: "/missing/home", env: {} });

    expect(actual).toBe("project-config-id");
  });

  it("项目配置不存在时读取全局配置", ({ task }) => {
    const homeDir = task.file!.filepath.replace(/config\.test\.ts$/, "tmp-home-config");
    writeJson(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json"), { projectId: "home-config-id" });

    const actual = resolveProjectId({ cwd: "/missing/project", homeDir, env: {} });

    expect(actual).toBe("home-config-id");
  });

  it("最后兼容 GOOGLE_CLOUD_PROJECT 和 GOOGLE_CLOUD_PROJECT_ID", () => {
    const isolatedPaths = { cwd: "/missing/project", homeDir: "/missing/home" };
    expect(resolveProjectId({ ...isolatedPaths, env: { GOOGLE_CLOUD_PROJECT: "cloud-project" } })).toBe("cloud-project");
    expect(resolveProjectId({ ...isolatedPaths, env: { GOOGLE_CLOUD_PROJECT_ID: "cloud-project-id" } })).toBe(
      "cloud-project-id",
    );
  });

  it("空字符串和无效配置返回 undefined", () => {
    expect(resolveProjectId({ cwd: "/missing/project", homeDir: "/missing/home", env: { PI_GEMINI_CLI_PROJECT_ID: "   " } })).toBeUndefined();
  });
});

describe("saveUserProjectIdConfig", () => {
  it("将 projectId 写入用户级配置文件", ({ task }) => {
    const homeDir = task.file!.filepath.replace(/config\.test\.ts$/, "tmp-save-home-config");

    const path = saveUserProjectIdConfig(" enterprise-project ", { homeDir });

    expect(path).toBe(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json"));
    expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual({ projectId: "enterprise-project" });
  });

  it("projectId 为空时不创建用户级配置文件", ({ task }) => {
    const homeDir = task.file!.filepath.replace(/config\.test\.ts$/, "tmp-empty-save-home-config");

    const path = saveUserProjectIdConfig("   ", { homeDir });

    expect(path).toBeUndefined();
    expect(existsSync(join(homeDir, ".pi", "agent", "gemini-cli-oauth.json"))).toBe(false);
  });
});
