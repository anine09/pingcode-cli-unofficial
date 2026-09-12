# auth login 纯粘贴登录，移除浏览器通道

## Goal

彻底关闭 authorization_code 登录的浏览器通道（自动拉起浏览器 + loopback 监听捕获），统一为粘贴登录：CLI 打印登录网址，用户在浏览器里手动完成登录，把返回文本（跳转后地址栏的完整网址，或裸授权码）粘贴回来，CLI 解析出 code 完成交换。

**用户价值**：远程 / headless / 无浏览器环境（`xdg-open` 不存在、浏览器与 CLI 不在同一台机器——用户反馈的原场景）下也能完成个人授权登录；登录心智模型收敛为一个：开网址 → 复制返回文本 → 粘贴。同时消除 loopback 监听带来的失败面（端口占用、超时等待）。

## Background（代码事实，探索确认）

现状：

- `src/cli/commands/auth.ts`
  - `runLogin` user 路径（auth.ts:206-238）：`resolveChannel` → `printAuthorizeUrl` → browser 通道 `loginHooks.openBrowser` + `captureCodeFromLoopback`（loopback 监听捕获 `?code=&domain=`）；paste 通道 `readCodeFromTerminal`；`--code` 直通。
  - `--channel browser|paste` 参数（auth.ts:116），交互式默认 browser（`defaultSelectChannel`，auth.ts:634-640，`selectChannel` hook）。
  - `loginHooks`（auth.ts:83-98）：`selectMode / selectChannel / openBrowser / captureCode / readCode`。
- `src/cli/commands/oauth.ts`
  - `buildAuthorizeUrl` / `oauthRootOf` / `printAuthorizeUrl`（保留）。
  - `openBrowser`（oauth.ts:72，平台 spawn：darwin `open` / win32 `cmd /c start` / 其他 `xdg-open`，错误吞掉）。
  - `DEFAULT_LOOPBACK_URI`（oauth.ts:26，`http://127.0.0.1:8732/callback`）、`parseLoopback`（oauth.ts:93）、`CaptureOptions`（oauth.ts:107）、`captureCodeFromLoopback`（oauth.ts:128，一次性监听；超时 AuthError、端口占用 UsageError）。
- 配置 `oauthRedirectUri`：Config 类型（core/config.ts:80）、ResolvedSettings（config.ts:111）、readConfig（config.ts:321-322）、settings 构建（config.ts:425）→ globals.ts:157 `oauth: { redirectUri }` → `Ctx.oauth`（core/context.ts:36, 67）。**仅被 loopback 使用**，无其他消费者。
- 测试引用点：
  - `test/oauth.test.ts`：openBrowser（4 例）、captureCodeFromLoopback（4 例）、parseLoopback（2 组 7 例）、printAuthorizeUrl、buildAuthorizeUrl、oauthRootOf。
  - `test/authCommands.test.ts`：loginHooks 打桩（captureCode/selectChannel/readCode）；"browser channel persists..." 测试（123-150）、"paste channel reads..."（152-167）、"--code flag uses the code directly"（169-184）、`--channel bogus` 拒绝测试（363-370）、beforeEach 的 `loginHooks.openBrowser = () => {}`（52 行）。
  - `test/help/__snapshots__/auth.test.ts.snap:30`：`--channel <channel> user authorize channel: browser (default) | paste`；`--code` 描述含 "skip the browser loopback"；`test/help/auth.test.ts` 标题含 "mode/channel/code flag surface"。
  - `test/globals.test.ts:150,153-160`：oauthRedirectUri 相关两个断言。
  - `test/config.test.ts:168,181,248,259`：oauthRedirectUri fixture/断言。
- 规格文档：`.trellis/spec/backend/database-guidelines.md:50` 有 `oauthRedirectUri?: string; // registered loopback callback for the browser channel`。
- 历史依据：archived task `08-18-user-token-auth/design.md` D13 已注明 loopback 要求浏览器与 CLI **同机**，paste 是 remote-safe 回退——但 paste 从来不是默认路径，且浏览器通道的 openBrowser 静默失败无感知。
- README 无 auth 登录通道文档（`--channel` 仅命中 ticket 的 channel，与本任务无关）。

