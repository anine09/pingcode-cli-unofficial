# design.md — auth login 纯粘贴登录，移除浏览器通道

## 1. 架构与边界

改动全部在 CLI 层 + 配置类型，core 只瘦身（`Ctx.oauth` 字段移除）。

```
auth.ts (runLogin user 路径)
  buildAuthorizeUrl(settings.host, clientId)        → oauth.ts（不动）
  printAuthorizeUrl(authorizeUrl)                   → oauth.ts（文案改为三步粘贴指引）
  code = flags.code ?? extractCode(await readPaste) → readPaste=readCodeFromTerminal（auth.ts，返回原始粘贴文本）
                                                   → extractCode（oauth.ts，新增纯函数）
  acquireUserToken(ctx, code) / getMyself(ctx)      → 不动
```

- `core`（context/config）只做字段删除：`Ctx.oauth`、`oauthRedirectUri`（Config + ResolvedSettings）。
- `api` 层不触碰。

## 2. 新纯函数 `extractCode`（src/cli/commands/oauth.ts）

```ts
/**
 * Pull the authorization code out of whatever the operator pasted.
 *
 * The paste accepts either the full redirect URL (the address-bar URL after
 * login, which carries ?code=...) or a bare code. A URL that carries an
 * `error` (OAuth denial) is surfaced as an AuthError instead of being sent
 * to the token endpoint, where it would fail opaquely.
 */
export function extractCode(pasted: string): string {
  const trimmed = pasted.trim();
  if (trimmed === '') {
    throw new UsageError('no authorization code entered', {
      hint: 'paste the code from the authorize page, or the full URL it redirected to',
    });
  }
  // Only scheme-prefixed input is treated as a URL; a bare code is never a URL.
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UsageError('the pasted text looks like a URL but could not be parsed', {
      hint: 'copy the full address-bar URL after the login redirect, or paste just the code',
    });
  }
  const error = url.searchParams.get('error');
  if (error !== null) {
    const description = url.searchParams.get('error_description');
    const suffix = description === null ? '' : ` (${description})`;
    throw new AuthError(`authorization was denied: ${error}${suffix}`, {
      hint: 're-run `pingcode auth login` and approve the consent screen',
    });
  }
  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    throw new UsageError('the pasted URL carries no `code` parameter', {
      hint: 'copy the full address-bar URL after the login redirect, or paste just the code',
    });
  }
  return code;
}
```

设计要点：

- 双形态接受（URL / 裸 code）——用户原话"从浏览器中拿到对应的返回文本粘贴"，返回文本就是跳转后地址栏 URL；裸 code 兼容现有 paste 用户与 `--code` 的心智。
- `error` 提前拦截，避免把 `?error=access_denied` 当 code 发到 token 端点得到不透明的 401。
- `domain` 参数（loopback 时代会捕获）对登录流程无用（`runLogin` 从来只用 `.code`），丢弃。
- 不引入新的 error kind（复用 UsageError exit 2 / AuthError exit 3）。

## 3. 指引文案（printAuthorizeUrl，stderr，英文）

```ts
export function printAuthorizeUrl(url: string): void {
  // The URL carries only `client_id`, but redactUrl is applied defensively so a
  // future param is never leaked (design §5.0, R9).
  errLine(`authorize URL: ${redactUrl(url)}`);
  errLine('1. open it in a browser, log in, and consent to the requested access');
  errLine('2. the browser then redirects to a URL containing ?code=... (the page may fail to load — that is fine)');
  errLine('3. copy the full URL from the address bar, or just the code, and paste it below');
}
```

覆盖两种 PingCode 实际表现（地址栏 URL / 页面显示 code）而无需确认其页面行为。

## 4. auth.ts 变更

- 删：`--channel` 参数（:116）、`AuthorizeChannel` 类型（:50）、`channel` flag 字段（:57-58）、`resolveChannel`（:359-366）、`defaultSelectChannel`（:633-640）、`selectChannel`/`openBrowser`/`captureCode` hook（:83-98 精简为 `{ selectMode, readPaste }`）、相关 import（`captureCodeFromLoopback`、`openBrowser` 删，新增 `extractCode`）。
- `runLogin` user 路径（:206-238）改为：

