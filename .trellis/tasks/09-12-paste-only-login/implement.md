# implement.md — auth login 纯粘贴登录，移除浏览器通道

## 执行顺序（每一步都可独立验证，建议按序；1-2 与 3-6 无交叉写冲突但保持顺序便于 typecheck 收敛）

### Step 1 — 新增 extractCode（test/oauth.test.ts 先行）

1. `src/cli/commands/oauth.ts` 新增 `extractCode`（见 design.md §2）。
2. `test/oauth.test.ts` 新增 `extractCode` describe：
   - URL + `?code=ABC` → `'ABC'`；URL + `?code=ABC&domain=htz` → `'ABC'`（domain 忽略）。
   - 裸 `'ABC'` → `'ABC'`；`'  ABC\n'` → `'ABC'`（trim）。
   - `''` / `'   '` → UsageError（exit 2）。
   - URL `?error=access_denied` → AuthError，message 含 `access_denied`。
   - URL `?error=access_denied&error_description=User%20denied` → message 含 `User denied`。
   - URL 无 code 无 error（`http://127.0.0.1:8732/callback`）→ UsageError，hint 提示完整网址。
   - 畸形 URL（`http://[bad`）→ UsageError。
3. 验证：`npm run typecheck && npx vitest run test/oauth.test.ts`（此时 openBrowser 等旧测试仍在，跳过它们跑 extractCode 用例即可——vitest 支持 `-t` 过滤，或直接跑全文件等 Step 3 后统一）。

### Step 2 — auth.ts 登录路径改纯粘贴

1. 删 `--channel` 参数、`AuthorizeChannel` 类型、`channel` flag 字段、`resolveChannel`、`defaultSelectChannel`、`selectChannel`/`openBrowser`/`captureCode` hook；import 改为 `{ buildAuthorizeUrl, extractCode, printAuthorizeUrl }`。
2. `runLogin` user 路径按 design.md §4 重写（printAuthorizeUrl + `flags.code ?? extractCode(await loginHooks.readPaste(ctx.json))`）。
3. `readCodeFromTerminal` → `readPasteFromTerminal`（返回原始文本，prompt 文案 `'authorization code or redirect URL: '`，非 TTY hint 指向 `--code`）。
4. `--code` 参数描述改为 `'authorization code (skips the interactive paste)'`。
5. 验证：`npm run typecheck`（测试文件尚未更新，跑 `npm test` 会红——预期，Step 7 统一修）。

### Step 3 — oauth.ts 删除浏览器通道机制

1. 删 `openBrowser`、`DEFAULT_LOOPBACK_URI`、`LoopbackTarget`、`parseLoopback`、`CaptureOptions`、`captureCodeFromLoopback`；清理无用 import（spawn/createServer/Server/configFilePath/Ctx），保留 AuthError/UsageError。
2. 模块头注释改写为 paste-only 描述。
3. `printAuthorizeUrl` 换 design.md §3 三步文案。
4. 验证：`npm run typecheck`。

### Step 4 — 配置/上下文瘦身

1. `src/core/config.ts`：删 Config 类型（:80）、ResolvedSettings（:111）、readConfig（:321-322）、settings 返回（:425）中的 `oauthRedirectUri`。
2. `src/core/context.ts`：删 `Ctx.oauth` 字段（:35-36）与 createContext（:67）。
3. `src/cli/globals.ts`：删 :157 `oauth: { redirectUri: ... }`。
4. 验证：`npm run typecheck`。

### Step 5 — 规格文档

1. `.trellis/spec/backend/database-guidelines.md` 删除 :50 `oauthRedirectUri?: string; // registered loopback callback for the browser channel` 行。
2. 验证：无编译验证，肉眼确认该 spec 中 Config 形状清单与实际一致。

### Step 6 — 测试文件更新（先改代码再改测试，测试预期以 Step 1-4 后的实现为准）

1. `test/oauth.test.ts`：删 openBrowser/captureCodeFromLoopback/parseLoopback describe、`freePort`/`waitForPort`/`ctxOn` helper、childProcess mock、无用 import（net/childProcess/createTestContext）；printAuthorizeUrl 断言按新文案。
2. `test/authCommands.test.ts`：
   - beforeEach 删 `loginHooks.openBrowser = () => {}`。
   - 所有 `loginHooks.captureCode = ...` 打桩改 `loginHooks.readPaste = ...`（返回值：`'BROWSER-CODE'` 等）。
   - "browser channel persists..." 测试重写为默认纯粘贴路径（保留全部断言：user slot 持久化、`/v1/myself` verify、stderr 含 `oauth2/authorize`、`code=BROWSER-CODE`）。
   - "paste channel reads..." 测试合并进默认路径（同上一项）。
   - 新增 E2E：`readPaste` 打桩返回 `'http://127.0.0.1:8732/callback?code=URL-CODE&domain=htz'` → 断言 token 调用含 `code=URL-CODE`。
   - `--code` 测试：删 captureCode throw-stub，保留 readPaste throw-stub（证明 --code 不经提示）。
   - `--channel bogus` 测试改写为 `auth login --channel paste` → Commander 未知参数，exit 2，stderr 含 `unknown option`。
   - human 输出两个测试的 captureCode 打桩同步改。
3. `test/globals.test.ts`：删 :150 `expect(ctx.oauth.redirectUri).toBeUndefined();` 与 :153-160 整个 it。
4. `test/config.test.ts`：删 oauthRedirectUri fixture/断言（:168, :181, :248, :259）。
5. `test/help/auth.test.ts`：describe/it 标题去 channel 措辞（"pins the mode/channel/code flag surface (design D10/D12)" → "pins the mode/code flag surface (design D10/D12)"）。
6. 重生成 help 快照：`npx vitest run test/help/auth.test.ts -u`（先跑一次看 diff 是否符合预期：`--channel` 行消失、`--code` 描述更新，再 -u）。

### Step 7 — 全量验证（Quality gate）

```bash
npm run typecheck
npm test            # 全绿，含 auth/oauth/globals/config/help
npm run build
```

人工冒烟（可选，需 TTY）：`node dist/bin/pingcode.js auth login --mode user`，确认 stderr 三步指引、提示符、粘贴 URL 解析成功。

## 验证命令速查

- 单文件：`npx vitest run test/oauth.test.ts test/authCommands.test.ts test/globals.test.ts test/config.test.ts test/help/auth.test.ts`
- 全量：`npm run typecheck && npm test && npm run build`

## 风险文件 / 回滚点

- 风险文件：`src/cli/commands/auth.ts`（登录主流程）、`test/help/__snapshots__/auth.test.ts.snap`（快照 diff 需人工过目）。
- 回滚：单 commit，`git revert <sha>`；无配置迁移，回滚后旧 `oauthRedirectUri` 键自动恢复可读（readConfig 恢复）。

## 完成后

- commit 信息注明 breaking：`feat(auth)!: paste-only user login, remove browser channel and loopback`（`!` 标记 breaking，对应下个 release 2.0.0）。
- Phase 3 按 Trellis finish-work 收尾（spec 已在 Step 5 更新，journal/归档按流程）。
