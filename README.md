# Pi Gemini CLI OAuth Provider

[![npm version](https://img.shields.io/npm/v/pi-geminicli-oauth.svg)](https://www.npmjs.com/package/pi-geminicli-oauth)
[![license](https://img.shields.io/npm/l/pi-geminicli-oauth.svg)](./LICENSE)

这是一个 Pi 扩展包，新增 `gemini-cli-oauth` provider，用于通过 Gemini CLI 风格 OAuth 登录访问 Gemini Code Assist，并支持配置 Google Cloud `projectId`，让企业用户使用指定 Google project 的额度。

> 风险提示：Gemini CLI OAuth 接入第三方工具可能受 Google 政策和风控影响。企业或组织账号请优先确认内部合规要求，并显式配置 `projectId`。

## 安装

从 npm 安装（推荐）：

```bash
pi install npm:pi-geminicli-oauth
```

或直接从 GitHub 安装：

```bash
pi install https://github.com/Heelc/pi-geminicli-oauth
```

两种方式都可以加 `-l` 只装到当前项目（写入 `.pi/settings.json`）而不是用户级：

```bash
pi install -l npm:pi-geminicli-oauth
```

Pi 会自动加载 `package.json` 中 `pi.extensions` 指向的 `./src/index.ts`。**无需额外 `npm install`**：运行时只依赖 Node 内置模块和 Pi 自身提供的 `@earendil-works/pi-ai`（已声明为 optional peer dependency，不会被重复安装），`typescript` / `vitest` 仅开发时需要。

安装后可以确认 provider 已注册：

```bash
pi --list-models gemini-cli
```

```text
provider          model                   context  max-out  thinking  images
gemini-cli-oauth  gemini-3-flash          1M       65.5K    yes       yes
gemini-cli-oauth  gemini-3.1-pro-preview  1M       65.5K    yes       yes
```

更新与卸载（把来源替换成你安装时用的写法）：

```bash
pi update npm:pi-geminicli-oauth
pi remove npm:pi-geminicli-oauth
```

也支持 `pi install git:github.com/Heelc/pi-geminicli-oauth` 等其他来源写法。

要求 Node >= 20。

### 从源码开发

```bash
git clone https://github.com/Heelc/pi-geminicli-oauth
cd pi-geminicli-oauth
npm install          # 仅开发/测试需要
pi -e ./src/index.ts # 单次加载，不写入 settings
```

或用 `pi install ./pi-geminicli-oauth` 安装本地路径。

## 登录

启动 Pi 后执行：

```text
/login gemini-cli-oauth
```

流程：

1. Pi 启动本地回调监听器 `http://localhost:8085/oauth2callback`，并打开 Google OAuth 授权 URL。
2. 完成授权后，浏览器会跳回 localhost，插件自动读取 `code` 并校验 `state`。
3. 如果本地监听器不可用（例如端口被占用、SSH/headless 环境），会回退到手动粘贴回调 URL 或授权码。
4. 可选输入 Google Cloud `projectId`；非空时会自动保存到用户级配置 `~/.pi/agent/gemini-cli-oauth.json`。
5. Pi 保存 OAuth refresh/access token，后续自动刷新 access token。

当前版本仅支持 Pi 为 `gemini-cli-oauth` 保存的一组 OAuth 凭据；再次执行 `/login gemini-cli-oauth` 会按 Pi 的单 provider 登录语义覆盖/更新当前凭据，不提供多账号池、账号切换或账号轮换。

## 配置 projectId

企业、学校、Workspace 或 Gemini Code Assist Standard/Enterprise 用户应显式配置 `projectId`，以使用对应 Google Cloud project 的额度。

推荐方式是在 `/login gemini-cli-oauth` 流程中按提示输入 `projectId`，插件会自动写入用户级配置：

```text
~/.pi/agent/gemini-cli-oauth.json
```

如果登录时留空，插件会在请求前先尝试通过 Code Assist `loadCodeAssist` 自动发现 managed project；若账号允许 `free-tier`，会继续调用 `onboardUser` 获取 managed project。自动发现或引导成功后，插件会将该 managed project 写入用户级配置 `~/.pi/agent/gemini-cli-oauth.json`，后续 Pi 重启后可直接复用，减少首次请求探测延迟。企业/组织配额仍建议显式配置 `projectId`，显式配置始终优先。

解析优先级：

1. `PI_GEMINI_CLI_PROJECT_ID`
2. 项目配置：`.pi/gemini-cli-oauth.json`
3. 全局配置：`~/.pi/agent/gemini-cli-oauth.json`
4. `GOOGLE_CLOUD_PROJECT`
5. `GOOGLE_CLOUD_PROJECT_ID`

配置文件示例：

```json
{
  "projectId": "your-google-cloud-project-id"
}
```

环境变量示例：

```bash
export PI_GEMINI_CLI_PROJECT_ID=your-google-cloud-project-id
```

## Quota 查询

插件会注册 `/gemini-quota` 命令，用当前 `gemini-cli-oauth` 登录凭据和已解析的 `projectId` 调用 Code Assist `retrieveUserQuota`。access token 过期时会先用 refresh token 刷新并写回本地 auth，再展示按 Flash / Pro / Other 分组的 quota buckets；重置时间默认以 UTC+8 易读格式展示。

```text
/gemini-quota
```

示例输出：

```text
Gemini quota：项目 codeassist-preview
时区：UTC+8

Flash
  gemini-3-flash  56.0%  REQUESTS  2026-07-02 12:45:17

Pro
  gemini-3.1-pro-preview  98.4%  REQUESTS  2026-07-03 10:34:55
```

如果未登录或缺少 `projectId`，命令会给出对应提示。

当前版本 `/gemini-quota` 只查询当前登录账号和当前解析到的 `projectId`，不展示多账号聚合 quota。

## Debug 日志

如需排查真实请求、限流、project 或 token 刷新问题，可在启动 Pi 前开启：

```bash
export PI_GEMINI_CLI_OAUTH_DEBUG=1
```

插件会在当前工作目录写入 `gemini-cli-oauth-debug-*.log`，记录脱敏后的请求 URL、project、model、headers、body preview、响应状态、trace id、retry 延迟等信息；`Authorization` 和 API key 类 header 会被隐藏。

## 可用模型

Provider ID：`gemini-cli-oauth`

初始注册模型与常用别名：

- `gemini-3-flash`：`preview`、`flash-preview`、`gemini-preview`
- `gemini-3.1-pro-preview`：`pro`、`pro-preview`、`gemini-pro-preview`

模型元数据已提供非零成本估算，避免 usage cost 被误报为 0。

## 请求与流式行为

- system prompt 会作为 Gemini `systemInstruction` 发送。
- Gemini 3 模型使用 `thinkingLevel`，Gemini 2.5 模型使用 `thinkingBudget`。
- 默认 `includeThoughts: true`，与 Pi 中 GPT provider 的 thinking 展示习惯保持一致；调用方可显式传入 `includeThoughts: false` 或 `thinking.enabled: false` 关闭输出。启用 reasoning 时，Gemini thought part 会输出为 Pi `thinking_start` / `thinking_delta` / `thinking_end` 事件并保留 `thinkingSignature`。
- SSE 响应会按 `data:` 到达顺序增量输出 `text_delta`，并在最终消息中保留完整正文。
- 插件会过滤历史中的 thought-only model turn，归一化 `cached_content`/`cachedContent`，并把 Code Assist `traceId` 映射为 `responseId`。
- 工具调用已支持完整 Pi ↔ Gemini 闭环：Pi `tools` 会发送为 Gemini `functionDeclarations`，Gemini `functionCall` 会转成 Pi `toolcall_*` 事件，后续 Pi `toolResult` 会回放为 Gemini `functionResponse`；图片 toolResult 会按模型能力处理，Gemini 3 放入 `functionResponse.parts`，Gemini 2.5 拆成单独 user image turn。
- 支持 `toolChoice` → Gemini `toolConfig.functionCallingConfig`，并保留 Gemini `thoughtSignature` 到后续工具调用上下文。
- 稳定性恢复：请求前会在 access token 临近过期时主动 refresh 并持久化；Code Assist 返回 401 时也会 refresh access token 并重试一次；429/5xx/网络错误会按 `RetryInfo`、`Retry-After` 或带 jitter 的指数退避重试，同一 project/model/endpoint 会记录短期 cooldown，永久 `QUOTA_EXHAUSTED` 不会盲目重试。
- Pi 原生行为对齐：`usageMetadata` 会补齐 `cacheRead`、`reasoning`、`totalTokens` 与成本统计；`SAFETY`/`MALFORMED_FUNCTION_CALL`/`UNEXPECTED_TOOL_CALL` 会作为错误停止；请求前会清洗非法 Unicode surrogate。
- 高级请求选项：支持 `temperature`、`maxTokens` 写入 Gemini `generationConfig`，支持自定义 headers 合并（保留 OAuth `Authorization` 不被覆盖），并支持 `onPayload` / `onResponse` 调试钩子；显式 `thinking` 配置优先于 `reasoning` 派生配置。
- project 体验：显式 `projectId` 优先；未配置时会尝试 `loadCodeAssist` 自动发现 managed project，并在 `free-tier` 可用时通过 `onboardUser` 引导 managed project；同一账号/模型的 project context 会缓存并发去重，`onboardUser` 长操作会轮询至完成；自动发现/引导出的 managed project 会持久化到用户级配置，便于下次启动直接复用。
- 账号边界：当前版本保持单账号 OAuth 语义，不支持多个 Gemini OAuth 账号同时登录、账号池、429 自动切换账号或多账号 quota 聚合。

## 开发验证

```bash
npm install
npm test
npm run typecheck
```

当前测试覆盖：

- projectId 配置解析优先级
- OAuth 授权 URL、授权码交换、refresh token
- Code Assist 请求包装与响应/SSE 解包
- provider 注册与关键错误提示
- `/login gemini-cli-oauth` 后可选保存用户级 `projectId` 配置
- OAuth 本地 callback listener 自动捕获授权 `code`，并覆盖 listener 不可用时的手动粘贴兜底
- 真正 SSE 增量输出、thought-only 历史清洗、cachedContent 归一化
- `traceId`→`responseId`、Google error details 增强、`/gemini-quota` 分组 quota 查询与过期 token 刷新
- Pi toolCall/toolResult 与 Gemini functionCall/functionResponse 双向转换、toolChoice/toolConfig、thoughtSignature 保留
- 401 refresh retry、429/5xx/network retry、RetryInfo 解析、quota/capacity/rate-limit 分类
- usage/cacheRead/reasoning/cost、错误 finishReason、responseId 写回、Unicode surrogate 清洗
- 默认 thinking 事件流、显式关闭开关、Gemini 3/2.5 toolResult 图片转换、thinkingSignature 保留
- temperature/maxTokens、headers 合并、onPayload/onResponse、显式 thinking 配置优先级
- managed project 自动发现、free-tier onboarding、模型 aliases 与非零 cost 元数据、managedProjectId 长期持久化
- User-Agent 版本/surface 覆盖、project context 缓存与 onboard 轮询、debug 日志脱敏、Retry-After/cooldown、请求前主动 refresh 与凭据持久化

## OAuth 客户端凭据说明

`src/constants.ts` 中的 `GEMINI_CLIENT_ID` / `GEMINI_CLIENT_SECRET` 与官方开源 [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) 使用的是同一组公开 installed-app 凭据。按 OAuth 2.0 规范，原生/CLI 客户端的 client secret 不具备机密性，因此它们随源码公开不构成凭据泄漏。

**你自己的 OAuth token 不在仓库内**：access/refresh token 由 Pi 保存在本地 `~/.pi` 下，`projectId` 保存在 `~/.pi/agent/gemini-cli-oauth.json` 或项目级 `.pi/gemini-cli-oauth.json`，这些路径均已被 `.gitignore` 排除。

## 免责声明

本项目为非官方的第三方实现，与 Google 无关联。通过 Gemini CLI OAuth 接入第三方工具可能受 Google 服务条款、政策变更和风控影响，请自行评估风险。企业或组织账号请先确认内部合规要求，并显式配置 `projectId`。

## License

[MIT](./LICENSE)
