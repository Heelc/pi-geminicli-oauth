# Gemini CLI OAuth Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Pi 扩展包，新增 `gemini-cli-oauth` provider，使 Pi 可以通过 Gemini CLI OAuth 登录访问 Gemini Code Assist，并支持显式配置 Google Cloud `projectId`。

**Architecture:** 采用独立 provider，避免覆盖 Pi 内置 `google` provider。扩展通过 `pi.registerProvider()` 注册 OAuth、模型列表和自定义 `streamSimple`；核心模块拆分为配置解析、OAuth、Code Assist 请求包装、响应流解析和 provider 注册。

**Tech Stack:** TypeScript、Node.js >= 22、Pi Extension API、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、Vitest、Google OAuth、Gemini Code Assist internal API。

## Global Constraints

- 用户可见输出、文档、注释保持简体中文。
- 默认采用方案 B：新增独立 provider `gemini-cli-oauth`。
- 第一版只支持显式 `projectId` 配置，不自动创建或托管 Google project。
- `projectId` 解析优先级：`PI_GEMINI_CLI_PROJECT_ID`、`.pi/gemini-cli-oauth.json`、`~/.pi/agent/gemini-cli-oauth.json`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_PROJECT_ID`。
- 新生产代码必须先有失败测试。

---

## 文件结构

- Create: `package.json` — 包元数据、Pi extension 入口、测试脚本。
- Create: `tsconfig.json` — TypeScript 配置。
- Create: `src/constants.ts` — OAuth 与 Code Assist 常量。
- Create: `src/config.ts` — `projectId` 配置解析。
- Create: `src/oauth.ts` — 授权 URL、code exchange、refresh token。
- Create: `src/code-assist.ts` — Gemini 请求包装、SSE 响应解包、usage 映射。
- Create: `src/stream.ts` — Pi `streamSimple` 实现。
- Create: `src/index.ts` — Pi extension 入口，注册 provider。
- Create: `src/*.test.ts` — Vitest 测试。
- Create: `README.md` — 安装、登录、projectId 配置说明。

## Task 1: 项目脚手架与配置解析

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `resolveProjectId(options?: { cwd?: string; homeDir?: string; env?: NodeJS.ProcessEnv }): string | undefined`

- [ ] Step 1: 编写 `src/config.test.ts`，覆盖环境变量、项目配置、全局配置、空值归一化。
- [ ] Step 2: 运行测试确认失败：`npm test -- src/config.test.ts`。
- [ ] Step 3: 实现 `src/config.ts` 的最小逻辑。
- [ ] Step 4: 运行测试确认通过。

## Task 2: OAuth URL、code exchange 与 refresh

**Files:**
- Create: `src/constants.ts`
- Create: `src/oauth.ts`
- Test: `src/oauth.test.ts`

**Interfaces:**
- Produces: `createAuthorizationUrl(input)`，返回 `{ url, verifier, state }`。
- Produces: `exchangeCodeForTokens(input)`，返回 Pi OAuth 凭据。
- Produces: `refreshAccessToken(credentials, fetchImpl?)`。

- [ ] Step 1: 编写 OAuth URL 测试，断言 scope、redirect_uri、PKCE、offline access。
- [ ] Step 2: 编写 refresh 测试，使用 fake fetch 验证请求体与返回凭据。
- [ ] Step 3: 运行测试确认失败。
- [ ] Step 4: 实现 OAuth 模块。
- [ ] Step 5: 运行测试确认通过。

## Task 3: Code Assist 请求包装与响应解包

**Files:**
- Create: `src/code-assist.ts`
- Test: `src/code-assist.test.ts`

**Interfaces:**
- Consumes: `projectId`、`accessToken`、Gemini request payload。
- Produces: `buildCodeAssistRequest({ modelId, projectId, payload })`。
- Produces: `unwrapCodeAssistResponse(body)`。
- Produces: `parseSseLines(text)` 或等价内部函数。

- [ ] Step 1: 编写请求包装测试，断言输出包含 `project`、`model`、`request`、`user_prompt_id`。
- [ ] Step 2: 编写响应解包测试，断言 `{ response: {...} }` 被转成标准 Gemini body。
- [ ] Step 3: 编写 SSE 解包测试，断言 `data: {"response":...}` 被转成标准 response event。
- [ ] Step 4: 运行测试确认失败。
- [ ] Step 5: 实现最小转换逻辑。
- [ ] Step 6: 运行测试确认通过。

## Task 4: Provider stream 与注册入口

**Files:**
- Create: `src/stream.ts`
- Create: `src/index.ts`
- Test: `src/stream.test.ts`

**Interfaces:**
- Consumes: Pi `Model`、`Context`、`SimpleStreamOptions`。
- Produces: `streamGeminiCliOAuth(model, context, options)`。
- Produces: default Pi extension function。

- [ ] Step 1: 编写 provider 注册测试，使用 fake `pi.registerProvider` 验证 provider id、oauth、models、streamSimple。
- [ ] Step 2: 编写 stream 缺少 token 或 projectId 的错误测试。
- [ ] Step 3: 运行测试确认失败。
- [ ] Step 4: 实现 provider 注册与基础 stream 错误路径。
- [ ] Step 5: 运行测试确认通过。

## Task 5: 文档与最终验证

**Files:**
- Create: `README.md`
- Modify: `task_plan.md`
- Modify: `progress.md`

- [ ] Step 1: 编写 README，包含安装、`/login gemini-cli-oauth`、projectId 配置、风险说明。
- [ ] Step 2: 运行 `npm test`。
- [ ] Step 3: 运行 `npm run typecheck`。
- [ ] Step 4: 更新计划和进度文件。