用户已确认的决策（本轮规划中确认）：

- 创建 Trellis 任务（任务目录 `.trellis/tasks/09-12-paste-only-login`）。
- **彻底移除浏览器通道**：删 `--channel` 参数、`openBrowser`、loopback 捕获、`parseLoopback`、`oauthRedirectUri` 配置。
- 粘贴输入接受"返回文本"：跳转后地址栏完整网址（提取 `code`）或裸 code。
- 输出文案用英文（项目现有 CLI 文案均为英文）。

## Requirements

- **R1 纯粘贴登录流程**：`auth login` user 模式不再打开浏览器、不再监听任何端口。流程：构建 authorize URL → 打印 URL + 三步操作指引（stderr）→ 提示粘贴 → 解析 code → `acquireUserToken` → verify `GET /v1/myself` → 持久化 userToken。`--code <code>` 仍然直通（脚本/非交互路径，语义不变：它就是 code，不经过解析器）。
- **R2 粘贴解析器 `extractCode(pasted)`**（纯函数，`src/cli/commands/oauth.ts`）：
  - URL（`http(s)://` 前缀）且含 `code` 查询参数 → 返回 code（其余参数如 `domain` 忽略）。
  - URL 且含 `error` 参数 → 抛 `AuthError`（exit 3），消息含 error（+ `error_description` 若有），hint 指向重新登录。
  - URL 但无 code/error → 抛 `UsageError`（exit 2），提示"复制跳转后地址栏的完整网址，或直接粘贴 code"。
  - URL 解析失败（畸形）→ `UsageError`，同上提示。
  - 裸字符串 → trim 后作为 code；空 → `UsageError`（保留现有 "no authorization code entered" 语义）。
  - 输入 trim 处理前后空白/换行（终端粘贴 URL 常带尾随字符）。
- **R3 操作指引文案**（`printAuthorizeUrl`，stderr，英文）：提示用户 1) 在浏览器打开网址并完成登录授权；2) 登录后浏览器会跳转到含 `?code=` 的网址（页面本身可能加载失败，属正常）；3) 复制地址栏完整网址（或页面显示的 code）粘贴到提示符。
- **R4 loginHooks 精简**：`{ selectMode, readPaste }`。`readPaste(json)` 返回用户粘贴的**原始文本**（trim 后），由 `runLogin` 调用 `extractCode`——保证 E2E 测试能经 hook 打桩覆盖"粘贴 URL → 提取 code"的接线。非 TTY/`--json` 时抛 UsageError，hint 指向 `--code`。
- **R5 删除浏览器通道残留**：`--channel` 参数、`AuthorizeChannel` 类型、`resolveChannel`、`defaultSelectChannel`、`selectChannel` hook、`openBrowser`/`captureCode` hook 与 import。
- **R6 删除 loopback 机制**：oauth.ts 中 `openBrowser`、`DEFAULT_LOOPBACK_URI`、`LoopbackTarget`、`parseLoopback`、`CaptureOptions`、`captureCodeFromLoopback`，及随之无用的 import（`node:child_process` spawn、`node:http` createServer/Server、`configFilePath`、`Ctx` 类型）。模块头注释改写为 paste-only 描述。`AuthError`/`UsageError` import 保留（extractCode 用）。
- **R7 删除 `oauthRedirectUri` 配置**：config.ts 4 处（Config 类型 :80、ResolvedSettings :111、readConfig :321-322、settings 构建 :425）、globals.ts:157、`Ctx.oauth` 字段（context.ts:36, 67）。旧配置文件里残留的 `oauthRedirectUri` 键无害（未声明键被忽略），不写迁移。
- **R8 测试更新**：
  - `test/oauth.test.ts`：删除 openBrowser/captureCodeFromLoopback/parseLoopback 相关 describe 及只服务于它们的 helper（`freePort`、`waitForPort`、`ctxOn`、childProcess mock、net/createTestContext import）；printAuthorizeUrl 断言按新文案更新；新增 `extractCode` describe（URL+code、URL+domain 忽略、裸 code、空白 trim、`?error=` → AuthError、error_description、URL 无 code → UsageError、畸形 URL → UsageError、空 → UsageError）。
  - `test/authCommands.test.ts`：beforeEach 去掉 openBrowser stub；各 `loginHooks.captureCode` 打桩改为 `loginHooks.readPaste`；"browser channel" 测试重写为默认纯粘贴路径（保留 user slot 持久化 + `/v1/myself` verify + stderr URL 断言）；"paste channel" 测试合并进默认路径；新增"粘贴完整跳转 URL → 提取 code 交换"的 E2E（readPaste 打桩返回 `http://127.0.0.1:8732/callback?code=X&domain=htz`，断言 token 调用携带 code=X）；`--code` 测试去掉 captureCode stub（readPaste 打桩仍须抛错，证明 --code 不经提示）；`--channel bogus` 拒绝测试改为"未知参数 `--channel` 被 Commander 拒绝（exit 2）"，钉住 breaking 行为。
  - help 快照：`auth.test.ts.snap` 删 `--channel` 行、更新 `--code` 描述；`test/help/auth.test.ts` 的 describe/it 标题去 channel 措辞；快照用 `vitest -u` 重生成。
  - `test/globals.test.ts`：删 `oauthRedirectUri` 断言（:150 行的 `ctx.oauth.redirectUri` undefined 断言、:153-160 整个 it）。
  - `test/config.test.ts`：删 fixture 中的 oauthRedirectUri（:168, :181, :248, :259）及其断言。