```ts
// --- user (authorization_code) path (design D12) ---
const clientId = requireClientId(ctx.credentials.clientId);

// print the authorize URL + paste instructions (stderr); no browser, no loopback.
const authorizeUrl = buildAuthorizeUrl(settings.host, clientId);
printAuthorizeUrl(authorizeUrl);

// obtain the code: an explicit --code skips the prompt entirely (non-interactive).
const code =
  flags.code !== undefined && flags.code !== ''
    ? flags.code
    : extractCode(await loginHooks.readPaste(ctx.json));
```

- `readCodeFromTerminal` → 改名 `readPasteFromTerminal`，返回**原始粘贴文本**（trim 后），不再自行抛"no authorization code entered"（空值交给 extractCode）：

```ts
async function readPasteFromTerminal(json: boolean): Promise<string> {
  if (json || process.stdin.isTTY !== true) {
    throw new UsageError('no authorization code available', {
      hint: 'run from a terminal to paste the code or redirect URL, or pass --code <code>',
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question('authorization code or redirect URL: ')).trim();
  } finally {
    rl.close();
  }
}
```

- `--code` 参数描述更新为 `'authorization code (skips the interactive paste)'`。

## 5. oauth.ts 变更

- 删：`openBrowser`（:72-85）、`DEFAULT_LOOPBACK_URI`（:26）、`LoopbackTarget`（:29）、`parseLoopback`（:93-105）、`CaptureOptions`（:107-110）、`captureCodeFromLoopback`（:112-200）。
- 删随之无用的 import：`spawn`（node:child_process）、`createServer`/`Server`（node:http）、`configFilePath`、`Ctx` 类型；保留 `AuthError`/`UsageError`（extractCode 用）、`redactUrl`、`errLine`。
- 模块头注释（:9-22）改写：paste-only，说明不再有 browser/loopback 通道。
- 新增 `extractCode`（§2）。
- `printAuthorizeUrl` 换文案（§3）。

## 6. 配置 / 上下文瘦身

- `src/core/config.ts`：删 `oauthRedirectUri`——Config 类型（:80）、ResolvedSettings（:111）、readConfig 两行（:321-322）、settings 返回（:425）。
- `src/core/context.ts`：删 `Ctx.oauth`（:35-36）与 createContext 的 `oauth` 默认（:67）。
- `src/cli/globals.ts`：删 `oauth: { redirectUri: settings.oauthRedirectUri },`（:157）。
- 兼容性：旧 config.json 里的 `oauthRedirectUri` 键被 readConfig 忽略（未声明键不入 Config），无需迁移；该键不再被写入。

## 7. 测试变更

- `test/oauth.test.ts`：删 openBrowser / captureCodeFromLoopback / parseLoopback 三个 describe + `freePort`/`waitForPort`/`ctxOn` helper + childProcess mock + 无用 import；printAuthorizeUrl 断言改为新文案；新增 extractCode describe（见 R8 用例清单）。
- `test/authCommands.test.ts`：见 R8。关键 E2E 新增：`loginHooks.readPaste = async () => 'http://127.0.0.1:8732/callback?code=URL-CODE&domain=htz'` → 断言 token 调用含 `code=URL-CODE`。`--channel bogus` 测试改为未知参数拒绝（exit 2）。
- help 快照：`vitest -u` 重生成 `auth.test.ts.snap`；`test/help/auth.test.ts` 标题去 channel 措辞（"pins the mode/channel/code flag surface" → "pins the mode/code flag surface"）。
- `test/globals.test.ts`：删 :150 的 `ctx.oauth.redirectUri` 断言、:153-160 整个 it。
- `test/config.test.ts`：删 oauthRedirectUri fixture/断言（:168, :181, :248, :259）。

## 8. 版本与发布

- Breaking（删 `--channel`、删 `oauthRedirectUri` 配置键）→ 下一个 release 为 **2.0.0**（VERSIONING.md §3 MAJOR）。本次不 bump package.json（release 分支上 bump），commit 信息注明 breaking。
- Rollback：本任务为纯删除 + 新增纯函数，`git revert` 单 commit 即可回滚；无数据迁移、无配置兼容层。

## 9. 风险

- 低：解析器规则（scheme 前缀判定）覆盖不到"无 scheme 的 URL"粘贴形态——地址栏复制的 URL 必带 scheme，风险可接受；`--code` 保持裸 code 语义不受影响。
- 低：PingCode authorize 登录后若把 code 展示在页面正文而非 URL，用户可复制正文（裸 code 路径）——指引文案已双覆盖。