- **R9 规格文档**：`.trellis/spec/backend/database-guidelines.md:50` 删除 `oauthRedirectUri` 行。README / VERSIONING.md 的历史示例不动。
- **R10 版本影响**：移除 `--channel` 参数 + 删除 `oauthRedirectUri` 配置键 = breaking change。按 VERSIONING.md，**下一个 release 必须 MAJOR（2.0.0）**；本次不在 package.json 上 bump（版本号在 release 分支上 bump）。commit 信息注明 breaking。

## Acceptance Criteria

- AC1：`auth login --mode user`（TTY）不 spawn 任何子进程（无 xdg-open/open/cmd）、不监听任何端口；stderr 打印 authorize URL + 三步粘贴指引；提示符读取粘贴文本。
- AC2：交互粘贴 `http://127.0.0.1:8732/callback?code=ABC&domain=htz` → token 交换 URL 携带 `code=ABC`，登录成功（user slot 持久化 + `/v1/myself` verify）。
- AC3：交互粘贴裸 `ABC` → 同样成功。
- AC4：粘贴含 `?error=access_denied&error_description=...` 的 URL → exit 3（AuthError），stderr 含 `access_denied`。
- AC5：粘贴不含 code 的 URL（如 `http://127.0.0.1:8732/callback`）→ exit 2（UsageError），提示复制完整网址或粘贴 code。
- AC6：`--code X` 不经提示符、不经解析器直通；`--json --code X` 非交互成功。
- AC7：`--json` 且无 `--code` → exit 2（UsageError），hint 指向 `--code`。
- AC8：`--channel` 参数不存在：`auth login --channel paste` → Commander 未知参数错误 exit 2；`auth login --help` 无 `--channel` 行。
- AC9：`oauthRedirectUri` 不再出现在 Config/ResolvedSettings/Ctx 类型与读取逻辑中；含该键的旧配置文件可正常加载（键被忽略）。
- AC10：`npm run typecheck` 干净；`npm test` 全绿（含重生成的 help 快照）；`npm run build` 成功。
- AC11：enterprise 模式登录/status/logout 行为不变（回归）。

## Out of scope

- 不改 authorize URL 构造（仍无 redirect_uri 参数，PingCode 用 app 注册的回调）。
- 不改 token 交换 / 刷新 / verify（GET /v1/myself）逻辑。
- 不改 enterprise 模式任何行为。
- 不做 2.0.0 版本 bump（release 时做）。
- 不改 README / VERSIONING.md 的历史示例。
- 不调研 PingCode authorize 页面登录后的具体展示形态（解析器 URL/code 双接受 + 指引文案双覆盖已消除该未知的影响）。

## Open questions

无阻塞项。粘贴指引的最终英文文案在 design.md §3 给出，用户在最终规划摘要中一并确认。
