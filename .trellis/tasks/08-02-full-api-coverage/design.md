# Design — PingCode Open API 全量覆盖（两层模型）

读 `prd.md`（S0–S5 / R1–R6 / A1–A4）在先，本文档不重述范围，只写技术形状。

记号：

- `[S§x]` = `.trellis/tasks/08-02-full-api-coverage/research/open-api-surface-460.md` 的小节，
  **端点路径与计数的唯一真源**，本文档所有路径逐字取自该文件，不得臆造。
- `[TH§x]` / `[SHIP§x]` = `.trellis/tasks/archive/2026-08/08-02-testhub-module/design.md` /
  `08-01-ship-cli/design.md`，切片与论证风格的先例。
- `[M§x]` = `.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/design.md`（分层、退出码、
  分页契约的原始决策）。
- 分层不变式与目录规则见 `.trellis/spec/backend/directory-structure.md`，由
  `test/layering.test.ts` 强制：`cli → {api, core}`、`api → core`、`core → 无`，
  且 `api` 不得 import `output`、`cli` 不得 import `node:fs` / `buildUrl`。

**本文档描述的架构已由评审定稿，实现子任务不得改变其形状。** 需要偏离时停下上报（PRD R1）。

---

## D1. 两层模型（本任务的载荷决策）

本任务不是「再写 107 个手写命令」，而是把覆盖率问题拆成两个成本曲线完全不同的层：

| 层 | 交付物 | 覆盖 | 成本 | 落地方式 |
|---|---|---|---|---|
| **Reach 可达层** | 一个生成的端点目录 + 一个通用执行器 | **459 / 459** | **O(1)** —— 与端点数无关 | F2 + F3，两个子任务 |
| **Ergonomics 精修层** | 手写命令、名字解析、表格列、错误码证据 | 现状 55 条叶子 → 约 150 条 | **O(n)** —— 每条都要实机证据 | S0–S4，按模块并行 |

> 现状基线：`test/help.test.ts` 断言 **5 个命令组 / 10 个子组 / 55 条叶子**。PRD R6 写的
> 「43 条叶子」是 `08-02-testhub-bootstrap-leaves` 落地前的快照值；两者不冲突，取代码里的
> 55 为基线，涨到约 150 的量级判断不变。

> **X1 实测回填（2026-08-05）：上面这行「约 150 条」是**叶子**估算，实测 254 条 —— 但**量级判断
> 并没有错**，错的是把叶子当成手写工作量的单位。命令与量法见 `research/x1-doc-measurements.md`。
>
> - **精修端点 158 / 459**（按 `(method, path)`），这才是与本表「O(n) 每条都要实机证据」同量纲的
>   数字，和「约 150」几乎吻合。
> - **命令叶子 254 / 10 组**，比估算多的 102 条几乎全部来自两处**一份实现产出多条叶子**的结构：
>   F5 的四个跨对象家族是一份实现挂五个实体（14 端点 → **70** 叶子），F4 把 31 个 resolver kind
>   各暴露成一条 `resolve` 叶子（+**32**）。两者都是 O(1) 的实现成本、O(n) 的叶子数。
> - 因此 README 发布的是**按模块的端点覆盖表**，并显式警告不要拿叶子数比端点数 —— 否则
>   D9 风险 5 想要的那块「欠债不隐形」的招牌会反过来虚报进度。

**降险声明（整棵任务树最重要的一句）**：F3 落地的那一刻，PRD A3 第一条「全部 459 个 v1 端点通过
`pingcode api` 可调用」即已达成，「完全体 CLI」的可达性验收结束。**S0–S4 之后的全部工作都是体验
增量，不是能力增量。** 因此任何一个 S 子任务被推迟、缩小或放弃，都不会让本任务回到「CLI 在 DevOps
语义上是断头的」那个状态。这是本任务能安全并行、能中途停下的根据。

### D1.1 为什么不 codegen 命令层

apiDoc 知道 `POST /v1/ship/ideas` 存在。它**不**知道：

- `GET /v1/ship/ideas` 的简单列表没有 assignee/日期/属性过滤，所以 `…/search` 才是唯一读路径
  （`endpoints.ts:38-41` 的注释就是这条结论）；
- `100725` 是 HTTP **400** 形状的「需求不存在」，`100711` 是工单版本，`100601`/`100603`/`100600`
  是 testhub 版本 —— 五行 `ERROR_CODE_OVERRIDES` 全部来自实机 smoke，文档里一个都没有
  （`wire.ts:171-247`；文档只公开 `100000` 与 `100038` 两个码，[S§4.4]）；
- 需求状态是**产品作用域**的、工作项状态是 `(project, work_item_type)` 双作用域的、
  `case_important_levels` 是唯一没有 library 作用域变体的 org 级列表 —— 这三条决定了
  `metadata.ts` 的缓存键形状，全部是实机与逐条阅读得出的（`metadata.ts:39-75`）；
- `paths` 是祖先链而不是节点自身路径，所以不能当别名注册（[TH§5] 的 live-verified 段）。

**codegen 能产出的部分（URL 拼接、参数名）本来就不是这个仓库里有价值的部分**；有价值的是
`endpoints.ts` 的注释、`ERROR_CODE_OVERRIDES` 的每一行证据、`metadata.ts` 的作用域规则，
而这三者都不可从 apiDoc 派生。所以：**生成数据，手写行为。**

### D1.2 精修层的准入门槛不变

一条命令进精修层，必须满足 `[TH§9]` / `[SHIP§9]` 已经建立的纪律：实机跑过、错误码要么带证据进
`ERROR_CODE_OVERRIDES` 要么写明为什么不加（PRD R5）、`--json` 纯净、`--dry-run` 不写入。
够不上这个门槛的端点留在通用层可达即可 —— 这不是妥协，这是把证据成本花在会被真正使用的路径上。

---

## D2. 生成数据，不生成代码

### D2.1 唯一生成物

```
src/core/catalog/catalog.generated.ts   ← 生成，459 条普通对象，禁止手改
src/core/catalog/index.ts               ← 手写，加载 / 查找 / 匹配 / 校验
scripts/catalog-sync.ts                 ← 手写，按需抓取并规范化
```

条目形状（逐字段设计，字段名即契约）：

```ts
export type CatalogEntry = {
  /** 稳定 slug `<module>.<group>.<verb>`，如 `scm.commits.get`、`pjm.work_items.search`。
   *  由 (method, path) 派生且幂等：上游改标题不会改 id，只有路径迁移才会。*/
  id: string;
  /** 顶层命名空间，取 URL 的 area 段：pjm / ship / testhub / scm / build / release /
   *  directory / wiki / relations / comments / attachments / activities / participants /
   *  reviews / permission / security / workloads / nexus / auth / myself（[S§2]）*/
  module: string;
  /** apiDoc 的分组名（中文），如「工作项」「托管平台」。`api list` 的分面维度。*/
  group: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 原样路径，含 `{...}` 占位段，如 `/v1/scm/commits/{commit_id_or_sha}` */
  path: string;
  /** 从 `{id}` / `:id` 段解析出的有序占位名，如 ['product_id','repository_id'] */
  pathParams: string[];
  query: { name: string; type: string; required: boolean }[];
  body: { name: string; type: string; required: boolean }[];
  /** 派生规则见 D2.3 */
  paged: 'query' | 'search' | false;
  tokenType: 'APP' | 'ENT' | 'USER';
  /** 去掉 `pcp:` 前缀，如 ['read:devops:code']；文档未声明时为 [] */
  scopes: string[];
  title: string;
  deprecated: boolean;
};
```

`deprecated` 恒为 `false`（[S§7]：459 条里零条带 apiDoc 的 deprecated 标记）。**仍然保留这个字段**：
上游没有 changelog，唯一的下线信号就是条目消失或标记出现，字段留着才能让 `catalog:check` 的 diff
有地方落。

### D2.2 明确**不**生成的四类东西

1. **响应模型与 parser。** apiDoc 的 success 字段定义不完整且不一致（[S§4.2] 的两种结构、
   [TH§11] 记录的「读回对象、写传 `*_id` 标量」）。459 个 interface + 459 个 parser ≈ 15k 行
   没人读、且会在未知处静默出错的代码。通用层契约是**原样 JSON 透传**（PRD 非目标）。
2. **命令注册与帮助文本。** 生成的 help 文本没有 `[TH§7]` 那类「PATCH 省略 `executor_id`
   是 no-op」的知识，等于用一堆看起来权威的空话污染 `--help`。
3. **名字→ID 解析器。** 通用层只接受 ID（PRD 非目标），名字解析由 D4 的 `RESOLVERS` 手工登记。
4. **长尾 `api/` 封装。** 通用层直接走 `core/http.ts` 的 `request()`，不经 `api/*`。

### D2.3 派生规则（必须可测、可复现）

- `paged`：参数表里出现 `page_index` → `'query'`；路径以 `/search` 结尾且 method 为 POST →
  `'search'`；否则 `false`。**注意**：[S§4.1] 明说分页是全局约定、**不**在每个端点的参数表里重复，
  所以纯靠参数表会把绝大多数列表判成 `false`。因此补一条派生：`method === 'GET'` 且路径不以
  `/{...}` 结尾（即"集合"形状）→ `'query'`。这条是启发式，**必须在 F2 落地时把它对 459 条的判定
  结果落盘成快照并人工过一遍**，误判在 `core/catalog/index.ts` 里以手写 override 表修正
  （override 表是手写文件，允许改；生成文件不允许）。
- `tokenType`：apiDoc 的令牌说明散文里唯一稳定的三种表述，映射为 `APP`（双令牌可用，388 条）/
  `ENT`（企业令牌 only，61 条）/ `USER`（用户令牌 only，7 条）—— [S§1.4]/[S§7]。
  本 CLI 的 `client_credentials` 拿到的是**企业令牌**，所以 `APP` 与 `ENT` 都可达，`USER` 不可达。
  ⚠️ **388 + 61 + 7 = 456，比 459 少 3。** PRD 定稿的**假设**是：差的 3 条为 `/v1/auth/token`
  的三种 grant（`client_credentials` / `authorization_code` / `refresh_token`），它们**不需要任何
  令牌**（就是用来换令牌的），因此不属于三类中的任何一类，`456 + 3 = 459` 闭合。
  这是假设不是事实：F2 同步时若发现某条业务端点也落在三类之外，`tokenType` 需要第四种取值
  （建议 `NONE`），届时回写本节与 PRD。**在假设被证伪之前，`tokenType` 保持三值联合类型。**
- `scopes`：文档声明为空就留空数组，**不猜**。27 条通用层端点与 2 条 `*/bulk` 确实声明为空
  （[S§1.4]、[S§7]A），这是事实而非解析失败，`api describe` 要如实显示「文档未声明 scope」。

### D2.4 provenance 与防篡改（PRD R2）

生成文件头部：

```ts
/**
 * GENERATED FILE — DO NOT EDIT.
 * source:   https://open.pingcode.com/api_data.js
 * snapshot: 2026-08-02
 * upstream sha256: <上游 payload 的 sha256>
 * entries:  459   (all /v1; the oauth2 authorize page is excluded, see D2.8)
 * generator: scripts/catalog-sync.ts
 * content sha256: <本文件正文的 sha256，正文= 头部之后的全部字节>
 */
```

三条新增防护规则，各自的测试落点写清：

| 规则 | 测试落点 | 失败形态 |
|---|---|---|
| (a) `catalog.generated.ts` 只允许被 `core/catalog/index.ts` import | `test/layering.test.ts` 新增一条 case（复用它现成的 `importsOf` 扫描） | 任何其他文件 import 生成物 → 分层测试红 |
| (b) 内容哈希自校验 | `test/catalog.test.ts`：读文件、剥头、算 sha256、与头部声明比对 | 手改一个字节 → CI 红，附「run `npm run catalog:sync`」提示 |
| (c) diff 噪音隔离 | 无测试，`.gitattributes` 加 `src/core/catalog/catalog.generated.ts -diff linguist-generated=true` | review 里不再出现 6000 行 diff |

**`endpoints.ts` 保留，不被 catalog 取代。** 两者角色不同：`endpoints.ts` 是**可读的、带实机注释的
精修视图**（146 行里有一半是注释，记录了单数 area 段陷阱、`short_id` 只能读、
`plan_types` 的 scope 不是 configuration 等），catalog 是**穷举的机器视图**。新增测试断言
`ENDPOINTS` 里每条路径（含函数式路径以样例 id 求值后再模板化）都能在 catalog 里按
**method + path** 命中 —— 这是唯一能自动捕获上游路径迁移的手段，因为上游没有 changelog（[S§8]）。

### D2.5 同步与漂移

`scripts/catalog-sync.ts`：

- `npm run catalog:sync` —— 抓 `https://open.pingcode.com/api_data.js`（2.3 MB `define({...})`
  AMD 包），剥壳、规范化、重写生成文件与两个 sha256。
- `npm run catalog:check` —— 抓线上、与入库快照比对，输出「新增 / 消失 / method 变更 / 路径变更 /
  scope 变更」五类 diff，有 diff 则非零退出。
- **`catalog:check` 是每周定时 CI 任务，不是 PR 门禁。** 理由：它依赖外网，且上游变更与本次 PR
  无关；当成 PR 门禁会让一次上游改动阻塞所有人的合并。定时任务失败 → 开一个 follow-up 任务。
- **绝不运行时抓取**（PRD 非目标）。快照入库，`pingcode api` 只读本地生成物。
- 只用中文包。英文包 `api_data_en.js` 是 347 条的旧构建、group 名甚至被污染成绝对构建路径
  （[S§8]），并且它独有的 16 条正是已删除/改名的遗留端点 —— 那份 diff 是有价值的迁移图，但**不是
  当前真源**。

### D2.6 性能风险与退化方案（PRD A4 的风险点）

459 条 × 每条含两个参数数组，估计 300–600 KB TS。对策，按优先级：

1. **保持普通对象**，不对整棵结构做深 `as const`。深 `as const` 会让 tsc 为每个字符串字面量生成
   独立类型，是同类问题里最常见的编译时间爆炸源。类型由手写的 `CatalogEntry` 注解，
   写成 `export const CATALOG: readonly CatalogEntry[] = [ … ]`。
2. **F2 前后必须量 `tsc --noEmit` 墙钟时间**（各三次取中位数），写进 F2 的完成记录。这是 PRD A4
   「无显著退化」的唯一可核验形式。
3. 退化严重（判定线：中位数增幅 > 50% 或绝对增量 > 5s）则退化方案是把 catalog 改为 **JSON 资产**
   + `tsup` 的 `loader: { '.json': 'json' }`，类型只留手写的 `CatalogEntry`。此路径已在
   `tsup.config.ts` 可达，不引入新依赖（PRD 的零新依赖纪律）。

### D2.7 为什么 catalog 放在 `core/`

`core/catalog/index.ts` 需要被 `core/metadata`（令牌类型/scope 提示）与 `cli/commands/api.ts`
同时使用。放 `api/` 会让 `core → api` 出现反向依赖，违反分层不变式；放 `cli/` 则 `core` 用不了。
放 `core/` 是唯一不破坏 `core → 无` 的位置 —— 与 `endpoints.ts`、`redact.ts` 当年落在 `core/`
的理由完全一致（见 spec 的「Layering pressure resolved correctly」）。PRD R1 已把
`core/catalog/`、`core/metadata/` 列为允许新增的唯一例外。

### D2.8 catalog 恰 **459** 条：`authorize` 为什么被剔除

PRD 已定稿口径：**459 个 v1 API 端点**，catalog 条目数恰为 459，且**每条的 `path` 都以 `/v1/` 开头**。

被剔除的是 `GET {oauth2_root}/authorize`（[S§3.1] 第四行）。三条互相独立的理由，任一条都足够：

1. **不是 `/v1`。** 它挂在 `{oauth2_root}` 下（`open.pingcode.com/oauth2`），与
   `{rest_api_root}/v1[/{area}]/{resource}` 那套 URI 结构无关（[S§2]）。让它进 catalog 会毁掉
   「每条 path 以 `/v1/` 开头」这个可断言的不变式，而这个不变式是路径匹配算法（D3.2）的前提。
2. **不返回 JSON。** 它返回一个供人操作的 HTML 授权页，`readResponse()` 只会把它变成
   `TransportError`（`wire.ts:102-116`）。放进 catalog 等于给 `pingcode api` 一条注定失败的条目。
3. **不是可调用的端点，是浏览器重定向。** 调用它的正确方式是把用户的浏览器送过去、再从
   `redirect_uri` 收 `code`（[S§1.2]）。这属于 OAuth 授权码流程，PRD 明确另开任务。

**上一轮的折中口径「459 条 `/v1` + 1 条 oauth2 = 460」作废。** catalog 里不再有它的位置，
也不需要给它编一个 `tokenType`。它在 PRD 里单列为「1 个非 API 授权页（排除）」，仅作口径换算说明；
`pingcode api` 遇到该路径时走**未知路径**分支（D3.2 第一行）—— exit 2 + 最近匹配建议，
措辞里可以额外点出「这是浏览器授权页，不是 REST 端点」。

两个直方图因此天然自洽，不再需要"针对子集"这种限定：method 直方图
GET 250 + POST 96 + PATCH 54 + DELETE 49 + PUT 10 = **459**；[S§2] 的 area 直方图逐项相加
（其中 auth 记作 3，即三种 grant）**也是 459**。

---

## D3. 通用执行器 `pingcode api`

### D3.1 形态

```
pingcode api GET    /v1/wiki/pages --query space_id=abc --page 0 --page-size 100
pingcode api GET    /v1/scm/commits/9f3c1ab           # 路径参数直接写在路径里
pingcode api POST   /v1/wiki/pages --body-file page.json
pingcode api POST   /v1/relations --set principal_type=work_item --set principal_id=xxx
pingcode api PATCH  /v1/build/builds/<id> --set status=success
pingcode api DELETE /v1/wiki/pages/<id> --yes
```

- `--query k=v`（可重复）→ 走 `wire.ts:buildUrl` 的现成序列化（nullish 丢弃、数组 CSV）。
- `--body-file <path>` 读 JSON 文件；`--body -` 读 stdin；`--set k=v`（可重复）复用
  `common.ts:parseSetFlags`，值**原样**送出（不做类型推断 —— 见 `parseSetFlags` 的注释：
  select 型属性要的是 option 的 `_id` 而不是显示文本，猜类型只会制造新的失败模式）。
  三者互斥，同时给 → exit 2。
- 输出：**恒为 stdout 原始 JSON**。因此 `--json` 在这一层是 **no-op**，必须在 `--help` 与
  SKILL.md 里显式写明「`pingcode api` 的 stdout 始终是 JSON，`--json` 不改变任何行为」。
  副作用是这层天然 agent 安全：没有表格、没有本地化时间、没有列裁剪。

### D3.2 发请求**前**的 catalog 校验与退出码

| 情形 | 行为 | 退出码 |
|---|---|---|
| 路径在 catalog 中不存在 | `UsageError`，附最近匹配建议：`did you mean /v1/wiki/pages/{page_id}?`（按段数相同 + 段级编辑距离取前 3） | **2** |
| method 与路径不匹配（如 `DELETE /v1/pjm/projects/{id}`，[S§3.8.1] 明确无此端点） | `UsageError`，列出该路径支持的 method 集合 | **2** |
| 缺必填 query / body 字段 | `UsageError`，**指名**缺哪个字段 | **2** |
| `tokenType === 'USER'` | `UsageError`：「本 CLI 只实现 client_credentials 企业令牌，该端点要求用户令牌；OAuth 授权码流程是另一个任务」 | **2** |
| `tokenType === 'ENT'` | 放行。CLI 持有的就是企业令牌（PRD 鉴权前提），这是本任务能覆盖 CICD 段的根据 | — |
| DELETE 未给 `--yes` | `UsageError` | **2** |

裸路径匹配算法（`core/catalog/index.ts`）：把用户给的路径按 `/` 切段，与 catalog 条目逐段比对，
catalog 的 `{xxx}` 段通配任意单段。段数不同直接不匹配。**先精确后通配**：`/v1/testhub/case/states`
与 `/v1/testhub/cases/{case_id}` 段数相同且第三段不同，精确优先能正确区分 —— 这就是单数 area 段
陷阱在通用层的自动解法（PRD R2）。

### D3.3 403 时的 scope 提示（严格优于现状）

`wire.ts:163` 的 `SCOPE_HINT` 现在是一段猜测性散文（「generic endpoints … inherit their scope
from `principal_type`，所以服务端消息可能有误导」）。有了 catalog，403 时可以把该端点
**文档声明的 scope 原文**追加进去：

```
403 … the token lacks the required scope.
this endpoint declares: pcp:write:devops:code
check the app's scopes in 凭据管理.
```

实现约束：`wire.ts` 是 PRD R1 的禁改文件。因此**不改 `wire.ts`**，而是在 `cli/commands/api.ts`
捕获 `PermissionError` 后，用 catalog 的 scopes 补一行 stderr。文档声明为空的 27 条则打印
「该端点在文档中未声明 scope（[S§1.4]，待实机确认）」—— 如实说不知道，比编一个 scope 名强。

### D3.4 分页

`paged` 字段自动驱动 `--page / --page-size / --all / --limit`，直接复用 `core/paginate.ts` 的两种
风味，不新写分页代码：

- `paged === 'query'` → `paginate()` / `fetchPage()`（0-based `page_index`，上限 100，
  `--all` 按 id 去重、遇短页停、尊重 `--limit`）；
- `paged === 'search'` → `searchPaginate()` / `fetchSearchPage()`，分页参数进
  `payload.page_size` / `payload.page_index`（[S§4.1]）。共 5 个 search 端点：
  `pjm/work_items`、`ship/ideas`、`ship/tickets`、`testhub/cases`、`testhub/runs`（[S§4.3]）；
- `paged === false` → 直接 `request()`，`--page*` 给了就 exit 2（不静默忽略）。

### D3.5 通用层新增零个失败模式（必须论证，这是它安全的根据）

`pingcode api` 走的是 `core/http.ts:request()` 这个唯一 choke point，因此下列行为**全部免费继承**，
一行不写：

| 能力 | 来源 |
|---|---|
| `--dry-run` 对写请求抛 `DryRunHalt`、请求绝不发出 | `http.ts:58-65` |
| URL / header / 片段脱敏（`client_secret` 走 query string！） | `redact.ts`，由 `http.ts` 与 `wire.ts` 调用 |
| 401 → 重取令牌并**只**重放一次 | `http.ts:97-102` |
| 429 → 尊重 `x-pc-retry-after`、封顶 60s、只重试一次；无 header 则快速失败 | `http.ts:82-95` |
| 2xx 一律成功（绝不比对 201）、非 2xx 状态优先 + `code` 覆盖映射 | `wire.ts:102-116, 252-303` |
| 退出码表（0/1/2/3/4/5/6/7/8） | `errors.ts`，`.trellis/spec/backend/error-handling.md` |

**通用层唯一新增的失败模式是「catalog 说不存在」，且它发生在任何网络 IO 之前。** 这就是为什么
把 459 个端点一次性放开是安全的：危险面不随端点数增长，只随 `--yes` 的门禁质量变化（见 D8）。

### D3.6 发现能力（让 459 真正可用的那一半）

```
pingcode api list --module scm            # 表格：METHOD PATH TITLE SCOPES TOKEN
pingcode api list --search commit         # 在 path/title/group 上做子串匹配
pingcode api list --token ENT             # 枚举 61 条企业令牌 only
pingcode api list --method DELETE         # 枚举 49 条 DELETE，安全审计用
pingcode api describe scm.commits.get     # 单条详情：路径参数、query、body、scope、分页风味
pingcode api describe GET /v1/scm/commits/{commit_id_or_sha}   # 也接受 method+path
```

`list` 用 `printCollection` + `Column<CatalogEntry>[]`（`cli/output.ts:114`），`--json` 输出
`{values, count}`，与全仓的列表契约一致。

**论证**：没有 `api list`，「459 个端点可达」等于「用户得开着文档站抄路径」，而文档站是一个
客户端渲染的 SPA、每条端点的锚点是约 200 字符的百分号编码（[S§0]），人和 agent 都用不了。
有了 `api list` / `api describe`，agent 既不需要文档站，也不需要一份把 459 条端点逐行罗列的 SKILL.md ——
它只需要一个**有文档的元命令**，剩下的自己查。这是本任务里单点性价比最高的设计。

---

## D4. metadata 表驱动重构

### D4.1 现状诊断（重要：这不是一次重写）

`core/metadata.ts` 1457 行，但抽象**已经**建好了：

- `resolveWith(ctx, spec)`（`:267`）是引擎：id 精确匹配 → 大小写不敏感的精确名/别名匹配 →
  唯一性检查 → 缓存失效重试一次 → `passThroughWhenEmpty`。**所有解析语义都在这里，只有一份。**
- `scopedKey(ctx, kind, parentId?, scope?)`（`:672`）已经通用。
- `productScoped(kind, label, path, hint?)`（`:698`）已经是工厂，8 个 ship resolver 由它产出；
  `libraryScoped`（`:1206`）是 testhub 的同构工厂。

**80% 已经完成。** 剩下的是机械工作：把散在 700 余行里的近似重复 resolver 体压成一张表。
这条诊断很重要 —— 它说明 F4 是低风险重构，而不是把核心解析逻辑重写一遍。

### D4.2 目标形状

```
src/core/metadata/
├── registry.ts   RESOLVERS 表 + MetaKind 派生
├── resolve.ts    resolveWith / loadList / loadSuiteTree / 缓存 / withCacheInvalidation
└── index.ts      再导出全部现有公共符号
```

**`index.ts` 必须让所有现有 import 路径不变。** 现在 `from '../../core/metadata'` 出现在
`common.ts`、四个命令文件与三个测试文件里；`node`/TS 的目录解析会把
`core/metadata` 指向 `core/metadata/index.ts`，所以**一个 import 都不用改**，这也是
「既有测试未经修改即通过」这条硬验收能成立的机制。

`registry.ts` 的每一行长这样：

```ts
export const RESOLVERS = {
  'ship-idea-state': {
    label: 'idea state',
    path: ENDPOINTS.shipIdeaStates,
    parent: 'product',                    // 缓存键的 parentId 来自哪个上游解析
    parentQuery: 'product_id',            // 列表请求里 parent 的参数名
    aliases: [],                          // toCandidate 的 aliasKeys
    hint: 'idea states are scoped to the product; …',
  },
  // …
} as const satisfies Record<string, ResolverSpec>;

export type MetaKind = keyof typeof RESOLVERS;
```

`MetaKind` 由表派生，取代 `metadata.ts:32-75` 那份手写 union。**穷举性由构造保证**：新增一行
就有新 kind，不可能出现「加了 resolver 忘了加 union 成员」或反之。

量化目标：约 700 行近似重复的 resolver 体 → 约 40 行表；每个仍需手写的 resolver 体 ≤ 5 行
（只允许「取表、算键、调 `resolveWith`」）。

### D4.3 保持定制的部分（写明理由）

- `parseWorkItemRef`（`:550`）与 `resolveWorkItem`（`:592`）**不进表**。它们不是「名字→ID」：
  前者从 URL / identifier / `short_id` 三种形态里认出引用类型（`IDENTIFIER_RE`），后者按
  identifier 走列表查询、按 id/`short_id` 走单资源 GET，返回的是 `WorkItemLocator` 而不是
  `ResolveResult`，且有自己的 0/多命中错误措辞。塞进表只能靠 `if (kind === 'work_item')` 开洞。
- `loadSuiteTree` + `SUITE_PATH_SEPARATOR`（`:795`）保持独立函数：它把「树以扁平列表返回」
  拍平并生成 `Parent / Child` 别名与跨分支歧义错误（[TH§5]）。表里以
  `load: 'suiteTree'` 这样的判别式引用它，而不是把树逻辑塞进表。
- `resolveShipRef`（`:1076`）、`resolveProductMember`（`:879`）同理，按需保留。

### D4.4 通用层只接受 ID，所以要给 agent 一把解析器

`pingcode api` 不做名字解析（PRD 非目标）。但要求 agent 手工去查 ID 会把通用层的可用性打回文档站。
因此新增一个薄命令组，把 `RESOLVERS` 直接暴露：

```
pingcode resolve --list                                  # 枚举全部 kind、它们的 parent 与 label
pingcode resolve project "移动端 App" --json              # → {"kind":"project","input":…,"id":…,"name":…}
pingcode resolve ship-idea-state 已评审 --parent <product_id> --json
```

于是组合可用，且不需要通用层懂任何业务：

```bash
pingcode api GET /v1/wiki/pages --query space_id=$(pingcode resolve wiki-space "研发" --json | jq -r .id)
```

`resolve` 的输出就是 `ResolveResult`（`metadata.ts:95`）序列化后的样子，字段名不变。

### D4.5 硬性验收

**行为零变化。** 既有 `test/metadata.test.ts`(419) / `shipMetadata.test.ts`(538) /
`testhubMetadata.test.ts`(720) —— 合计 1677 行 —— **未经修改**即通过。任何一行测试需要改，都说明
行为变了，属于 F4 失败（PRD A3 最后一条同款要求）。这是本重构唯一的验收口径，不需要额外证明。

---

## D5. 跨对象资源：注入一次、多处挂载、不设顶层组

### D5.1 设计理由：`principal_type` 是挂载点已知的信息

通用层的 27 个端点对 `principal_type` + `principal_id` 多态（[S§3.7]）。而
`pingcode project work-item comment add SCR-5 --text "…"` 里，`principal_type=work_item` 是
**命令路径本身**就决定的，`principal_id` 是位置参数解析出来的。**要求用户输入 `--principal-type`
即是一个失败模式**：它可以被填错，而错的那次会把评论挂到另一类对象上（如果服务端接受）或返回一个
和用户输入毫无关系的错误码。挂载点已知的东西，不要问用户。

### D5.2 一份实现，多处挂载

```
src/api/common.ts                      relations / comments / attachments / activities 的封装
src/cli/commands/_shared/crosscutting.ts   addCrosscutting(parent, principalType, opts)
```

`addCrosscutting` 给父命令挂上 1–4 个子组，`opts` 声明该实体真正支持哪些族与哪些动词。

**挂载点（F5 实机确认后的定稿，2026-08-03）**。原先此处写的是"举例"，其中一条被实机否掉了，
现在改为实测结论表 —— 五个挂载点，每个都挂满四族：

| 挂载点 | `principal_type` | relation | comment | attachment | activity |
|---|---|---|---|---|---|
| `project work-item` | `work_item` | ✅ | ✅ | ✅ | ✅ |
| `product idea` | `idea` | ✅ | ✅ | ✅ | ✅ |
| `product ticket` | `ticket` | ✅ | ✅ | ✅ | ✅ |
| `testhub cases` | `test_case` | ✅ | ✅ | ✅ | ✅ |
| `testhub runs` | `test_run` | ✅ | ✅ | ✅ | ✅ |

每个挂载点 14 条叶子：relation/comment 各 4、attachment 4（`list|get|add-snippet|delete`，
文件上传见 D5.5）、activity 2。

**`testhub plans` 不是挂载点 —— 这是本节唯一被实机推翻的判断。** 测试计划根本不是 principal：
`comments` / `attachments` 以 `100049` 拒绝 `principal_type=test_plan`，而 `activities`
返回 **HTTP 500**（不是 4xx）。第五个挂载点因此从 plans 移到 **runs**（`test_run` 四族全通）。
连带结论：**principal_type 词表不可运行时探测** —— 探测一个不支持的值可能打到 500。

**词表按族不同，不可互换**（厂商 `allowedValues` 原文，实机逐个验证）：

```
comments     work_item · test_case · test_run · idea · ticket · page
attachments  work_item · test_case · test_run · idea · ticket · page   (+ work_item_deliverable 仅文件上传/单条 GET)
activities   work_item · test_case · test_run · idea · ticket          ← 无 page
relations    厂商未声明任何 allowedValues → 只有实机矩阵（见 D7.6 与 api/common.ts）
```

注意用例的 token 是 **`test_case` 而不是 `case`**（[th#2] 的单复数陷阱换了个地方重演），
执行用例是 `test_run`。

**只挂该实体真正支持的族，并由 catalog 断言。** 把一个不支持的族挂上去是 bug，而 catalog 能抓到
它：测试遍历所有挂载点，对每个 `(principalType, family)` 组合断言 catalog 里存在对应端点。
（注意 catalog 只能证明*端点存在*，不能证明*该 principal_type 被该端点接受* —— 后者只有实机能证，
所以 A2 那条要求四类实体上都实机跑通。F5 把实测词表落成 `api/common.ts` 的 `PRINCIPAL_TYPES`
表，测试对着它断言，注释里带观测日期。）

### D5.3 DELETE 需要父引用，这是形状约束不是啰嗦

`DELETE /v1/comments/{comment_id}?principal_type=&principal_id=` 与
`DELETE /v1/attachments/{attachment_id}?principal_type=&principal_id=` 的 query 里**要**带
principal（[S§3.7]），而 `DELETE /v1/relations/{relation_id}` **不**要。因此删除子命令的签名是
`… comment delete <parent-ref> <comment-id> --yes`（两个位置参数），relation 则可以只给
`<relation-id>`。为了一致性，relation 也接受父引用形态但忽略之 —— **不**为了少一个参数而让四个族
的签名各不相同。

### D5.4 不设顶层 `pingcode comment` 组

一个顶层 `pingcode comment list --principal-type work_item --principal-id <id>` 需要用户手输
principal_type，即 D5.1 说的那个失败模式；而它能表达的一切，已经被
`pingcode api GET /v1/comments --query principal_type=work_item --query principal_id=<id>`
**免费**覆盖，且后者不需要维护、不占帮助快照、不需要错误码证据。顶层组严格劣于已存在的东西，
所以不做。

**唯一例外：`reviews`。** `/v1/reviews` 那 8 条（[S§3.7] 后半）在 scm 语境下是一等工作流对象：
`POST /v1/reviews` 建评审、`POST /v1/reviews/{id}/principals` 往里加内容。`pingcode scm review …`
是合法的一等命令组，不算跨对象注入。注意它与
`…/pull_requests/{pull_request_id}/reviews`（[S§3.12.6]，5 条，ENT only）是**两套不同的东西**，
命令面上必须区分：前者是通用评审对象，后者是 PR 上的代码评审记录。PRD 已把 `/v1/reviews`
列在 Out of scope 并注明「若在 S1 代码评审中被证明必需则回收进 S1」。

### D5.5 附件写入：先验证，可降级

`POST /v1/attachments` 有两种 content-type：文件走 `multipart/form-data`，代码片段走
`application/json`（[S§1.3]）。而 `core/http.ts` 只会在写动词上设 `application/json`
（`http.ts:51-53`），`wire.ts:sendRequest` 只会 `JSON.stringify(body)`。**multipart 上传需要改
`wire.ts` / `http.ts`，而这两个文件是 PRD R1 的禁改文件。**

因此：**S0 实现前必须先实机验证 `POST /v1/attachments` 是否需要预签名两步流程**（PRD Open
Question 第一条）。三种结局：

1. 单步 multipart → 仍然要碰 `wire.ts`，**停下上报**，作为独立子任务处理；
2. 预签名两步 → 附件写入降级为独立子任务，本任务只做 `list` / `get` / `delete`；
3. 代码片段的 JSON 形态可用 → 先只做 `attachment add-snippet`，文件上传另行处理。

无论哪种，`attachment list|get|delete` 都可以先落地，不被阻塞。

**F5 实机裁定（2026-08-03）：结局 1 与 结局 3 同时成立。**

- **文件上传是单步 multipart，没有预签名**：厂商文档的 `content-type: multipart/form-data` +
  form-data 里一个真实的 `file` 部件（示例值是一个本地路径），没有第二跳、没有签名 URL。
  `wire.ts:sendRequest` 只会 `JSON.stringify(body)`，`http.ts` 只会在写动词上设
  `application/json` —— 两者都是 PRD R1 禁改文件。**因此文件上传在 F5 范围外，未实现，
  未绕过，也未修改任何禁改文件。** `attachment add` 这个叶子不存在。若将来要做，它是一个
  独立子任务，且必须先取得给 `wire.ts` 加 multipart 通道的授权。
- **代码片段的 JSON 形态可用，但有一条未文档化的硬约束**：`comment_id` 文档写"可选"，
  实机**必填** —— 不带它的每一次尝试都是 `100039 请求参数错误`（`format` 用遍
  `allowedValues` 全表也一样）。片段永远挂在评论上，因此也不出现在对象级
  `GET /v1/attachments` 列表里，读/删同样要带 `comment_id`（不带则 `100045 附件不存在`）。
  落地形态：`attachment add-snippet <ref> --comment-id <id> --title --format --content|--content-file`，
  `--format` 是 22 个值的闭集，写进 `--help`。
- `--content-file` 需要读一个**纯文本**文件。`core/jsonInput.ts`（非禁改）因此长出
  `readTextFile(path, flag)`，`readJsonFile` 改为调它 —— 复用而非新增第二个 stdin/文件读取器，
  `cli/` 依旧不 import `node:fs`。

### D5.6 帮助快照控制（不做这件事，跨对象一项就会新增约 40 个快照）

`addCrosscutting` 每次挂载产出**逐字节相同**的 help（同样的 flag、同样的描述，只有命令路径不同）。
所以：

- 对**一个**挂载点做一次 `toMatchSnapshot()`；
- 其余挂载点做**结构化断言**：`helpInformation()` 在把命令路径归一化后等于参考值。

于是 N 个挂载点只有 1 个快照文件条目。若照现有做法给每个挂载点各来一份快照，S0 一项就会新增约
40 个快照 —— 那些快照没有独立信息量，只有维护成本和冲突面。

---

## D6. 并行化的解冲突设计（这是任务树能并行的前提）

### D6.1 诊断：真正的串行化点不是 `program.ts`

`cli/program.ts` 只有 59 行，加一个组是加两行（一个 import、一个调用），rebase 冲突平凡。
**真正的串行化点是快照文件与 `test/help.test.ts` 里的两条穷举断言：**

- `help.test.ts:47-55` 断言组名数组恰等于 `['auth','product','project','testhub','settings']`；
- `help.test.ts:57-119` 断言**全部 55 条叶子路径的有序列表**；
- `help.test.ts:133-157` 断言「5 组 / 10 子组 / 55 叶子」三个数字；
- `test/__snapshots__/help.test.ts.snap`（17.6 KB）是**一个**文件，装着 root + 5 组 + 10 子组 +
  7 条命令的全部 help 快照。

这四处里，**任何两个并行子任务都必然冲突**，而且冲突发生在生成的快照文本里 —— 最难 review、最容易
用 `-u` 草率覆盖的那种冲突。这是必须在 F1 一次性解决的问题。

### D6.2 `src/cli/registry.ts`

```ts
export const GROUPS: readonly (readonly [string, (program: Command) => void])[] = [
  ['auth', registerAuthCommands],
  ['api', registerApiCommands],
  ['resolve', registerResolveCommands],
  ['product', registerProductCommands],
  ['project', registerProjectCommands],
  ['testhub', registerTesthubCommands],
  ['scm', registerScmCommands],
  ['build', registerBuildCommands],
  ['release', registerReleaseCommands],
  ['settings', registerSettingsCommands],
];
```

`program.ts` 迭代它。于是：

- 子任务加一个组 = 改**一行**共享代码（PRD A3 最后一条）；
- 「五个命令组」那条断言变成 `expect(names).toEqual(GROUPS.map(([name]) => name))` ——
  **自满足**，永不需要改。它仍然有价值：它证明注册表与实际注册的树一致（漏调 `register*` 会被抓）。

组顺序按 GUI 模块序 + 元命令靠前：`auth` / `api` / `resolve` 在前（它们是基础设施），业务组按
产品管理 → 项目管理 → 测试管理 → 源码 → 构建 → 部署 → 后台设置。

### D6.3 `test/help.test.ts` 拆分（vitest 的一文件一快照是关键机制）

```
test/help/root.test.ts       组顺序 + 组数量 + 全局 flag + 不绑定 -v + root help 快照
test/help/auth.test.ts       → test/help/__snapshots__/auth.test.ts.snap
test/help/api.test.ts        → …/api.test.ts.snap
test/help/product.test.ts    → …/product.test.ts.snap
test/help/project.test.ts    → …/project.test.ts.snap
test/help/testhub.test.ts    → …/testhub.test.ts.snap
test/help/scm.test.ts        → …/scm.test.ts.snap
test/help/build.test.ts      …
test/help/release.test.ts    …
test/help/settings.test.ts   …
test/help/skill.test.ts      SKILL.md 契约（R6 改造后的单向断言）
```

**vitest 每个测试文件对应一个快照文件**，所以每个模块子任务独占
`test/help/__snapshots__/<group>.test.ts.snap`，**结构上不可能冲突**。root 只保留组顺序与数量，
穷举叶子列表**下沉**到各组自己的文件（`project.test.ts` 断言 project 组的叶子列表，别的组不关它的事）。

保留在 root 的三条现有断言：全局 flag 在每个叶子上可用（`help.test.ts:159-172`，遍历实现，不含
硬编码列表）、不绑定 `-v`、组顺序 = `GROUPS`。这三条都不随叶子增长而变化。

### D6.4 SKILL.md 契约（PRD R6）

- **保留单向**：SKILL.md 里出现的每条 `pingcode …` 路径必须在 commander 树里可解析
  （现 `help.test.ts:389-418` 的实现直接搬走）。
- **取消反向穷举**（现 `help.test.ts:420-426`：每个叶子都必须在 SKILL.md 出现）。150 条叶子下这条
  等于强制一份 3000 行文档，且是每个子任务的必冲突合并点。
- 改为断言 SKILL.md 必须记录：鉴权门槛（凭据管理 + 各 scope）、`--json` / `--dry-run` 契约、
  九行退出码表、**测试中显式 allowlist 列出的各条精修流程**（allowlist 是一个短数组，加流程时
  显式加一行，是有意的动作而不是被 grep 逼出来的）、以及 `api` / `api list` / `api describe`
  逃生舱与 `resolve`。
- 模块散文拆到 `skills/pingcode/modules/<module>.md`（pjm / ship / testhub / scm / build+release /
  crosscutting / api），由 SKILL.md 引用。现有 SKILL.md 是 39.9 KB / 653 行，本身已接近上限；
  拆分后各模块子任务只改自己那个文件。`scripts/install-skill.ts` 已按目录拷贝
  （测试断言它包含 `'skills'` 与 `'SKILL.md'`），需确认它把 `modules/` 一并带上。

### D6.5 `types/api.ts` 与 `api/parse.ts` 必须在 F1 就拆分

现状：`src/types/api.ts` 773 行、`src/api/parse.ts` 897 行，两者都是「pjm + ship + testhub 全在
一个文件」。S1–S4 并行时，四个子任务都要在这两个文件里加类型和 parser —— **必然互撞**，而且撞在
文件中部，是最难自动合并的形态。

F1 拆成：

```
src/types/{common,pjm,ship,testhub,scm,crosscutting}.ts
src/types/api.ts            ← 全部再导出，现有 import 路径不变
src/api/parse/{common,pjm,ship,testhub,scm,crosscutting}.ts
src/api/parse.ts            ← 全部再导出（含 fetchPageOf/iterateOf/fetchSearchPageOf/
                               iterateSearchOf/listAllOf/compact 这些列表管道）
```

**理由必须写明：现在做便宜，以后做贵。** 现在拆是一次纯机械的移动 + 再导出，零行为变化，一个 commit
可 revert；等 S1–S4 各自往里加了几百行之后再拆，就要在四份并行修改之上做大范围移动，冲突面从
「一次」变成「四次乘以每次的规模」。

同理：`src/cli/commands/testhub.ts` **已经 1845 行**。S3 必须**同时**把它按资源拆成
`cli/commands/testhub/{index,libraries,cases,plans,runs,meta}.ts`，**不得推后**。理由同上，
且 S3 本身就要往里加 6–8 条叶子。

### D6.6 冲突面总结（并行派发的依据）

| 文件 | 谁会改 | 冲突风险 | 缓解 |
|---|---|---|---|
| `src/cli/registry.ts` | 每个加组的子任务 | 一行，平凡 | — |
| `test/help/<group>.test.ts` + 其快照 | 该组的子任务，独占 | 无 | 一文件一快照 |
| `test/help/root.test.ts` | 只在加/删组时 | 低 | 断言自满足 |
| `src/types/<module>.ts`、`src/api/parse/<module>.ts` | 该模块的子任务，独占 | 无 | F1 拆分 |
| `src/core/endpoints.ts` | 每个子任务追加一段 | 低（按模块分区追加，尾部插入） | 按模块加注释分区 |
| `src/core/wire.ts:ERROR_CODE_OVERRIDES` | 每个实机 smoke 后可能追加 | 低（追加行）；**但这是禁改文件的唯一例外，每次追加都要在 PR 里显式点出** | 每行带证据注释 |
| `skills/pingcode/modules/<module>.md` | 该模块子任务，独占 | 无 | F1 拆分 |
| `README.md` 精修覆盖表 | X1 收尾统一写 | 无 | 串行化到 X1 |

---

## D7. 每阶段的端点映射表

以下路径逐字取自 `research/open-api-surface-460.md`。**"命令"列是拟定形态**，实现子任务可在
`--help` 措辞上微调，但不得改变分组归属。

### D7.0 S0 · 跨阶段串联层（15）— [S§3.7]

全部 `both`（企业令牌可用），全部**文档未声明 scope**。

| Method | Path | 命令 | 理由 / 陷阱 |
|---|---|---|---|
| POST | `/v1/relations` | `<entity> relation add` | **本任务单点最高价值缺口**。F5 实机确认：**无任何 relation type 字段**，body 恰为 `principal_type`/`principal_id`/`target_type`/`target_id`；且**只跨种类**，`work_item→work_item` 被拒（见 D7.6） |
| GET | `/v1/relations?principal_type=&principal_id=&target_type=` | `<entity> relation list` | ~~`target_type` 是可选的过滤维度~~ **实机必填**（F5）：省略即 `100049`，且报错文字指向 `principal_type`。落成 `--target-type` **requiredOption** |
| GET | `/v1/relations/{relation_id}` | `<entity> relation get` | |
| DELETE | `/v1/relations/{relation_id}` | `<entity> relation delete --yes` | **不**需要 principal query，与 comment/attachment 的 DELETE 不同（D5.3）。F5 实机：关联是**镜像成对存储、两个不同 id**，删任一端两端同时消失 |
| POST | `/v1/comments` | `<entity> comment add` | 自动化回写说明（"CI #123 失败，已建缺陷 BUG-45"）的落点 |
| GET | `/v1/comments?principal_type=&principal_id=` | `<entity> comment list` | |
| GET | `/v1/comments/{comment_id}` | `<entity> comment get` | |
| DELETE | `/v1/comments/{comment_id}?principal_type=&principal_id=` | `<entity> comment delete --yes` | query 里**要**带 principal（`principal_id` 文档写可选，实机必填：否则 `'principal_id'或'review_id'不存在`）。F5 实机：**软删** —— 行仍在 list 里、`is_deleted=1`；`content` 是否被清空**按模块不同**（pjm 清空、ship 保留），所以只有 `is_deleted` 可靠，人类表格必须有 STATE 列 |
| POST | `/v1/attachments?principal_type=&principal_id=` | **不实现**（D5.5 裁定） | 单步 `multipart/form-data`，无预签名 → 必须改 `wire.ts`/`http.ts`（禁改）→ 出范围，未实现 |
| POST | `/v1/attachments` | `<entity> attachment add-snippet` | 代码片段走 `application/json`，现有管道**确实**能发（F5 实机通）。但 `comment_id` 文档写可选、**实机必填**，否则 `100039`；`format` 是 22 值闭集 |
| GET | `/v1/attachments?principal_type=&principal_id=` | `<entity> attachment list` | |
| GET | `/v1/attachments/{attachment_id}` | `<entity> attachment get` | |
| DELETE | `/v1/attachments/{attachment_id}?principal_type=&principal_id=` | `<entity> attachment delete --yes` | query 里要带 principal |
| GET | `/v1/activities?principal_type=&principal_id=` | `<entity> activity list` | 审计与追溯；也是**唯一**接近变更流的东西（[S§5]：无 webhook API，无全局变更流），但它是 per-object 的。**词表比另两族少一个 `page`**，且未知 `principal_type` 回 **HTTP 500** 而非 400 |
| GET | `/v1/activities/{activity_id}` | `<entity> activity get` | |

`principal_type` 取值来自 [S§3.4] 的词汇表：Pilot = 容器级对象（project/product/library/space），
Principal = 工作对象本身（work item / ticket / idea / case / page）。挂载点与**逐族实测词表**见 D5.2
—— 注意实际 token 是 `test_case` / `test_run`，不是 `case` / `run`，而测试计划**不是** principal。

**F5 落地口径**：15 条中实现 14 条，唯一未实现的是文件上传（D5.5），原因是禁改文件，不是范围缩减。

**不纳入**：`participants` × 4（关注人，PRD Out of scope）、`reviews` × 8（见 D5.4 例外条款）。

### D7.1 S1 · CICD 与源码管理（**纳入 44**，全家族 54，全部 **ENT only**）— [S§3.12]

> [S§3.12] 开头的警告值得重复：**§3.12 的每一个端点都是企业令牌 only**，它们是给 CI 系统用的
> 写回集成 API，不是给单用户用的。这 54 条构成 61 条 ENT-only 端点的主体，而 CLI 的
> `client_credentials` 拿到的正是企业令牌 —— **这一整段开箱可达，不需要 OAuth**（PRD 鉴权前提）。

命令组：`scm`（家族 36 / 纳入 31）、`build`（6 / 5）、`release`（12 / 8）—— 合计纳入 **44**。

**PUT 全部不纳入。** PRD 定稿把 D8.4 的通则升格为硬约束：10 个 `PUT` 一律 Out of scope，
仅通用层 `pingcode api PUT` 可达。本节因此从家族计数里扣掉 6 个 `PUT`（scm 5 + build 1），
release 的 2 个 `PUT` 与 2 个 `DELETE` 本就在主线之外。下表里 `PUT` 行一律标注
**不纳入（通用层）**，**D7 全表不得出现任何 `PUT` 作为精修命令**。

⚠️ **算 S1 时唯一的陷阱**：`scm` 六个"五动词"家族里，**代码分支没有 `PUT`** —— 它的第五个动词是
`DELETE`（[S§3.12.4]）。误以为分支也有 `PUT` 会把 S1 算成 43 而不是 44。

#### 托管平台 家族 5 / **纳入 4** · `read/write:devops:code` — [S§3.12.1]

| Method | Path | 命令 | 备注 |
|---|---|---|---|
| POST | `/v1/scm/products` | `scm platform create` | 注意 area 内的资源名是 `products`，与 ship 的产品毫无关系 —— 命令名用 `platform` 消除歧义 |
| GET | `/v1/scm/products` | `scm platform list` | |
| GET | `/v1/scm/products/{product_id}` | `scm platform get` | |
| PUT | `/v1/scm/products/{product_id}` | **不纳入（通用层）** | 全量替换，未传字段会被清空。D8.4 硬约束 |
| PATCH | `/v1/scm/products/{product_id}` | `scm platform update` | |

#### 托管平台用户 家族 5 / **纳入 4** — [S§3.12.2]

| Method | Path | 命令 |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/users` | `scm platform-user create` |
| GET | `/v1/scm/products/{product_id}/users` | `scm platform-user list` |
| GET | `/v1/scm/products/{product_id}/users/{user_id}` | `scm platform-user get` |
| PUT | `/v1/scm/products/{product_id}/users/{user_id}` | **不纳入（通用层）** |
| PATCH | `/v1/scm/products/{product_id}/users/{user_id}` | `scm platform-user update` |

> 这 5 条是把 git 作者身份映射到 PingCode 成员的地方。**commit 归属靠它**，所以它不是可选的
> 配置端点 —— 没有映射，写回的 commit 挂不到人。

#### 代码仓库 家族 5 / **纳入 4** — [S§3.12.3]

| Method | Path | 命令 |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/repositories` | `scm repo create` |
| GET | `/v1/scm/products/{product_id}/repositories` | `scm repo list` |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}` | `scm repo get` |
| PUT | `…/repositories/{repository_id}` | **不纳入（通用层）** |
| PATCH | `…/repositories/{repository_id}` | `scm repo update` |

#### 代码分支 家族 5 / **纳入 5**（本家族**无 `PUT`**）— [S§3.12.4]

| Method | Path | 命令 | 陷阱 |
|---|---|---|---|
| POST | `…/repositories/{repository_id}/branches` | `scm branch create` | |
| GET | `…/branches` | `scm branch list` | |
| GET | `…/branches/{branch_id}` | `scm branch get` | |
| PATCH | `…/branches/{branch_id}` | `scm branch update` | |
| DELETE | `…/branches/{branch_id}` | `scm branch delete --yes` | **49 个 DELETE 里最疼的两个之一**（另一个是 wiki 页面）。见 D9 |

#### 拉取请求 家族 5 / **纳入 4** — [S§3.12.5]

| Method | Path | 命令 |
|---|---|---|
| POST | `…/repositories/{repository_id}/pull_requests` | `scm pr create` |
| GET | `…/pull_requests` | `scm pr list` |
| GET | `…/pull_requests/{pull_request_id}` | `scm pr get` |
| PUT | `…/pull_requests/{pull_request_id}` | **不纳入（通用层）** |
| PATCH | `…/pull_requests/{pull_request_id}` | `scm pr update` |

#### 代码评审 家族 5 / **纳入 4** — [S§3.12.6]

| Method | Path | 命令 |
|---|---|---|
| POST | `…/pull_requests/{pull_request_id}/reviews` | `scm review create` |
| GET | `…/pull_requests/{pull_request_id}/reviews` | `scm review list` |
| GET | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | `scm review get` |
| PUT | `…/reviews/{review_id}` | **不纳入（通用层）** |
| PATCH | `…/reviews/{review_id}` | `scm review update` |

> 与通用层 `/v1/reviews`（8 条）**不是同一个东西**，见 D5.4。命令面上前者在
> `scm review`，后者若回收则另立。

#### 提交 3 + 提交引用 3 · **全部纳入 6** — [S§3.12.7]

| Method | Path | 命令 | 理由 / 陷阱 |
|---|---|---|---|
| POST | `/v1/scm/commits` | `scm commit create` | CI 写回 commit 事实的入口 |
| GET | `/v1/scm/commits` | `scm commit list` | |
| GET | `/v1/scm/commits/{commit_id_or_sha}` | `scm commit get` | **可按 SHA 直接取，CI 侧关键**：流水线手里只有 SHA，没有 PingCode 的内部 id。位置参数直接接受 SHA，不做形状校验（`metadata.ts` 的「ids pass through untouched」纪律） |
| POST | `…/repositories/{repository_id}/refs` | `scm ref create` | |
| GET | `…/refs` | `scm ref list` | |
| GET | `…/refs/{ref_id}` | `scm ref get` | |

#### 构建记录 家族 6 / **纳入 5** · `read/write:devops:build` — [S§3.12.8]

| Method | Path | 命令 | 备注 |
|---|---|---|---|
| POST | `/v1/build/builds` | `build create` | A1 里「写回构建」的那一跳 |
| GET | `/v1/build/builds` | `build list` | |
| GET | `/v1/build/builds/{build_id}` | `build get` | |
| PUT | `/v1/build/builds/{build_id}` | **不纳入（通用层）** | D8.4 硬约束 |
| PATCH | `/v1/build/builds/{build_id}` | `build update` | 流水线中途更新状态 |
| DELETE | `/v1/build/builds/{build_id}` | `build delete --yes` | 构建记录可重建，符合 PRD R3「仅在可恢复或可轻易重建时提供」 |

#### 环境 6 + 部署 6 · **纳入主线 8** · `read/write:devops:deploy` — [S§3.12.9-10]

| Method | Path | 命令 | 纳入 |
|---|---|---|---|
| POST / GET / GET / PATCH | `/v1/release/environments[/{env_id}]` | `release env create|list|get|update` | ✅ 主线 4 |
| POST / GET / GET / PATCH | `/v1/release/deploys[/{deploy_id}]` | `release deploy create|list|get|update` | ✅ 主线 4 |
| PUT | `/v1/release/environments/{env_id}`、`/v1/release/deploys/{deploy_id}` | **不纳入（通用层）** | ✖ D8.4 硬约束 |
| DELETE | `/v1/release/environments/{env_id}`、`/v1/release/deploys/{deploy_id}` | **暂不纳入** | ✖ 待实机字段契约（Open Question） |

> PRD S1 把 release 的**主线 8 / 12** 列为刚需：`env` 与 `deploy` 各 create/list/get/update。
> 余下 4 条（2 `PUT` + 2 `DELETE`）在 Out of scope：`PUT` 依 D8.4 永不进精修层，两个 `DELETE` 待
> 实机验证部署记录的字段契约后再决定是否回收（PRD Open Question）。

### D7.2 S2 · 项目规划补写（**纳入 30**）— [S§3.8]

pjm 家族**无任何 `PUT`**，故本节不受 D8.4 影响。

#### 迭代 — [S§3.8.5]，`read/write:pjm:sprint`

| Method | Path | 命令 | 理由 / 陷阱 |
|---|---|---|---|
| POST | `/v1/pjm/projects/{project_id}/sprints` | `project sprint create` | 当前只有列表（`project meta sprints`），规划迭代必须去网页点 |
| PATCH | `/v1/pjm/projects/{project_id}/sprints/{sprint_id}` | `project sprint update` | |
| GET | `/v1/pjm/projects/{project_id}/sprints/{sprint_id}` | `project sprint get` | **PRD 定稿已正式纳入 S2**（此前只在本表出现）。精修 `get` 需要它，与 [TH§2] 把 `GET /libraries/{id}` 补进来的理由相同；与**已覆盖**的 sprints 列表配对 |
| POST | `/v1/pjm/sprints/bulk` | `project sprint bulk` | ⚠️ **企业令牌 only 且文档未声明任何 scope**（[S§3.8.5]/[S§7]A），是 61 条 ENT-only 里唯二不属于 DevOps/CES 的。CLI 可达，但 `api describe` 必须如实显示 scope 未声明 |
| — | **无 sprint 自身的 DELETE** | — | ⚠️ [S§3.8.5] 明确。`sprint delete` 不存在，不要为它写命令，也不要在 SKILL.md 里暗示可删 |

#### 版本 / 发布 — [S§3.8.6]，`read/write:pjm:release`

| Method | Path | 命令 |
|---|---|---|
| POST | `/v1/pjm/projects/{project_id}/versions` | `project version create` |
| GET | `/v1/pjm/projects/{project_id}/versions` | `project version list` |
| GET | `/v1/pjm/projects/{project_id}/versions/{version_id}` | `project version get` |
| PATCH | `/v1/pjm/projects/{project_id}/versions/{version_id}` | `project version update` |
| DELETE | `/v1/pjm/projects/{project_id}/versions/{version_id}` | `project version delete --yes` |
| POST | `/v1/pjm/versions/bulk` | `project version bulk` |

⚠️ `POST /v1/pjm/versions/bulk` 与 `sprints/bulk` 同款：**ENT only 且无声明 scope**。
⚠️ 命名地雷（[S§6]）：**版本 = 发布**，在 `/v1/pjm/projects/{id}/versions`；它与 **wiki 页面版本**
（`/v1/wiki/pages/{id}/versions`）完全无关。而配置路径里的 `*_property_plans` / `*_state_plans`
的 "plan" 是**方案/模板**，与「测试计划」「需求排期」都不是一回事 —— 命令命名不得混淆这三个。

#### 工作项 — [S§3.8.3]，`read/write:pjm:workitem`

| Method | Path | 命令 | 理由 / 陷阱 |
|---|---|---|---|
| POST | `/v1/pjm/work_items/search` | `project work-item list` 增强 | 过滤 DSL（[S§4.3]）。当前只有扁平 query 参数。与 ship/testhub 的 search 同构，复用 `fetchSearchPageOf`/`iterateSearchOf` |
| PATCH | `/v1/pjm/work_items` | `project work-item bulk-update` | 挪 20 个工作项进迭代不必跑 20 次 |
| DELETE | `/v1/pjm/work_items/{work_item_id}` | `project work-item delete --yes` | **CLI 目前没有任何 DELETE 能力**，这是第一个精修 DELETE。工作项在回收站可恢复 → 符合 R3 |
| POST | `/v1/pjm/work_items/{work_item_id}/relations` | `project work-item link add` | 与通用 `/v1/relations` **并存的第二条路**；命令名区分开（`link` vs `relation`），并在 help 里说明差异 |
| GET | `…/{work_item_id}/relations` | `project work-item link list` | |
| GET | `…/{work_item_id}/relations/{relation_id}` | `project work-item link get` | |
| DELETE | `…/{work_item_id}/relations/{relation_id}` | `project work-item link delete --yes` | |
| POST | `…/{work_item_id}/tags` | `project work-item tag add` | |
| GET | `…/{work_item_id}/tags/{tag_id}` | `project work-item tag get` | ⚠️ **有 get-one 但没有 tags 列表**（[S§3.8.3]）。因此 `tag list` **不存在**；要看一个工作项的标签只能读工作项自身的 `tags[]` 字段。这个不对称必须写进 help，否则用户会一直找那条不存在的命令 |
| DELETE | `…/{work_item_id}/tags/{tag_id}` | `project work-item tag delete --yes` | |
| GET | `…/{work_item_id}/transition_histories` | `project work-item history list` | |
| GET | `…/{work_item_id}/transition_histories/{transition_history_id}` | `project work-item history get` | |
| GET | `/v1/pjm/work_item/tags` | `project meta tags` | **PRD 定稿已正式纳入 S2**。⚠️ **单数 `work_item` 段**，与复数 `work_items` 并存。它是 `--tag` 名字→ID 解析的**唯一**数据源 —— 上游有 `GET work_items/{id}/tags/{tag_id}` 但**没有**某工作项的 tags 列表（[S§3.8.3]），所以标签只能从这张词表枚举 |
| GET | `/v1/pjm/work_item/relation_types` | `project meta relation-types` | **仍然纳入，但理由已被 F5 实机改写**（见 D7.6）：它与通用层 `/v1/relations` **无关**（那条没有类型字段）。它是**同类工作项关联族 `POST /v1/pjm/work_items/{id}/relations` 的必要前置** —— 那个族的 `relation_type` 必填，而这是唯一的词表来源（实机 9 条，带 `category` 列；`relation_type` 很可能吃 `category`，S2b 须实机确认，id 逐租户不同不得硬编码）。⚠️ 单数 `work_item` 段 |

#### 项目写与进度 — [S§3.8.1]，`read/write:pjm:project`

| Method | Path | 命令 | 陷阱 |
|---|---|---|---|
| POST | `/v1/pjm/projects` | `project create` | |
| PATCH | `/v1/pjm/projects/{project_id}` | `project update` | |
| GET | `/v1/pjm/projects/{project_id}/progress` | `project progress` | |
| POST | `/v1/pjm/projects/{project_id}/members` | `project member add` | |
| GET | `/v1/pjm/projects/{project_id}/members` | `project member list` | 也是 `--assignee` 候选集 |
| GET | `/v1/pjm/projects/{project_id}/members/{member_id}` | `project member get` | |
| — | **无 `DELETE /v1/pjm/projects/{id}`** | — | ⚠️ [S§3.8.1] 明确：项目**不能**通过 API 删除。`project delete` 不存在。通用层同样会以 exit 2 拒绝（D3.2 第二行） |

> [S§3.8.1] 里另有 `PATCH` / `DELETE /projects/{id}/members/{member_id}`、`POST …/clone`、
> `POST …/local_config/enable`、`GET /v1/pjm/project/states?project_id=` 等；PRD S2 只把
> `members × 3` 列为刚需，其余留通用层。**成员移除**（`DELETE …/members/{member_id}`）建议在实现时
> 与用户确认是否纳入 —— 它是可轻易重建的（重新 add），符合 R3。

### D7.3 S3 · 测试补齐（**纳入 13**）— [S§3.10]

testhub 的 1 个 `PUT`（`/runs/{run_id}`）不纳入，见下表最后一行。

| Method | Path | 命令 | 理由 / 陷阱 |
|---|---|---|---|
| POST | `/v1/testhub/cases/bulk` | `testhub cases bulk-create` | **测试落地头号刚需**。批量上限沿用 [TH§7] 的客户端 ≤50 保守限制 |
| PATCH | `/v1/testhub/cases/bulk` | `testhub cases bulk-update` | |
| DELETE | `/v1/testhub/cases/{case_id}` | `testhub cases delete --yes` | 确认信息必须回显解析后的用例标题（R3） |
| POST | `/v1/testhub/runs` | `testhub runs create` | 当前只有 plan 内 bulk 与单条 patch |
| GET | `/v1/testhub/runs` | **不纳入（通用层）** | ⚠️ `endpoints.ts:140` 已论证过：简单列表没有 library 过滤，`runs/search` 是唯一读路径。**PRD 定稿已把它从 S3 清单中删除**并转入 Out of scope —— 此前的 prd↔design 冲突已消解，无需再在子任务里逐个论证 |
| POST | `/v1/testhub/runs/bulk` | `testhub runs bulk-create` | |
| PATCH | `/v1/testhub/runs/bulk` | `testhub runs bulk-update` | [TH§7]：无声明上限，同样按 ≤50 保守限制 |
| GET | `/v1/testhub/runs/{run_id}/histories` | `testhub runs history list` | **测试报告目前出不来**，就缺这两条 |
| GET | `/v1/testhub/runs/{run_id}/histories/{history_id}` | `testhub runs history get` | 形状 = `executed_status` 对象 + `remark`（[TH§11]） |
| GET | `/v1/testhub/cases/{case_id}/histories` | `testhub cases history list` | ⚠️ **文档声明 `write:` scope，疑似文档 bug**（[S§3.10.2]）。实机确认后如实记录，冲突以实机为准（PRD R2）。形状与 run 侧**不同**：扁平 `status` 字符串、无 `remark`，**不得共用 deserializer**（[TH§11]） |
| PATCH | `/v1/testhub/libraries/{library_id}/plans/{plan_id}` | `testhub plans update` | |
| GET | `/v1/testhub/plan_states` | `testhub meta plan-states` | |
| GET | `/v1/testhub/plan_states/{state_id}` | （随 meta 一并可读） | |
| GET | `/v1/testhub/case/properties?library_id=` | `testhub meta case-properties` | ⚠️ **单数 `case` 段**。补齐 meta 最后一块；[TH§14.4] 记录了这个租户只有 8 个内建属性、无自定义属性，所以 `--set` 在此租户上基本不可实测 |
| PUT | `/v1/testhub/runs/{run_id}` | —（保持不实现） | 全量替换会清空 executor（[TH§7]，未被反证）。D8.4 的通则 |

**S3 必须同时完成 `cli/commands/testhub.ts`（1845 行）按资源拆分**，见 D6.5。

### D7.4 S4 · 产品需求补齐（**纳入 5**）— [S§3.9]

| Method | Path | 命令 | 陷阱 |
|---|---|---|---|
| GET | `/v1/ship/idea/plans?product_id=` | `product meta idea-plans` | ⚠️ **单数 `idea` 段**，与 `/v1/ship/ideas` 并存 —— 与 `endpoints.ts:46` 已记录的四个同款陷阱一致 |
| GET | `/v1/ship/products/{product_id}/plans` | `product plan list` | 「需求排期」。⚠️ 与「测试计划」、配置里的「方案 plan」三义同名（[S§6]），命令与 help 措辞必须消歧 |
| GET | `/v1/ship/products/{product_id}/plans/{plan_id}` | `product plan get` | |
| GET | `/v1/ship/ideas/{idea_id}/transition_histories` | `product idea history list` | |
| GET | `/v1/ship/ideas/{idea_id}/transition_histories/{transition_history_id}` | `product idea history get` | |

⚠️ **ship 里没有任何 DELETE**：无 idea DELETE、无 ticket DELETE（[S§3.9.2]/[S§3.9.4]）。
SKILL.md 现有断言 `nothing in ship can be deleted` 继续成立，不要因为本任务引入了 DELETE 能力
就去松动它。

### D7.5 全阶段共同的陷阱清单（实现时逐条对照）

1. **单数 area 段与复数资源并存**：`/v1/testhub/case/*`、`/v1/testhub/run/statuses`、
   `/v1/ship/idea/*`、`/v1/ship/ticket/*`、`/v1/pjm/work_item/*`、`/v1/pjm/project/states`
   —— 全部是"在这个容器里配置了什么"的视图，带 `?<parent>_id=`；复数的是资源本身。
   `endpoints.ts` 已为已知的几条写了注释，新增的照做。
2. **缺失的对称操作**（不要为它们写命令，也不要在文档里暗示）：无 `DELETE /v1/pjm/projects/{id}`、
   无 sprint 自身 DELETE、无 idea/ticket DELETE、有 `GET work_items/{id}/tags/{tag_id}` 但没有
   tags 列表、`work_item_priorities` 有 get-one 无 list（要用
   `/v1/pjm/work_item/priorities?project_id=`）、`directory` 的 users 与 groups 都无 DELETE。
3. **两条无声明 scope 的 bulk**：`POST /v1/pjm/sprints/bulk`、`POST /v1/pjm/versions/bulk`，
   ENT only。
4. **27 条通用层端点文档未声明任何 scope**（[S§1.4] 另有一处写作 33，见 D10 待验项 ①），需实机确认是否
   scope 豁免。
5. **HTTP 201 出现在 GET/DELETE 的文档里**（[S§4.2]）—— 已由 `wire.ts` 的「任何 2xx 即成功」覆盖，
   不要新写状态码比对。
6. **时间恒为 10 位 unix 秒**，`between` 是**天**粒度（[S§4.6]）。`--start/--end` 的
   本地 00:00:00 / 23:59:59 非对称规则由 `parseDateBoundaryFlag` 承担，不要另写一份。
7. **套餐/购买门槛完全未文档化**（[S§7]）：没买 testhub 的租户几乎肯定调不通 `/v1/testhub/*`。
   这是运行时错误类，不可从文档预测 —— 遇到就如实报错，不要试图预判。

### D7.6 曾经以为的跨阶段顺序依赖：S0 的 relations 写入 ↔ S2 的 `relation_types`

**本节已由 F5 实机推翻并重写（2026-08-03）。原结论保留在下方"作废的假设"里，因为它解释了
PRD 为什么把 `relation_types` 写成 S2 的必要前置。**

#### 实机事实

`POST /v1/relations` 的 body 恰好是四个字段，**没有任何 relation type**：

```
principal_type · principal_id · target_type · target_id      （四个全必填）
```

一次完整的 create → get → delete 在真实租户上跑通，没有任何一步需要类型 id。所以是原文的
**分叉 2**：`/v1/relations` **没有**自己的关联类型词表，也不复用 pjm 的那张表 —— 它压根不需要
类型。**S0 ↔ S2 的顺序依赖因此解除。**

原因是这两个 `relations` 是**两套完全不同的东西**，只是同名：

| | `/v1/relations`（通用层，S0/F5） | `/v1/pjm/work_items/{id}/relations`（S2） |
|---|---|---|
| 语义 | **跨种类**链接，无类型 | **同类**工作项链接，**有类型** |
| body | `principal_type/id` + `target_type/id` | `target_work_item_id` + `relation_type` |
| `work_item → work_item` | **被拒**（`100049`） | 这正是它的全部用途 |
| 类型词表 | 不存在 | `GET /v1/pjm/work_item/relation_types`（实机 9 条） |

`/v1/relations` 的 `(principal_type, target_type)` 实机矩阵（厂商**未声明**任何
`allowedValues`，所以这是唯一的事实来源；逐对探测，两端都用真实 id）：

| from ↓ / to → | `work_item` | `idea` | `ticket` | `test_case` | `test_run` | `page` |
|---|---|---|---|---|---|---|
| `work_item` | **✗** | ✅ | ✅ | ✅ | ✗ | ✅ |
| `idea` | ✅ | ✅ | ✅ | ✅ | ✗ | ✅ |
| `ticket` | ✅ | ✅ | ✅ | **✗** | ✗ | ✅ |
| `test_case` | ✅ | ✅ | **✗** | ✗ | ✗ | ✅ |
| `test_run` | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `page` | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |

三点值得记住：矩阵**不对称**（`test_run→work_item` 通，反向不通）；**同类基本不通**
（`idea→idea` / `ticket→ticket` 是例外）；被拒时报错一律是 `100049 不支持的'principal_type'`，
**即使错的是 target_type 或干脆没给 target_type** —— 命令层因此自己补一句解释。

**还有一层矩阵表达不了的过滤：工作项的 `type`。** 从 `test_case` 建链接，target 只接受
**需求 story / 缺陷 bug**；从 `test_run` 只接受 **缺陷 bug**；epic / feature / task 一律
`100107 不支持的工作项类型` —— 而**同一条链接从工作项那一侧建则任何类型都通**。这是逐租户
工作项类型方案相关的事实，CLI 不做本地拦截（拦截要多花一次读目标的请求，去拒绝服务端反正会拒绝
的调用），只在被拒时提示"改从工作项侧建"。`100107` 与 `100049` 同理**不进
`ERROR_CODE_OVERRIDES`**：它们是被拒的参数，不是缺失的行，exit 7 正确。

矩阵是**建议性的**：只喂 `--help` 与被拒后的提示，**不做本地拒绝**（D3.5：不新增 API 没有的
失败模式；别的租户/套餐可能接受更多对）。

#### 对下游的影响

- **F5 不依赖 S2，S2 也不再是 relations 写入的前置。** `relation_types` 与 `/v1/relations`
  无关。
- **S2b 的纳入理由改写**：`GET /v1/pjm/work_item/relation_types` 仍然纳入，理由从"通用 relations
  写入的必要前置"改为"**pjm 同类工作项关联族 `POST /v1/pjm/work_items/{id}/relations` 的必要前置**"
  —— 那个族的 `relation_type` 字段必填，而它是唯一的词表来源。PRD S2 一节已同步改写。
  **端点条数与三集合平衡完全不动**（53 + 107 + 299 = 459，S2 仍为 30）：改的是理由，不是清单。
- **F5 交给 S2b 的对账表**（实机 `GET /v1/pjm/work_item/relation_types`，9 条，全部
  `is_system=1`，注意有 `category` 这一列，`relation_type` 字段很可能吃的是 `category` 而不是
  `id`，S2b 必须实机确认）：

  | `category` | 名称 |
  |---|---|
  | `blocked_by` | 被阻塞 |
  | `block` | 阻塞 |
  | `caused_by` | 结果 |
  | `cause` | 原因 |
  | `duplicate` | 重复 |
  | `relate` | 关联 |
  | `cloned_by` | 副本 |
  | `clone` | 拷贝 |
  | `mention` | 提及 |

  （id 是 24-hex，**逐租户不同**，所以这里只记 `category` / 名称；S2b 的 resolver 应按
  `category` 或名称解析，不要把任何 id 写进源码。）
- **A1 / X3 的闭环链路**：需求↔工作项↔用例 的追溯用通用层 `/v1/relations` 就能建，
  **不必等 S2**；只有"工作项↔工作项 的带类型链接"要等 S2b。X3 排在 S2 之后的理由从
  "否则建不了关联"降级为"否则闭环里少了同类工作项链接这一跳"。

#### 作废的假设（原 D7.6 正文，保留以便追溯）

> **事实**：`POST /v1/relations` 需要一个 relation type id（PRD 定稿裁定），而枚举 relation type
> 的端点 `GET /v1/pjm/work_item/relation_types` 由 **S2 交付**。……**它不构成阻塞，理由是 Reach
> 层先于 Ergonomics 层落地**（D1）。

这个"事实"来自 PRD 定稿的推断，而 research §3.7 从未给出 `POST /v1/relations` 的字段表 —— 原文
自己把它列为"待 F5 实机确认的分叉"。F5 确认了分叉 2，所以整节改写。**教训与 PRD R2 一致：
文档没写字段表的端点，任何关于它 body 的断言都只是假设，必须实机落地。**

**Trellis 表达方式**（不变）：这条顺序**不靠父子树位置表达**，而是写进受影响 child 的 artifact。
现在写进去的内容是"不存在这条依赖"，以及上面那张对账表。

---

## D8. 破坏性操作与令牌类型（PRD R3 / R4 的机制化）

### D8.1 `--yes` 门

- 通用层：`pingcode api DELETE …` 无 `--yes` → exit 2，消息给出完整将要发送的 URL。
- 精修层：每个 `delete` 叶子都要 `--yes`。**确认信息回显解析后的名称**，不只是 ID：
  `deleting work item SCR-42 "登录接口超时" — pass --yes to confirm`。这需要在删除前做一次
  GET，成本一个请求，换掉「删错对象」这个不可逆错误。
- 本任务的精修 DELETE 集合（约 10 个）：`project work-item delete`、`project version delete`、
  `project work-item link delete`、`project work-item tag delete`、`testhub cases delete`、
  `scm branch delete`、`build delete`、`release env delete`、`release deploy delete`、
  以及 S0 的 `relation|comment|attachment delete`。

### D8.2 禁止与 `--all` 组合

`--all` 是分页遍历标志，只属于 list。DELETE 命令**不注册** `addPagingOptions`，因此
`--yes --all` 会被 commander 直接拒为未知选项。**另加一条测试**断言没有任何 delete 叶子带
`--all`，避免将来有人为了「批量删除」把它加回来。批量删除若真有需求，走服务端的 bulk 端点，
不由 CLI 循环发 DELETE（那会撞 200 req/min 限流且没有原子性，[TH§14.5] 已经演示过 bulk 的
非原子行为）。

### D8.3 `--dry-run` 是安全探针

`http.ts:58-65` 已保证：写动词在 dry-run 下抛 `DryRunHalt`，请求**从不发出**，而**读动词照常执行**
—— 所以 dry-run 的 `create` 能真的解析名字、拼出真实请求给你看。这个语义对通用层与精修层一致，
是 A1「`--dry-run` 变体不产生任何写入，且打印出完整请求计划」的实现基础。
`--json` 下 dry-run 输出 `{"dry_run": true, "request": {…}}` 到 stdout（`output.ts:printDryRun`）。

### D8.4 PUT 一律不进精修层（**已由 PRD 采纳为硬约束**）

**这一条已从"设计通则"升格为 PRD 定稿的硬约束。** 原先它只是本文档的一个建议，导致 PRD 把 scm 的
5 个 `PUT` 计入 In scope 却又不允许它们有精修命令 —— 那是给 child 制造一份无法履行的义务。
现在两边一致：**全部 10 个 `PUT` 一律 Out of scope，仅通用层 `pingcode api PUT` 可达。**

10 个 PUT（[S§0] 的直方图，与 area 分布完全对上）：

| 归属 | 条数 | 端点 |
|---|---|---|
| scm | 5 | platform / platform-user / repo / PR / review 各 1 |
| build | 1 | `PUT /v1/build/builds/{build_id}` |
| release | 2 | `PUT /v1/release/environments/{env_id}`、`PUT /v1/release/deploys/{deploy_id}` |
| wiki | 1 | `PUT /v1/wiki/pages/{page_id}/content` |
| testhub | 1 | `PUT /v1/testhub/runs/{run_id}` |

**理由：PUT 是全量替换，未传字段会被清空，而本 API 从不文档化"清空"的后果。** [TH§7] 记录过
`PUT /runs/{id}` 会清掉 executor，而它的 PATCH 兄弟不会 —— 一个模块实测出来的破坏性，没有任何理由
假设别的模块不会重演。

**后果（三条，都要落地）**：

1. In scope 的家族计数一律**扣除 PUT**：S1 因此是 44 而不是 50（scm 5 + build 1）。
   ⚠️ 扣减时注意 **scm 代码分支没有 `PUT`**（第五个动词是 `DELETE`，[S§3.12.4]）——
   误判会得 43。
2. **D7 全表不得出现任何 `PUT` 作为精修命令**；每个 `PUT` 行标注「不纳入（通用层）」。
3. `api describe` 对每个 `PUT` 打一行警告：「PUT 是全量替换，未传字段可能被清空；除非你确实要
   替换整个对象，请用 PATCH」。

唯一在语义上"本该是 PUT"的是 `PUT /v1/wiki/pages/{id}/content`（替换页面正文就是它的语义），
但 wiki 整体不在本任务范围内（PRD 依 `README.md:8-10` 排除），所以这个例外不需要开口子。

### D8.5 令牌类型前置拒绝（R4）

catalog 的 `tokenType` 让这件事在**任何网络 IO 之前**发生：

- `USER`（7 条：`/v1/myself`、`/v1/permission/my/*` × 3、`/v1/permission/check/*` × 3）→ exit 2，
  消息说明本 CLI 只有企业令牌、OAuth 授权码流程是另一个任务。**注意 `GET /v1/permission/points`
  是双令牌可用的**，不在这 7 条里（[S§7]B）。
- `ENT`（61 条）→ 放行，因为 `client_credentials` 拿到的就是企业令牌。
- `pingcode api list --token ENT` 枚举那 61 条（A3 第三条）：DevOps 54 + Nexus/CES 5 +
  两条 `*/bulk`。这个枚举本身就是一份「哪些能力只有机器身份能做」的清单，对 CI 集成有独立价值。

---

## D9. 风险与回滚

| # | 风险 | 表现 | 对策 |
|---|---|---|---|
| 1 | **帮助快照抖动** | 两个并行子任务同时改 `help.test.ts.snap`，冲突在生成文本里，容易被 `-u` 草率覆盖 | **F1 完成前不得启动任何模块子任务**（硬门禁，见 implement.md 的依赖图）。F1 后一文件一快照，结构上无冲突 |
| 2 | **`api_data.js` 漂移与遗漏** | catalog 说某端点存在/不存在，实机相反 | **catalog 与实机冲突时实机胜**（PRD R2）。冲突必须落进 `.trellis/spec/` 或 `endpoints.ts` 注释，并在 `core/catalog/index.ts` 的手写 override 表里修正 —— 绝不改生成文件 |
| 3 | **49 个 DELETE 的危险面** | 最疼的两个：`DELETE /v1/wiki/pages/{page_id}`（文档不可恢复，wiki 不在本任务但通用层可达）与 `DELETE …/branches/{branch_id}` | 通用层 DELETE 强制 `--yes`；`api list --method DELETE` 让危险面可枚举、可审计；SKILL.md 显式点名这两条 |
| 4 | **`ERROR_CODE_OVERRIDES` 退化为猜测清单** | 有人凭 400 就加一行 | PRD R5：每新增一行引用一次 smoke 观测；每条"考虑过但不加"写明理由。`wire.ts:203-227` 已是这个风格的范本（`100719`/`100702`/`100649`/`100619` 都写了为什么不加），照抄 |
| 5 | **F3 之后「反正已经可达了」成为永不精修的借口** | S1–S4 无限推迟，CLI 停在 55 条叶子 + 一个逃生舱 | README 维护**按模块的精修覆盖表**（PRD A4 最后一条），把「pjm 精修 24/145、scm 精修 0/36」这种数字摊在门面上。数字在文档里，欠债就不会隐形 |
| 6 | **tsc 时间退化** | `npm run typecheck` 变慢，CI 三个 Node 版本各慢一次 | D2.6：普通对象、不深 `as const`、F2 前后量墙钟时间、超线则退化为 JSON 资产 |
| 7 | **7 条端点鉴权不可达** | 仅 7 条 USER-only 永远不可达（`myself` 1 + `permission/my|check` 6）；另有 [S§7] 所述套餐门槛导致的运行时不可达 | 前置拒绝 + 消息说明（D8.5）。**注意 61 条 ENT-only 是可达的**，不要把它算进不可达 —— PRD 的鉴权前提正是本任务最重要的正面结论 |
| 8 | **F4 行为不等价** | 既有 1677 行 metadata 测试有一条需要改 | 那就是 F4 失败。回退方式见 implement.md 的回滚点：F4 是一个独立 commit，`git revert` 即回到旧 `metadata.ts`，其他子任务不依赖它的内部形状（只依赖不变的 import 路径） |
| 9 | **catalog 的 `paged` 启发式误判** | 某列表端点被判成 `paged: false`，`--all` 不可用 | D2.3：判定结果落盘快照 + 人工过一遍 + 手写 override 表。误判是可修的配置问题，不是可修的生成器问题 |
| 10 | **附件上传需要碰禁改文件** | `multipart/form-data` 走不通现有 `sendRequest` | D5.5：S0 实现前先实机验证，需要改 `wire.ts` 就**停下上报**（PRD R1） |

### 回滚形状

- 每个 child 是一个独立可 revert 的提交边界，每个 commit 落地时 `typecheck` + `test` 全绿
  （沿用 [TH] implement.md 的 ground rule）。
- **catalog 生成物与手写代码分开提交**：`catalog.generated.ts` + `.gitattributes` 一个 commit，
  `core/catalog/index.ts` + 测试另一个。于是「回滚生成物」与「回滚加载逻辑」互不牵连，
  且生成物那个 commit 的 diff 噪音被 `-diff` 隔离。
- F4 的回退见风险 8。F1 的拆分（types / parse / help 测试）如需回退，是一次纯文件移动的反向操作，
  由于全部走再导出，回退不影响任何调用点。

---

## D10. 已裁决的口径备忘 + 仍未解决的待验项

**本节不是争议清单。** 下表的 8 条曾是 research 内部或 prd↔research 之间的算术不一致，现已**全部
由用户逐条裁决并落进定稿的 `prd.md`**。保留在这里只为让后续 child 知道某个数字为什么是现在这个值、
不要"顺手改回去"。**不得把下表任何一行当成仍可讨论的问题。**

| # | 项 | 旧值 | 新值（定稿） | 裁决依据 |
|---|---|---|---|---|
| 1 | 端点总数 | 460 | **459** + 1 个非 API 授权页（单列排除） | `authorize` 非 `/v1`、非 JSON、是浏览器重定向页 → 剔除。两个直方图因此天然自洽（见 D2.8）。**上一轮「459+1=460」的折中口径作废** |
| 2 | S1 条数 | 约 30（标题）/ 50（清单） | **44** | bullet 清单为权威 + 全部 `PUT` 移出（scm 5 + build 1）。⚠️ scm 代码分支无 `PUT` → 44 而非 43 |
| 3 | S2 条数 | 约 20（标题）/ 27（清单） | **30** | 清单为权威 + 回收 3 条刚需前置读取（`sprints/{id}`、`work_item/tags`、`work_item/relation_types`） |
| 4 | S4 条数 | 约 4 | **5** | `idea/plans` 1 + `products/{id}/plans` 2 + `transition_histories` 2 |
| 5 | In scope 总数 | 约 84 | **107** | 15 + 44 + 30 + 13 + 5 |
| 6 | Out of scope 总数 | 约 145（枚举实为 ≈181–187） | **299** | 补集穷尽 + 补进遗漏家族（wiki 19、auth 3、sections/categories/stages/deliverables 等）+ permission 去重 |
| 7 | 两处模块计数 | ship 工单配置 28 · testhub 用例配置 15 | **30** · **16** | 采信 [S§3.9.5] / [S§3.10.3] |
| 8 | 已覆盖 | 52（手工估计） | **53** | 按 `(method, path)` 逐条建账：pjm 10 + directory 1 + ship 22 + testhub 20。差的 1 条是 `GET /v1/testhub/case_important_levels`（`endpoints.ts:114`），它属 [S§3.10.3]「用例配置」家族而非「用例」家族 |

配平结论（PRD `## Scope` 末尾的自证算式，本文档不得与它冲突）：

```
已覆盖 53  +  In scope 107  +  Out of scope 299  =  459  ✅
闭环总量 = 53 + 107 = 160
```

逐模块三栏（covered / in / out），任一 child 改动纳入范围时必须同步维护：

| 模块 | covered | in | out | = research |
|---|---|---|---|---|
| pjm | 10 | 30 | 105 | 145 |
| ship | 22 | 5 | 74 | 101 |
| testhub | 20 | 13 | 32 | 65 |
| 通用（跨对象） | 0 | 15 | 12 | 27 |
| devops（scm+build+release） | 0 | 44 | 10 | 54 |
| wiki | 0 | 0 | 19 | 19 |
| directory | 1 | 0 | 22 | 23 |
| permission / auth / myself / security / 工时 / nexus | 0 | 0 | 7+3+1+2+7+5 = 25 | 25 |

### 仍未解决的待验项（只有这三条）

① **通用层是 27 还是 33。** [S§3.7] 标题写 27 并列出 27 行（attachments 5 + comments 4 +
participants 4 + relations 4 + activities 2 + reviews 8 = 27），而 [S§1.4] 写
「33 endpoints … declare a token type but no scope at all」。**定稿取 27**（有逐行枚举支撑），
差额 6 条来源不明。F2 同步 `api_data.js` 时与「这些端点是否真的 scope 豁免」一并确认。

② **tokenType 直方图差 3 的假设。** 388 + 61 + 7 = 456，比 459 少 3。**假设**差的 3 条是
`/v1/auth/token` 的三种 grant（不需任何令牌）。若 F2 发现某条业务端点也落在三类之外，
`tokenType` 需要第四种取值（建议 `NONE`），并回写 D2.3 与 PRD。

③ ~~**已覆盖 53 待实测回填。**~~ **已关闭（X1，2026-08-05）：实测 N = 53，与假设一致。**
F2 的 `ENDPOINTS ⊆ catalog` 测试保证了每条精修路径都有 catalog 条目；X1 在此之上按
`(method, path)` 建账，并把同一份脚本跑在 `cf8335f~1`（本任务第一个 commit 之前）上复算，
得 pjm 10 + directory 1 + ship 22 + testhub 20 = **53**，四项分解逐一命中。
因此 PRD 的配平算式无需按 `459 − N − 107` 调整，只需记下 In scope 实际落地 **105 / 107**
（少的 2 条各有理由，见 PRD 配平节的回填框），落地后的实际三集合是 **53 + 105 + 301**。
逐模块实测值与命令见 `research/x1-doc-measurements.md`，README 的覆盖表发布的就是它。

---

## D11. S1a live findings (scm 平台 / 平台用户 / 仓库) — 2026-08-03

**本节是实机记录，不是提议。** 全部经 `node dist/bin/pingcode.js`（少数只观察 CLI 故意不暴露的
东西时走 `pingcode api` 原始请求）对公有云真实租户跑出。凡与
`research/open-api-surface-460.md` 或 catalog 冲突处，**实机胜**（PRD R2），并已同步写进
`core/endpoints.ts` 的 scm 分区注释。

### D11.1 前提被推翻：本租户**已经有** scm 数据

implement.md S1a 与父任务「前置准备」都假定「本租户几乎肯定没有托管平台/仓库」。实测相反：
已有 **2 个托管平台**（`Github`、`GitHub Enterprise`，均 `type: github`）、**38 个仓库**、
**40 个托管平台用户** —— 是一套真实在用的 GitHub 集成。

**因此 S1b/S1c 不应把写操作打到那套真实数据上**（在真实仓库上造假分支会污染 PingCode 里的
真实视图，而 scm 三个家族**都没有 DELETE**，造错了删不掉）。S1a 另建了一个隔离的
`[CLI smoke] pingcode-cli` 平台承载全部写测试，S1b/S1c 应继续用它。id 见 D11.6。

### D11.2 `?name=` 是精确匹配，不是搜索；仓库的 `?name=` 直接被忽略

- `GET /v1/scm/products?name=github` → 命中 `Github`（大小写不敏感）；`?name=git` → 0 行。
  所以它**不能当搜索用**，`scm-platform` 解析器改为整表加载 + 客户端匹配（平台数量是个位数，
  且失败时能列出真实候选）。
- `GET …/repositories?name=code-interpreter` → **返回全部 38 行**，参数被静默忽略；
  `?full_name=steins-tech/code-interpreter` → 精确命中 1 行。故 `scm repo list` 只提供
  `--full-name`，不提供 `--name`（一个静默失效的过滤器比没有过滤器更坏）。
- 分页三字段（`page_index`/`page_size`/`total`）在平台、用户、仓库三个列表上都如实回显，
  页与页不重叠，`--all` 正常走完。`core/paginate.ts` 的回显不一致保护在 scm 上不会触发。

### D11.3 托管平台用户**不是**成员映射，`owner_name` 是 upsert

D7.1 的措辞「这 5 条是把 git 作者身份映射到 PingCode 成员的地方」只对了一半，容易误导后续 child：

- 资源本体是 `{id, url, product, name, display_name, html_url, avatar_url}`，**没有任何
  PingCode 成员引用** —— 没有 `user`、没有 `user_id`、没有 `email`（读写皆无）。
- 用 `pingcode api POST …/users --set name=… --set user_id=<32位成员id> --set email=…` 探测：
  返回 200，**两个未文档化字段被静默丢弃**（回读确认未存储）。顺带得到一条通用结论：
  **这个 API 对未知 body 字段是静默忽略，而不是报错**，所以字段名拼错不会失败，只会没生效。
- 归属实际上靠**名字字符串**：commit 的 `committer_name`、分支的 `sender_name`
  （[S§3.12.7]）与这些行的 `name` 对应。
- 更强的证据：仓库的 `owner_name` 是 **upsert** —— `--owner-name no-such-git-user` 返回 200，
  当场**新建**了一个同名托管平台用户并把 `owner` 指向它。**一个拼写错误会凭空造出一个删不掉的
  幽灵身份。** S1b 写 commit 时的 `committer_name` 极可能同样是 upsert，需在 S1b 里实测确认，
  并据此决定是否在 `scm commit create` 前做一次身份存在性提示。

**对 S1b/S1c 的结论**：先用 `scm platform-user create` 把 git 用户名建好，再写 commit/分支，
这样 `display_name` / 头像 / 主页才有地方挂；而 CLI 不能、也不该声称能把 commit「指派给某个人」。

### D11.4 错误码：3 条进 `ERROR_CODE_OVERRIDES`，2 条明确不进

| code | 观测 | HTTP | 处置 |
|---|---|---|---|
| `100200` | `GET`/`PATCH /v1/scm/products/{未知24位}`，以及子列表路径里平台不存在时 | 400 | → `not_found`（exit 5） |
| `100202` | `GET`/`PATCH …/repositories/{未知}` | 400 | → `not_found`（exit 5） |
| `100209` | `GET`/`PATCH …/users/{未知}` | 400 | → `not_found`（exit 5） |
| `100002` | 路径段不是 ObjectId（`/v1/scm/products/notanid`），`资源路径错误` | **404** | **不加**：状态码优先分支已经给出 exit 5 |
| `100003` | `'type'不是有效的字符串(不是有效的枚举值)` | 400 | **不加**：是入参校验，不是「不存在」 |
| `100220` | `'product'已经存在`（平台名重复） | 400 | **不加**：唯一性冲突，不是「不存在」 |

前三条与 ship 的 `100725`/`100711`、testhub 的 `100601`/`100603` 同形：**每个资源一个稳定的
「这条记录不在」码，且 GET 与 PATCH 一致**，这正是当初给那几行发通行证的判据。注意
`100200` 里的 `'product'` 指**托管平台**，与 ship 的产品无关。

### D11.5 D8.4 的三个 `PUT` 与「没有 DELETE」

`PUT /v1/scm/products/{id}`、`…/users/{id}`、`…/repositories/{id}` 均**未**生成精修叶子
（`test/help/scm.test.ts` 有断言，`test/scm.test.ts` 另断言 `api/scm.ts` 里不存在
`replace*`/`put*` 包装器，同时断言 catalog 仍收录这三条 —— 排除动词是 UX 决策，不是能力删除）。
`modules/scm.md` 指明兜底写法 `pingcode api PUT /v1/scm/products/<id>`。

**三个家族都没有 DELETE**（与 ship 同形）：本 child 因此不含任何 `delete` 叶子，
也不存在 `--yes` 门；smoke 数据只能标记，不能清除。

### D11.6 S1b/S1c 可直接使用的实机数据

隔离的 smoke 平台（全部经 CLI 创建，均带 `cli-smoke` / `[CLI smoke]` 标识）：

| 对象 | id | 说明 |
|---|---|---|
| 托管平台 `[CLI smoke] pingcode-cli` | `6a7052e9919cce9794f005f1` | `type: other` |
| 仓库 `cli-smoke/pingcode-cli-unofficial` | `6a70532d919cce9794f00607` | `owner: cli-smoke-bot`，带 `{branch}`/`{sha}` 模板 |
| 仓库 `cli-smoke-fork/pingcode-cli-unofficial` | `6a705358919cce9794f00616` | 同名不同 `full_name`，用于验证歧义报错 |
| 平台用户 `cli-smoke-bot` | `6a7052f839cbed1cf7125f78` | S1b 写 commit 时可直接用作 `committer_name` |
| 平台用户 `cli-smoke-mapping-probe` | `6a70530e919cce9794f00600` | D11.3 的探测残留 |
| 平台用户 `cli-smoke-autocreated-owner` | `6a705344919cce9794f00614` | 由未知 `owner_name` 自动创建（D11.3 的证据） |

真实 GitHub 集成的 id 也在此备查（**只读用**，不要往里写）：
`Github` = `68393e8b47512a5d5d4e5b55`，`GitHub Enterprise` = `685c6c3c2974f854bb4979ab`。

### D11.7 一处沿用的既有小瑕疵

`core/metadata/resolve.ts` 的歧义消息是 `"x" matches N ${label}s`，对 `test library` /
`repository` 这类 label 会拼出 `test librarys` / `repositorys`。engine 的措辞是 F4 的共享代码，
不在本 child 的写作用域，故未改；`scm-repo` 的 label 取 `repo`（与命令名 `scm repo` 一致，
顺带正确复数化）。真要修的是 engine 的复数化，连带它的既有测试一起。

---

## D12. S1b live findings (scm 分支 / 提交 / 提交引用) — 2026-08-03

**本节是实机记录，不是提议。** 全部经 `node dist/bin/pingcode.js`（探测阶段走 `pingcode api`
原始请求，因为被测的正是命令层还不存在的东西）对公有云真实租户跑出，写操作**全部**落在 S1a
建立的隔离 smoke 平台 `6a7052e9919cce9794f005f1` 上。凡与 catalog 或 §3.12 冲突处，**实机胜**
（PRD R2），并已同步写进 `core/endpoints.ts` 的 scm 分区注释。

### D12.1 `sender_name` 是 upsert，`committer_name` **不是** —— 本 child 的前提被部分推翻

D11.3 给 S1b 留了一条待确认项：「`committer_name` 打错很可能同样是 upsert，凭空造出一个无法
删除的幽灵身份」。**实测：分支的 `sender_name` 是，提交的 `committer_name` 不是。**

| 探测 | 结果 |
|---|---|
| `POST …/branches` with `sender_name: cli-smoke-ghost-branch`（不存在的用户名） | 200，**当场新建**托管平台用户 `6a7063e9919cce9794f00ecb`，`sender` 指向它 |
| `POST /v1/scm/commits` with `committer_name: cli-smoke-ghost-commit`（不存在的用户名） | 200，**没有**新建任何身份 —— 探测前后平台用户数 3 → 4，新增的那一个是分支造的 |

原因是结构性的、而不是巧合：**`POST /v1/scm/commits` 的路径里没有 `product_id`**（提交是
组织级资源，见 D12.6），所以它根本没有一个"平台"可以在里面创建身份。相应地，提交资源上的
`committer_name` 是一个**扁平字符串**，不是引用对象 —— 与分支的 `sender`（一个 ref）形成
对照，两者必须用不同的类型和不同的 parser。

**对文档与代码的后果**：`scm branch create --sender` 才是那个会制造永久垃圾的入口，
`scm commit create --committer` 不是。`modules/scm.md` 与两条命令的 `--help` 按此措辞，
**不要**把警告平摊到两边 —— 在 `commit create` 上写一句不成立的警告，和漏掉 `branch create`
上成立的那句，是同一种错误。

### D12.2 `sha` 是**唯一被服务端做形状校验**的标识符

scm 全域的 id 都不校验形状，`sha` 是例外：

- `sha: "cli5m0ke…ghost001"`（40 位但含非 hex）→ 400 `100003`
  `'sha'不是有效的字符串(不是SHA格式)`。
- `GET /v1/scm/commits/<完整 40 位 hex>` → 200（**A2/AC1 要求的按 SHA 取通，已验证**）。
- `GET /v1/scm/commits/<24 位 id>` → 200，同一条记录。
- `GET /v1/scm/commits/0eb1f2c1`（缩写 SHA，8 位）→ **404 `100002` `资源路径错误`**。
  **缩写 SHA 不被支持**，尽管每个 git 用户都习惯用它。

这**不构成**在 CLI 里加形状校验的理由（`quality-guidelines.md` 明令禁止，AC1 也点名禁止）：
位置参数原样透传，服务端拒绝什么由服务端说。它构成的是一条**文档义务** —— `--help` 与
`modules/scm.md` 必须写明「完整 40 位 SHA 或 id，不接受缩写」，否则用户会以为 CLI 坏了。

### D12.3 `is_default` 在 POST 与 PATCH 上语义不同，且有跨行副作用

| 调用 | `is_default: true` | `is_default: false` |
|---|---|---|
| `POST …/branches` | 接受 | **接受**（实测新建分支 `is_default: false`） |
| `PATCH …/branches/{id}` | 接受 | **拒绝** 400 `100005` `'is_default'不是有效的布尔值(值不为true)` |

所以 PATCH 上它不是一个布尔字段，而是一个**动作**：「把这条设为默认」。文档
（`该值只能是true`）在这一点上是对的，而且是服务端强制的。

**命令面的后果，与 `scm repo --private true|false` 故意不同**：`scm branch update --default`
是一个**裸开关**，没有 `--default false`。repo 那边用三态值标志是因为「仓库转为公开」是一个
真实的更新；这里「取消默认」这个操作在 API 上**不存在**，给一个只能传 `true` 的字段配一个
`true|false` 标志，就是造一个必然被服务端拒绝的用法。`create` 侧同理只提供 `--default`：
不传即 `false`，与服务端默认一致，无需三态。

**副作用**：把 probe-2 设为默认后，原默认分支 probe-1 的 `is_default` **自动变成 false**。
一次 PATCH 改了两行。`--help` 与文档必须写出来。

另外，仓库里**第一个**被创建的分支会自动成为默认分支（文档如此，实测确认：空仓库里建的
probe-1 直接是 `is_default: true`，尽管请求里没有这个字段）。

### D12.4 `work_item_identifiers`：**未知编号被静默丢弃**，200 掩盖部分失败

这是本 child 发现的最需要防护的一条。

| 请求 | 响应 |
|---|---|
| `work_item_identifiers: ["NOSUCH-99999"]` | 200，`work_items: []` |
| `work_item_identifiers: ["YYHC-10", "NOSUCH-99999"]` | 200，`work_items: ["YYHC-10"]` |
| `work_item_identifiers: [""]` | 400 `'work_item_identifiers[0]'不是有效的字符串(值不能为空)` |

即：数组的**形状**被校验，元素的**存在性**不被校验。一个把分支/提交关联到工作项的 agent，
拿到 200 之后**无法从退出码判断关联是否发生**。提交侧同形（`["YYHC-10","NOSUCH-9"]` →
`work_items: ["YYHC-10"]`）。

**因此 CLI 在 `branch create|update` 与 `commit create` 上比较"请求的编号数"与"返回的
`work_items` 条数"，少了就在 stderr 上 `warn` 并列出没有落地的编号。** 这不是猜测服务端语义 ——
响应体自己就带着答案，只是没人去看。退出码保持 0：服务端确实成功了，部分关联失败是一个警告而
不是失败，而且 `--json` 的 stdout 里 `work_items` 就是证据。

`PATCH work_item_identifiers` 是**全量替换**（传 `["YYHC-9"]`（不存在）→ 清空；传 `[]` → 清空；
传 `["YYHC-10"]` → 只有它），与模块通则「数组替换不合并」一致。

### D12.5 分支 DELETE 比 D9 估计的更疼：默认分支删不掉，而删掉的分支会**留下 500**

两条实机事实，都影响 `--yes` 门的措辞：

1. **默认分支不能删** → 400 `100223` `默认分支不能被删除`。由于空仓库里第一个分支自动成为默认，
   一个只有一个分支的仓库里那个分支是**删不掉的**，除不先建第二个分支并把它设为默认。
2. **删分支不会清理它的提交引用，而残留引用会打坏引用列表**：删掉带有一条 ref 的 probe-1 之后，
   `GET …/refs?meta_type=branch&meta_id=<已删分支>` 返回 **HTTP 500 `100000 内部服务错误`**；
   而那条 ref 本身**按 id 仍然读得到**，`meta` 里还指着已经不存在的分支名。
   **提交引用家族没有 DELETE**，所以这个悬空记录是永久的。

第 2 条是 design D9「49 个 DELETE 里最疼的两个之一」的具体内容，而且比原先设想的更严重：疼的
不只是"分支没了"，而是**删除会在租户里留下一个无法修复的 500**。`--yes` 门的 consequence
文案据此写实，而不是套用通用的「没有 undo」。

### D12.6 提交是**组织级**资源，是 scm 里唯一不需要 `--platform` 的家族

`POST /v1/scm/commits`、`GET /v1/scm/commits`、`GET /v1/scm/commits/{commit_id_or_sha}`
三条路径里**都没有** `product_id` / `repository_id`。实测 `GET /v1/scm/commits` 在本租户返回
`total: 3725`（真实 GitHub 集成的历史提交），即它是一个跨平台、跨仓库的全组织列表。

**命令面的后果**：`scm commit list|get|create` **不接受 `--platform`**，而 scm 其余每一个叶子
都要求它。这个不对称是 API 的，不是 CLI 的，必须在 `--help` 与 `modules/scm.md` 里写明，否则
用户会以为漏了一个标志。一个直接的副作用：`scm commit list` 不带过滤器就是一次全组织扫描，
所以 `--sha` / `--work-item` 两个过滤器在文档里按"实际上应该总是带一个"来推荐。

提交引用则相反：**它是平台+仓库双重限定的**，而且 `GET …/refs` 的 `meta_type` 与 `meta_id`
**都是必填查询参数**（catalog 已收录为 `required: true`，实测不带即被通用层的 catalog 校验挡在
发请求之前）。`meta_type` 的取值只有 `branch`（`commit` → 400 `100003` 枚举错）。所以
「列出一个仓库的所有引用」这个操作**在 API 上不存在**，只能按分支逐个列 —— 文档要写清楚。

### D12.7 分页与 `?name=`

- 分支列表：`page_index` / `page_size` / `total` 如实回显，页与页不重叠，越界页返回空
  `values` 并回显所请求的页号（`page_size=1` 下 page 0/1/5 → probe-1 / probe-2 / 空）。
  `core/paginate.ts` 的回显不一致保护在这里同样不会触发。
- **分支的 `?name=` 是精确、大小写不敏感的过滤器，而且真的生效** —— 与平台的 `?name=` 同形，
  与仓库的 `?name=`（被静默忽略，D11.2）**不同形**。实测：`name=cli-smoke/probe-1` → 1 行，
  `name=CLI-SMOKE/PROBE-1` → 1 行，`name=probe`（子串）→ 0 行。
- 分支名**在一个仓库内唯一**（文档明说，实测重名 → 400 `100217 'branch'已经存在`）。

**这两条合起来决定了分支名解析不进 `metadata/registry.ts`**，理由三条，按重要性排列：

1. **表达不出来**：`ResolverSpec.path` 是 `string | ((parentId: string) => string)`，只有
   **一个** parent id 槽位；分支同时被 platform 与 repository 限定。要进表就得改 F4 的共享
   engine 签名，那不在本 child 的写作用域（implement.md 明令），也不该为一个 kind 去改。
2. **缓存在这里是错的**：分支列表是 scm 里唯一**每次 CI 推送都在变**的集合。24 h TTL 的
   name→id 缓存对它不是优化而是错误来源 —— 一个被删掉又重建的同名分支会拿到旧 id。
3. **不需要**：`?name=` 精确生效 + 名字仓库内唯一 ⇒ 一次 `GET …/branches?name=<input>` 就是
   完整答案，且**不存在歧义分支**（repo 需要客户端整表加载正是因为它有歧义）。

所以 `scm/branch.ts` 里自带一个 ~20 行的 `resolveBranchRef`：`?name=` 命中即用，命中 0 行则
把输入当 id 原样透传（不做形状校验），由服务端用 `100201` 诚实地报不存在。**`registry.ts`
与 `test/help/resolve.test.ts` 及其快照都不改** —— 这与 S1a 跳过 `scm-platform-user` 是同一条
判断（brief 的第四个协调点因此不触发）。

### D12.8 错误码：3 条进 `ERROR_CODE_OVERRIDES`，6 条明确不进

| code | 观测 | HTTP | 处置 |
|---|---|---|---|
| `100201` | `'branch'资源不存在` —— `GET`/`PATCH`/`DELETE …/branches/{未知24位}`，以及 `POST …/refs` 里 `meta_id` 不存在时 | 400 | → `not_found`（exit 5） |
| `100206` | `'commit'资源不存在` —— `GET /v1/scm/commits/{未知24位}` **与** `{未知40位SHA}`，以及 `POST …/refs` 里 `sha` 不存在时 | 400 | → `not_found`（exit 5） |
| `100207` | `'reference'资源不存在` —— `GET …/refs/{未知24位}` | 400 | → `not_found`（exit 5） |
| `100217` | `'branch'已经存在`（同仓库重名） | 400 | **不加**：唯一性冲突，不是「不存在」（与 D11.4 的 `100220` 同判） |
| `100214` | `'commit'已经存在`（重复 SHA） | 400 | **不加**：同上 |
| `100215` | `'ref'已经存在`（同 sha+分支重复建引用） | 400 | **不加**：同上 |
| `100005` | `'is_default'不是有效的布尔值(值不为true)` | 400 | **不加**：入参校验（D12.3） |
| `100223` | `默认分支不能被删除` | 400 | **不加**：这是一条**业务规则拒绝**，分支存在得很好。叫它 `not_found` 会把用户送去找一条他明明看得见的记录 —— 与 D11.4 拒绝 `100003` 同理。命令层改为附一句可执行的解释（先把别的分支设为默认） |
| `100000` | `内部服务错误` —— `GET …/refs?meta_id=<已删分支>`（D12.5），以及 `sha` 格式对但服务端出错时 | **500** | **不加**：真实服务端故障必须保留 500 → exit 7 |

前三条与 D11.4 的 `100200`/`100202`/`100209`、ship 的 `100725`/`100711`、testhub 的
`100601`/`100603` 完全同形：**每个资源一个稳定的「这条记录不在」码，且跨动词一致**。
`100201` 更强一些 —— 它在 `GET`、`PATCH`、`DELETE` **和** 一个 `POST` 的引用校验里都是同一个
码同一个含义，这正是当初给那几行发通行证的判据。

`100206` / `100201` 出现在 `POST …/refs` 上时映射为 exit 5 是**准确的**，不是巧合的副作用：
被指名的那条记录（commit 或 branch）确实不存在，而不是"创建失败"。

### D12.9 与 scm 无关的一条发现：**commander 静默丢弃多余位置参数，`--yes false` 会真的删除**

这条不是 scm 的问题，是**全 CLI 的问题**，在 S1b 做实机 smoke 时撞出来的，必须上报而不是就地扩大
修复范围。

**证据**（都在隔离 smoke 平台上跑出）：

```
scm branch delete cli-smoke/probe-2 … --yes false   → 分支被删除了
scm branch update <b> … --default false             → 按 --default（即 true）执行
scm platform get Github EXTRA                       → EXTRA 被静默忽略，正常返回
```

commander 默认 `allowExcessArguments(true)`，所以 `false` 被当成一个多余的位置参数丢掉，而裸开关
`--yes` / `--default` 被视为已给出。**对 `--default` 它使语义反转**（用户要求 false，得到 true）；
**对 `--yes` 它使确认门失效**（用户本想「不确认」，却执行了删除）。用户会去试 `--default false`
这种写法是有原因的：紧邻的 `scm repo` 就是 `--private true|false`。

**本 child 只做了最小修复**：给自己的三个持有危险裸开关的叶子加 `allowExcessArguments(false)`
（`branch create|update` 的 `--default`，`branch delete` 的 `--yes`），并在 `branch.ts` 里写明
理由与边界。`get`/`list` 上多余参数无害，没有一并收紧 —— 悄悄改掉整个组的解析严格度不是本 child
该做的决定。

**建议给编排者的独立提交**：在建树处（`src/cli/program.ts` / `registry.ts`）统一
`allowExcessArguments(false)`。它一次性关掉所有组的这个洞，包括 F5 的三个 crosscutting
`delete --yes` 与 `pingcode api DELETE --yes`（同样的洞，同样的后果），但**会改动每个组的测试与
可能的快照**，因此是一个跨 child 的协调动作，不能由 S1b 单方面做。

**已完成（`20a91e3 fix(cli): reject excess arguments so a bare --yes cannot be negated`）。**
上面这条建议由编排者在 S1c 之前作为一个独立提交执行，实际成本比预估低：

- **只改了 `src/cli/program.ts` 一行**（`buildProgram()` 链上加 `.allowExcessArguments(false)`），
  连同一段记录实机行为的注释。S1b 在 `branch.ts` 里的三处局部调用（`create`/`update`/`delete`
  —— 更正：`commit.ts` / `ref.ts` 从未有过）已全部移除。
- **help 快照零变动**（`test/help/**` 与 `package-lock.json` 的 diff 为空）——
  `allowExcessArguments` 不进入 help 文本，所以担心的"改动每个组的快照"没有发生。
- **既有测试零变红**：改完立即 1014/1014 绿，说明没有任何测试故意依赖静默丢弃。
- 覆盖面用执行证明而非推理：一次性探针枚举真实 `buildProgram()` 树，得 **183 个带 action 的
  叶子**（0 个 variadic，故多余参数在全部叶子上都非法），每个用 `arity+1` 个 positional 执行，
  注入的 fetch 一被碰就抛。修复后 **183/183** exit 2 且零 fetch。**负向对照**（注掉那一行）
  只有 **71/183** 被拒，而那 71 个仅仅是碰巧被 `requiredOption` 先拦住 ——
  **112 个叶子此前静默吞掉了多余参数**。
- `addCrosscutting` 动态注入的叶子正确继承，无需任何局部调用：`parent.command()` 在创建时就跑
  `copyInheritedSettings`，而父在那一刻已带该设置。这也确认了 D5 注入器不需要为 root 级设置
  做任何特殊处理。

**一处已知限制（有意接受）**：错误信息是 commander 原生的
`error: too many arguments for 'delete'. Expected 1 argument but got 2.`，**不回显冒犯的
token（`false`）**。commander 12 对这条消息无公开 hook，唯一杠杆是私有 `_excessArguments`
（monkey-patch 原型或遍历 228 个 command 覆盖下划线内部），跳版本脆弱。`showHelpAfterError()`
会紧跟着打出 `Usage: pingcode scm branch delete [options] <branch>`，用户可据此推断，
且保留原生消息使既有 `toContain('too many arguments')` 断言继续成立。

**顺带发现的一个缺陷类，值得单独跟进**：`test/apiCommand.test.ts`、
`test/resolveCommand.test.ts`、`test/testhubCommands.test.ts` 三个文件为隔离而**自己手搓
root program**（`new Command()` + `.name().configureHelp().showHelpAfterError().exitOverride()`），
不调 `buildProgram()`。而 root 设置恰恰是会向下传播的东西，所以这些 harness 测的是一棵 CLI
从不运行的树 —— `api DELETE /v1/comments/c1 --yes false` 在 `apiCommand.test.ts` 里**通过**
（进到 action 后才因缺必填字段失败），而真实二进制拒绝。三处已补上设置并写了注释，但**这是一个
类而不是三个个例：今后任何 root 级设置都会同样漂移**。建议的后续动作：导出一个共享的 root
factory，或加一条断言 harness 的设置集合等于 `buildProgram()` 的设置集合。

### D12.10 S1b 的实机残留（不可清除的部分已列明）

写操作全部落在 S1a 的隔离 smoke 平台 `6a7052e9919cce9794f005f1`，真实 GitHub 集成
（`68393e8b47512a5d5d4e5b55`、`685c6c3c2974f854bb4979ab`）**全程只读，未写入一个字节**。

已清除：S1b 创建的 6 个探测分支中的 4 个（`probe-1`、`probe-3-defaultfalse`、`probe-wi`、
`probe-wi-real`）与 e2e 分支 `cli-smoke/s1b-e2e`，均用 `scm branch delete --yes` 删除。

**不可清除的残留**，逐条与原因：

| 对象 | id | 为什么删不掉 |
|---|---|---|
| 分支 `cli-smoke/keeper`（主 smoke 仓库） | `6a706c3e919cce9794f01221` | 它是该仓库的**默认分支**，`100223` 拒绝删除；而它是仓库里唯一的分支，无法先把别的分支设为默认 |
| 分支 `cli-smoke/ghost-probe`（fork smoke 仓库） | `6a7063e9919cce9794f00ecc` | 同上 |
| 托管平台用户 `cli-smoke-ghost-branch` | `6a7063e9919cce9794f00ecb` | D12.1 的 upsert 证据，scm 全域无身份 DELETE |
| 提交 `0eb1f2c1…59b1`（ghost committer 探测） | `6a706428919cce9794f00ed3` | 提交家族无 DELETE |
| 提交 `e35cc1ed…6ae5`（e2e）与 `…commit-2` 探测提交 | `6a706a9a919cce9794f011a3` 等 | 同上 |
| 提交引用 ×2（其中一条已因分支被删而悬空，其 `ref list` 现在返回 500） | `6a7064f139cbed1cf7126997`、`6a706ac439cbed1cf7126c2d` | 引用家族无 DELETE |

全部带 `cli-smoke` / `[CLI smoke]` 前缀，可辨识。悬空引用那一条正是 D12.5 的活证据，留着也无害
（它只影响那个已不存在的分支 id 的引用列表）。

---

## D13. S1c live findings (scm 拉取请求 / 代码评审) — 2026-08-03

**本节现在是实机记录。** 初版写作时本环境凭据丢失，S1c 的代码全绿但一条实机验证都没跑成，
本节曾以「不是实机记录」开篇。**凭据已于 2026-08-03 恢复，D13.1 表列的七项已全部实测完毕**，
结果逐项回填在 D13.1；由此产生的代码改动见 D13.8。仍未实测的部分只剩两处，明确标注在 D13.1
表尾。凡与 catalog 冲突处，**实机胜**（PRD R2），并已同步写进 `core/endpoints.ts` 的 scm 分区注释。

### D13.1 七项待验项的实测结果

原表是"未被验证的东西，逐条列明"；现在每行带 ✅ 已验证 / ❌ 被推翻 与证据。全部经
`node dist/bin/pingcode.js` 对公有云真实租户跑出，少数只观察 CLI 故意不暴露或故意拦下的东西时
走仓外原始 fetch 探针（`status` 缺省的 PATCH 会被通用层的 catalog 校验挡在发请求之前，所以那一项
必须绕开 CLI 才测得到）。写操作全部落在 S1a 的隔离 smoke 平台 `6a7052e9919cce9794f005f1`。

| # | 待验项 | 结果 |
|---|---|---|
| 1 | `?number=` 是否真的过滤 | ✅ **真过滤，且精确**。两个 PR（9001/9002）下：无过滤 2 行；`--number 9001` → 1 行且正是它；`--number 9002` → 1 行；`--number 7777` → 0 行。与平台/分支的 `?name=` 同形，**不是**仓库 `?name=` 那种静默忽略。**`--number` 保留**，`pr get` 的 id 发现路径成立 |
| 2 | happy path 八条端点写入语义回读 | ✅ **全部回读证实**。`pr create/list/get/update` 与 `review create/list/get/update` 全跑通；PATCH 确认是**真部分更新**（只改 title 后 `comments_count=3`/`commits_count=2`/`work_items=[YYHC-10]` 全部存活）；review PATCH 确认**无必填字段**（只传 status+description，reviewer/submitted_at/html_url 全存活） |
| 3 | `creator_name`/`merged_by_name`/`reviewer_name` 是否 upsert | ❌ **三个全是 upsert**（前一轮"完全未知"）。一次调用传两个可区分的假名 → 平台用户 4→6，新增两行的 id 正是响应里 `author.id` 与 `merged_by.id`；随后 review 传第三个假名 → 6→7。**必须写幽灵身份警告**，已写入两条命令的 `--help` 与 `modules/scm.md` |
| 4 | PATCH 不传 `status` 是否真被拒 | ✅ **真被拒**：`400 100008 'status'是必填字段`。catalog 的 `required: true` 成立，**读-改-写保留**。这与 testhub `executor_id` 声明倒台的走向相反，所以那次额外 GET 不是浪费 |
| 5 | PR/review 的"资源不存在"码 | ✅ **两条，同形**：`100208 'pull request'资源不存在`（GET/PATCH/以及 `POST …/reviews` 父不存在时）、`100222 'review'资源不存在`（GET/PATCH，含真 review id 挂错 PR）。均 HTTP 400。**已入 `ERROR_CODE_OVERRIDES`**，修掉 D13.4 记录的不一致 |
| 6 | 分页三字段是否如实回显 | ✅ **两个列表都如实**。PR 列表 `page_size=1` 下 page 0/1/5 → 9001 / 9002 / 空，越界回显所请求页号；review 列表同形；两者 `--all` 都走完并返回 `{count, all: true}`。`paginate.ts` 的回显不一致保护在这里同样不触发 |
| 7 | `--status merged` 的条件必填是否服务端强制 | ✅ **强制**：不带三件套 → `400 100212 请提供'merged_at'，'merged_commit_sha'，'merged_by_name'值`。文档里"expect exit 7"那句是**对的**，无需改。且该拒绝不留残留 |

**表外新发现三条**（不在原七项里，但两条改了代码，见 D13.8）：

- ❌ **`source_branch_id` 在 `POST` 上是必填的** —— catalog 标 `required: false`，实机
  `400 100224 源分支是必填字段`，且 `status` 取 open / closed 都一样。另外
  `source == target` 被拒（`100211`）。**这推翻了 D13.2 里那条最得意的论据**（见 D13.2 更正）。
- ⚠️ **`GET …/pull_requests/{不存在}/reviews` 返回 HTTP 200 + 空列表**，而不是 `100208`。
  拉取请求是 scm 里**唯一一个**其缺失不被子列表报告的父级（平台缺失报 `100200`、仓库缺失报
  `100202`，均实测复核）。所以 `review list` 的空结果有两种含义，必须在文档里说明 —— 这是
  override 修不了的，因为服务端根本没报错。
- **未发送的 `*_count` 被服务端存成 `0`**，而未发送的 `merged_at` 保持缺失。所以
  `pullRequest.ts` 里"absent count is blank, never 0: the API does not report one it was
  not given"这句注释是错的，已改写为防御性说明。

**仍未实测的两处，明确列出**：① 五条 `PUT` 一条都没打过（有意：它们不在精修层，且全量替换会
清空未传字段，在没有 DELETE 的家族上不可逆）；② 403/scope 不足的路径（本 app 已授全部
devops scope，无法构造）。

**实机脚本**：本轮探针在 `/tmp/s1c-v2/`（仓外，不进版本库）。

### D13.2 端点与叶子：恰 8 条，两个 `PUT` 一个不收

| Method | Path | 叶子 |
|---|---|---|
| POST | `…/repositories/{repository_id}/pull_requests` | `scm pr create` |
| GET | `…/pull_requests` | `scm pr list` |
| GET | `…/pull_requests/{pull_request_id}` | `scm pr get` |
| PATCH | `…/pull_requests/{pull_request_id}` | `scm pr update` |
| PUT | `…/pull_requests/{pull_request_id}` | **不纳入（通用层）** |
| POST | `…/pull_requests/{pull_request_id}/reviews` | `scm review create` |
| GET | `…/pull_requests/{pull_request_id}/reviews` | `scm review list` |
| GET | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | `scm review get` |
| PATCH | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | `scm review update` |
| PUT | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | **不纳入（通用层）** |

**一处对 D7.1 的更正**：D7.1 把两个 review 的写路径缩写成 `…/reviews/{review_id}`，读起来像
一个仓库级资源。catalog 的实际路径是
`…/pull_requests/{pull_request_id}/reviews/{review_id}` —— **四个路径参数**，是全 CLI 最深的
路径。这不是笔误级的差别：它决定了 `scm review` 每个叶子都必须要 `--pr-id`。

**～～PR 的 `PUT` 是 D8.4 最好的论据，值得记下来～～ —— 这条被实机推翻，更正如下。**
原文写的是：「`POST` 里 `source_branch_id` 是**可选**，`PUT` 里它变成**必填**。也就是说全量替换
不仅会清空未传字段，还会拒绝一个 `POST` 本来接受的载荷。」

实机：**`POST` 也必填**（`400 100224 源分支是必填字段`，open/closed 两种 status 均如此），所以两个
动词在这个字段上其实**一致**，不存在那个不对称。catalog 的 `required: false` 是错的。

后果分两层，不要混为一谈：

- **D8.4 排除 `PUT` 的结论不变**，但支撑它的论据换成通用那条：**全量替换会清空你没传的字段**，
  而本 API 从不说明清空一个字段意味着什么，且这两个家族都没有 DELETE 可以纠错。
  失去的只是"最锋利的那个例子"，不是结论。
- **`--source-branch-id` 改为 `requiredOption`**（D13.8）。一个"可选"但省略必失败的标志，
  与一个静默失效的过滤器是同一类谎言 —— 这正是本轮据 D11.2 标准处置 `--number` 时用的判据，
  只是结论相反：`--number` 真过滤所以留下，`--source-branch-id` 真必填所以升为必填。

`modules/scm.md` 与 `test/help/scm.test.ts` 里引用那个不对称的措辞已一并改掉。

`test/scm.test.ts` 现在断言 scm 的 `PUT` **恰好 5 条**（不是"至少包含这几条"）：catalog 若因
上游变动被重新生成而多出第 6 条，这个 child 的配平数字就过期了，应该有测试来说这件事。

### D13.3 三个命令面决策及其理由

1. **`pr get|update` 与 `--pr-id` 收 id，不收 number。** scm 全域没有 `identifier`、没有
   `short_id`，详情路径只吃 24 位 id；`number` 只是列表过滤器。要让位置参数同时接受两者，就得
   在客户端判断"这串东西像不像数字" —— 那正是 `quality-guidelines.md` 明令禁止的 id 形状校验
   （而且 24 位十六进制**可以**全是数字）。所以 `pr list --number 42 --json` 是拿 id 的正路，
   `--help` 与 `modules/scm.md` 都这么写。与 S1a 的 `platform-user get <id>`、S1b 的
   `ref --branch-id` 是同一条判断。
2. **`--source-branch-id` / `--target-branch-id` 也收 id。** 分支名是可解析的
   （`resolveBranchRef` 在 `branch.ts` 里），但 S1b 已经为 `ref --branch-id` 做过这个权衡并写明
   理由：这个家族的调用者是流水线，手里已经有 `scm branch create` 返回的 id，为省一次粘贴而每次
   多发一个请求不值得。一致性优先于便利。
3. **`pr update` 缺 `--status` 时读-改-写。** catalog 标 `status` 在 PATCH 上必填，而"只改标题"
   是一个正当操作，于是命令层先 GET 一次、把**当前** status 原样回传。这是 testhub 的 run patch
   定下的契约（归档 design §7）：读-改-写发生在命令层，不是服务端的静默默认。传了 `--status`
   就不会有那次 GET —— 测试两个分支都断言了请求条数。**✅ 依赖的待验项 4 已实测成立**：
   不传 `status` 的 PATCH 被 `400 100008 'status'是必填字段` 拒绝，所以这次额外 GET 是必需的，
   不是浪费。实机同时确认 PATCH 是真部分更新（未提及的 counts 与 work-item 关联全部存活），
   所以回传 status 不会顺带清掉别的字段。

**没有为 PR 或 review 加 resolver kind**，理由与 S1b 拒绝 branch kind 相同且更强：
`ResolverSpec.path` 只有一个 parent 槽而 PR 需要两个（platform + repository）、review 需要三个；
PR 集合随 CI 变动，24 h 缓存是错误来源；而且没有名字可解析 —— PR 的"人类键"是 number，
review 连 number 都没有。因此 `metadata/registry.ts`、`test/help/resolve.test.ts` 及其快照
**一行未改**（brief 的第四个协调点不触发）。

### D13.4 错误码：初版一行未加是有意的；**本轮补上两行**

`ERROR_CODE_OVERRIDES` 的维护纪律写在 `.trellis/spec/backend/error-handling.md` 里：
**只为真正实机观测到的码加行，并在注释里引用记录该观测的 research 文件**。初版没有观测，
所以初版不加行 —— 这条判断本身是对的，保留在此作为记录。

**本轮有观测了，所以补上两行**（D13.1 第 5 项）：

| code | 观测 | HTTP | 处置 |
|---|---|---|---|
| `100208` | `'pull request'资源不存在` —— `GET`/`PATCH …/pull_requests/{未知24位}`，以及 `POST …/pull_requests/{未知}/reviews`（被路径*指名*的那条 PR 确实不在） | 400 | → `not_found`（exit 5） |
| `100222` | `'review'资源不存在` —— `GET`/`PATCH …/reviews/{未知24位}`，以及**一个真实 review id 挂在错的 PR 下**（它确实不在那个地址上，所以 exit 5 是精确的） | 400 | → `not_found`（exit 5） |

与 D11.4 的 `100200`/`100202`/`100209`、D12.8 的 `100201`/`100206`/`100207`、ship 的
`100725`/`100711`、testhub 的 `100601`/`100603` 完全同形：**每个资源一个稳定的「这条记录不在」
码，且跨动词一致**。这修掉了初版明知而有意保留的不一致 —— 此前一个不存在的 PR/review 退 7，
而一个不存在的分支退 5，同一种错误两个退出码。

**明确不加的四条**（同一轮观测）：

| code | 观测 | 为什么不加 |
|---|---|---|
| `100224` | `源分支是必填字段` | 缺必填字段，是入参校验，不是缺失。且 CLI 现在在发请求前就拦下了（D13.8） |
| `100008` | `'status'是必填字段` | 同上。注意它是**通用**的"缺必填字段"码（testhub 的 `'start_at'是必填字段` 也是 `100008`），映射它会污染全模块 |
| `100212` | `请提供'merged_at'，'merged_commit_sha'，'merged_by_name'值` | 条件必填的服务端强制，仍是入参校验 |
| `100211` | `源分支和目标分支不能相同` | **业务规则拒绝**：两个分支都存在得很好。与 D12.8 拒绝 `100223`（默认分支不能被删除）同判 |

另有一条**无法用 override 解决**的：`GET …/pull_requests/{未知}/reviews` 返回 **200 + 空列表**，
服务端根本没报错，所以没有码可映射。只能文档化（已写入 `scm/review.ts` 的 `--help` 与
`modules/scm.md`）。

### D13.5 一次有意的 root 快照变更（跨 child 收尾动作）

`test/help/__snapshots__/root.test.ts.snap` 里 scm 那行描述被改了，这是本 child 唯一动到共享
快照的地方，且是被要求的收尾动作：

```
- 源码管理 scm: hosting platforms, git identities, repositories (企业令牌 only, …)
+ 源码管理 scm: the DevOps write-back surface for code hosting data (企业令牌 only, …)
```

S1a 写这行时组里只有三个家族；S1b 加了三个家族后**改过又主动 revert**，为的是让两个并行 child
不同时碰这份共享快照 —— 代价是描述只点名了六个家族里的三个。既然 scm 到本 child 为止完整了，
正确的修法不是把六个家族都列进去（下一次加家族又要改），而是**不再枚举资源**：描述改为讲用途，
于是它对未来的增长保持正确。`scm --help` 与 `modules/scm.md` 仍然是准确的清单。
理由写在 `scm/index.ts` 的注释里，也写在 commit body 里。

### D13.6 顺手做的一次去重（不是 scope creep，是避免第三份拷贝）

`identifiersOf` / `oneLine` / `workItemIdentifiers` 原本在 `branch.ts` 与 `commit.ts`（以及
`ref.ts` 的 `oneLine`）各有一份私有拷贝。PR 三个都要用，照原样写就是**第三份**，而
`code-reuse-thinking-guide.md` 的门槛正是"同样的代码出现 3 次就抽出来"。

抽到哪里：**`scm/branch.ts`**，而不是 `cli/commands/common.ts`。后者是每个并行 child 都在改的
文件，S1a 为同样的理由把 `addPairOptions` 留在了 `scm/platform.ts` 而没有上提。`branch.ts`
已经是这个组事实上的共享模块（`addRepoOptions` / `requireRepoScope` / `warnUnlinkedWorkItems`
都在那儿，`commit.ts` 与 `ref.ts` 已经在从那儿 import），所以依赖方向没有变化，净效果是拷贝数
从 2–3 份降到 1 份。`_shared/crosscutting.ts` 里那份 `oneLine` 没动 —— 那是另一层，不在本
child 的写作用域。

### D13.7 本 child 留在租户里的永久对象

初版这里写的是「**目前为零** —— 因为 smoke 没跑成」。smoke 现已跑完，按 D12.10 的格式补上。

写操作全部落在 S1a 的隔离 smoke 平台 `6a7052e9919cce9794f005f1` 与仓库
`6a70532d919cce9794f00607`；真实 GitHub 集成（`68393e8b47512a5d5d4e5b55`、
`685c6c3c2974f854bb4979ab`）**全程只读，未写入一个字节**。

**已清除**：无。本轮唯一可删的对象是为 PR 造的源分支，而它被有意保留（见下）。

**不可清除的残留**，逐条与原因：

| 对象 | id | 为什么删不掉 |
|---|---|---|
| PR `#9001 [CLI smoke] pr-a retitled by RMW`（status `closed`） | `6a70b18b919cce9794f019d5` | 拉取请求家族无 DELETE。承载了 happy path、work-item 静默丢弃告警、读-改-写两个分支 |
| PR `#9002 [CLI smoke] pr-b ghost identity probe`（status `merged`） | `6a70b1d139cbed1cf71273f1` | 同上。D13.1 第 3 项的 upsert 证据（`author` 与 `merged_by` 都指向凭空造出的身份） |
| 代码评审 `approved`（reviewer 为幽灵身份） | `6a70b26d919cce9794f019e8` | 代码评审家族无 DELETE。`reviewer_name` upsert 的证据 |
| 代码评审 `comment`（原 `request_changes`，reviewer `cli-smoke-bot`） | `6a70b2ec919cce9794f019ec` | 同上。为 review 列表分页提供第二行，并验证 review PATCH 无必填字段 |
| 托管平台用户 `cli-smoke-pr-ghost-creator` | `6a70b1d139cbed1cf71273ef` | scm 全域无身份 DELETE。由 `creator_name` upsert 造出 |
| 托管平台用户 `cli-smoke-pr-ghost-merger` | `6a70b1d139cbed1cf71273f0` | 同上，由 `merged_by_name` upsert 造出 |
| 托管平台用户 `cli-smoke-review-ghost-reviewer` | `6a70b26d919cce9794f019e7` | 同上，由 `reviewer_name` upsert 造出 |
| 分支 `cli-smoke/s1c-source` | `6a70b17f39cbed1cf71273ee` | **技术上可删，有意不删**（见下） |

平台用户总数因此从 4 涨到 7 —— 这三行本身就是 D13.1 第 3 项的证据，删不掉也正是要警告的那件事。

**为什么保留那个源分支**：它是唯一可删的对象（非默认分支、无提交引用），但两个 PR 的
`source_branch` 都指着它。D12.5 已经证明删掉一个仍被引用的分支会在租户里留下**无法修复的
500**（那条悬空的提交引用至今还在）。分支删得掉，PR 删不掉 —— 这个不对称让实验只能朝坏的方向
不可逆，所以不做。保留一个带标记的分支，比制造一个可能打坏 `pr get` 的悬空引用便宜得多。

全部对象带 `[CLI smoke]` / `cli-smoke` 前缀，PR 编号用 9001/9002（≥9001 高位区），可辨识。
另有三次 PR 创建尝试被服务端拒绝（缺 `source_branch_id`、`source == target`、`merged` 缺三件套）
与三次 raw 探针拒绝，**均未产生任何残留** —— 拒绝就是没写入。

### D13.8 本轮实机导致的代码改动

只有三处，全部由实机观测驱动，无一处是"顺手改"：

1. **`src/core/wire.ts`：`ERROR_CODE_OVERRIDES` 加两行**（`100208`、`100222`），每行带日期 +
   打的路径 + 动词的观测注释，并写明四条明确不加的码及理由。这是 ground rules 里唯一授权的
   forbidden-file 例外。同步更新 `test/http.test.ts` 的表自钉断言，与
   `test/scm.test.ts` 的四条经包装器行为断言（GET/PATCH ×2 家族、review create 的父缺失、
   四条 exit 7 对照）。
2. **`src/cli/commands/scm/pullRequest.ts`：`--source-branch-id` 升为 `requiredOption`**，
   因为实机无条件必填（`100224`）。附带把 header 注释里被推翻的 POST/PUT 不对称改写、给
   `--creator`/`--merged-by` 加幽灵身份警告、修正 `countCell` 那条被实机否定的注释。
3. **`src/cli/commands/scm/review.ts`：`--reviewer` 加幽灵身份警告**，并在 `review list` 的
   描述与 header 注释里写明"未知 `--pr-id` 读作空列表而不是错误"。

**没有改**的三处，各有理由：`--number` 保留（真过滤）；读-改-写保留（`status` 真必填）；
`registry.ts` / `test/help/resolve.test.ts` 及其快照一行未改（D13.3 的结论不受本轮影响）。
`test/help/__snapshots__/root.test.ts.snap` **未再触碰**（D13.5 那次是唯一一次，且已完成）。

---

## D14. S1d live findings (build 构建记录 / release 环境·部署) — 2026-08-04

**本节是实机记录，不是提议。** 全部经 `node dist/bin/pingcode.js` 对公有云真实租户跑出；少数
只观察 CLI 故意不暴露的东西（被静默忽略的过滤器、命令层拒绝发送的字段、两个不纳入的 DELETE）
时走仓外原始 fetch 探针。凡与 catalog 或 §3.12.8-10 冲突处，**实机胜**（PRD R2），并已同步写进
`core/endpoints.ts` 的 build/release 分区注释。

写操作全部落在本 child 自己创建的对象上；**没有碰任何既有数据**（本租户在 S1d 之前 build /
environment / deploy 三张表全为空，见 D14.1）。

### D14.1 前提确认：这两个家族在本租户里是**空的**

brief 说「租户没有 release environment」，先按 D11.1 的教训核实了另一个方向 ——
`GET /v1/build/builds`、`/v1/release/environments`、`/v1/release/deploys` 三个列表**都返回
`total: 0`**。所以与 S1a 不同，本 child 不存在「往真实集成里写脏数据」的风险，也不需要隔离
沙箱；同时也意味着**环境是本 child 自己造的**，这是 `release deploy` 的前置数据。

### D14.2 catalog / 文档被推翻的四条

| # | 声明 | 出处 | 实机 |
|---|---|---|---|
| 1 | `GET /v1/release/environments` 的 `?name=` 是**必填**查询参数 | 上游 apiDoc「获取环境列表 → 查询参数 name」，catalog 照抄 `required: true` | ❌ **可选**。不带任何查询参数返回全部环境（200，4 行）。**这不是不便，是不可达**：`missingRequired` 在发请求前就拒，所以 `pingcode api GET /v1/release/environments` 退 2 而 API 本会回答 |
| 2 | `PATCH /v1/release/deploys/{id}` 的 `env_id` 可更新 | 上游 apiDoc 部分更新参数表 | ❌ **接受、回显、不落库**。见 D14.5，本轮最坏的一条 |
| 3 | `GET /v1/build/builds` 无过滤器（文档确实一个都没写） | 只是"没写"，通常意味着可能有未文档化的 | ✅ 确认**一个都没有**：`identifier` / `name` / `status` / `provider` / `work_item_id` 五个逐一探测，**全部被静默忽略**（每次都返回全部 4 行） |
| 4 | 构建记录的 `identifier` 是"编号" | 直觉上编号唯一 | ❌ **不唯一**。两条 `identifier: "9001"` 都建成功，所以它永远不能作为查找键 |

第 1 条的处置：`core/catalog/index.ts` 新增手写更正表 `OPTIONAL_QUERY_OVERRIDES`（D9 风险 2
明确指定的修法：**绝不改生成文件**），一行，带观测注释。这是本任务第一次用到「`required` 更正」
这个维度 —— `PAGED_OVERRIDES` 早已存在，但 `required` 判错的后果更重：`paged` 判错只是
`--all` 不可用，`required` 判错让端点在通用层**彻底不可达**。测试在
`test/release.test.ts`（含「不得有失效行」的自检，与 `PAGED_OVERRIDE_KEYS` 同形）。

第 3、4 条合起来决定了 `build list` 只有分页、`build get` 只收 id，并且**没有任何 metadata
resolver 行**：既没有可解析的名字，也没有能用来查的过滤器。

### D14.3 命令面：13 条端点、13 个叶子、两个新组

| 组 | 叶子 | 端点 |
|---|---|---|
| `build` | `list` `get` `create` `update` `delete` | `/v1/build/builds` ×2 路径，5 动词（PUT 排除） |
| `release env` | `list` `get` `create` `update` | `/v1/release/environments` ×2 路径 |
| `release deploy` | `list` `get` `create` `update` | `/v1/release/deploys` ×2 路径 |

配平：build 家族 6 扣 1 个 `PUT` = 5；release 家族 12 扣 2 个 `PUT` 扣 2 个 `DELETE` = 8。
**合计 13**，与 D7.1 一致，与 S1 的 44（31+5+8）一致。

三个命令面决策及理由：

1. **`build get` / `release deploy get` 只收 id。** 两者的"人类键"都不唯一（构建编号可重复，
   `release_name` 是自由文本），而 `build list` 连过滤器都没有 —— 客户端猜"这串东西像不像编号"
   正是 `quality-guidelines.md` 明令禁止的 id 形状校验。与 S1c 的 `pr get` 同一判断。
2. **`release env get|update` 收名字。** 这是本 child 唯一可按名字寻址的资源，理由见 D14.4。
3. **`--duration` 升为必填**（两个 create 都是）。API 无条件必填且**从不由 `start_at`/`end_at`
   推导**；一个"可选"但省略必失败的标志与一个静默失效的过滤器是同一类谎言（S1c 对
   `--source-branch-id` 的判据）。CLI 也不替用户算：流水线报的可能是 CPU 时间而不是墙钟。

### D14.4 唯一新增的 resolver 行：`release-env`（另外两个明确不加）

| kind | 加不加 | 理由 |
|---|---|---|
| `release-env` | ✅ **加** | ① 名字**组织内唯一**（重名 create 是 `100105`）；② `?name=` 是精确、大小写不敏感且**真生效**的过滤器；③ 它**无 parent**（组织级），所以 `ResolverSpec` 原样表达得下 —— 这正是 S1b/S1c 拒绝 branch/PR/review 的第一条理由（需要 2–3 个 parent 槽）在这里不成立；④ 缓存在这里是**对的**：环境是配置（一把手创建、极少改），不是每次 CI 都新增的记录；⑤ 真正的驱动力是 `release deploy create --env`：调用方是流水线，它知道自己发的是 "production"，手里没有 24 位 id |
| 构建记录 | ❌ 不加 | `identifier` 不唯一 + 列表无过滤器 ⇒ 没有可匹配的名字；而且构建记录**每次 CI 运行都新增**，24 h 缓存对它不是优化而是错误来源（S1b 拒绝 branch 的第 2 条理由，在这里更强） |
| 部署 | ❌ 不加 | 它**根本没有名字**：`release_name` 是自由文本且不唯一 |

代价与收益都记下来：这一行触发了 brief 的第四个协调点 —— `test/help/resolve.test.ts` 的两个
计数（29→30、27→28）与 `resolve.test.ts.snap` 的一行。收益是 `pingcode resolve release-env
<name>` 与 `--env <name>` 两条路径，以及失败时能列出真实候选（精确 `?name=` 做不到这件事：
它只会回 0 行）。

### D14.5 本轮最重要的一条：`env_id` 在 PATCH 上**回显但不落库**

`release deploy update --env` 原本实现了（"a deploy can be moved to another environment"），
在实机 smoke 的第 34/35 步被抓出来：

```
deploy update <id> --env cli-smoke-prod   → 200，响应里 environment.name = cli-smoke-prod
deploy get    <id>                        → environment.name = cli-smoke-e2e   ← 没变
```

随后用仓外原始 HTTP 复现两次（单发 `env_id`；`env_id` + `status` 同发）：**两次都是 200 +
响应回显新环境 + 回读仍是旧环境**，而同一请求里的 `status` 正常落库。

**这是静默失败里最坏的一种形状**：D14 之前每一条「未知字段被忽略」都能靠回读发现（lesson 1
就是这么写的），而这一条**连回读都骗人** —— 只要回读的是同一个响应体。抓到它的唯一原因是
smoke 里多跑了一次独立的 `get`。

**处置：`release deploy update` 不提供 `--env` / `--env-id`。** 一个「报告成功但什么也没改」
的写字段，与一个静默失效的过滤器是同一类谎言（D11.2 的标准），何况这里的回显还会主动挫败
谨慎调用者的回读习惯。因此 API 层 `UpdateDeployInput` 保留 `env_id`（那是端点文档的内容，
`pingcode api PATCH` 仍可发），精修层一个字都不发，`--help`、`modules/cicd.md` 与"做不到什么"
表格都写明「部署无法更换环境，请新建一条」。

**其余每一个 PATCH 字段都逐一回读确认过会落库**：build 的 `name`/`identifier`/`status`/
`result_overview`/`work_item_identifiers`，deploy 的 `status`/`release_name`/`duration`/
`release_url`/`work_item_identifiers`，environment 的 `name`/`html_url`。只有 `env_id` 例外。

### D14.6 时间窗只能"先改结束、再改开始"

`PATCH …/deploys/{id}` 里的新 `start_at` 是与**已存库的** `end_at` 比较，而不是与同一请求里的
`end_at` 比较：

```
update <id> --start-at 11:00 --end-at 11:04   → 400 100102 开始时间必须小于等于已存在的结束时间
update <id> --end-at 11:04 ; update <id> --start-at 11:00   → 两次都 200，落库正确
```

create 上的同类规则是另一个码：`100041 开始时间必须小于等于结束时间`。两条都是入参/业务校验 ⇒
留在 exit 7，但**必须文档化**，否则用户会以为 CLI 把两个标志弄丢了。`--start-at` 的 help 文案
直接写了 "moving the window forward needs --end-at FIRST, in its own call"。

顺带确认了另外两条服务端形状校验（D12.2 之后 `sha` 不再是唯一一个）：`env_id` 非 ObjectId 是
`100003`；`start_at` 为 `0` 或**毫秒**是 `100004 数值不是有效的时间戳`。CLI 仍然一个 id 形状
都不校验，只把日期串换算成 unix **秒**。

### D14.7 环境删除被引用时**被拒**——D12.5 的反例

```
DELETE /v1/release/environments/{id}  （尚有 deploy 指向它） → 400 100106 'environment'正在使用，不能被删除
删掉那些 deploy 之后再 DELETE                                → 200
```

**这与 scm 的分支/引用完全相反。** D12.5 记录的是：删掉分支不清理它的提交引用，之后
`ref list` 永久返回 500，且引用家族无 DELETE —— 一扇单向门。release 这边服务端自己维护引用
完整性，所以**这里没有任何东西可以被孤立**。D9 风险 3 的「49 个 DELETE 的危险面」因此拿到一个
正面反例，值得记下来：危险程度是**按家族**而不是按动词判断的。

也正因为这条，本 child 的清理是可行且安全的（D14.10）。

### D14.8 分页：两个新组的三个列表全部如实

| 列表 | 观测 |
|---|---|
| `GET /v1/build/builds` | `page_index`/`page_size`/`total` 如实回显；size 2 下 page 0/1 各 2 行且不重叠；page 9 回显 9 + 0 行；`--all --page-size 1` 走完 4 条 |
| `GET /v1/release/environments` | 同形（4 行时 page 0/1 各 2 行，page 9 空）；`?name=` 与分页可叠加 |
| `GET /v1/release/deploys` | 同形（size 1 下 page 0/1/5 → 两条各一行、空）；`--all` 返回 `{count, all: true}` |

`core/paginate.ts` 的「回显不一致就停」保护在这两个组上同样**不会触发**，与 D11.2 / D12.7 /
D13.1 第 6 项一致。四个 child 之后可以说：这个 API 的分页回显是可信的。

### D14.9 错误码：3 条进 `ERROR_CODE_OVERRIDES`，8 条明确不进

| code | 观测 | HTTP | 处置 |
|---|---|---|---|
| `100203` | `'build'资源不存在` —— `GET` / `PATCH` / **`DELETE`** `/v1/build/builds/{未知24位}`，以及删除成功后的下一次 `GET` | 400 | → `not_found`（exit 5） |
| `100204` | `'deploy'资源不存在` —— `GET`/`PATCH …/deploys/{未知}` | 400 | → `not_found`（exit 5） |
| `100205` | `'environment'资源不存在` —— `GET`/`PATCH …/environments/{未知}`，**以及 `POST /v1/release/deploys` 里 `env_id` 不存在时** | 400 | → `not_found`（exit 5） |
| `100105` | `'<name>'环境已经存在` | 400 | **不加**：唯一性冲突（与 `100220`/`100217`/`100214`/`100215` 同判） |
| `100106` | `'environment'正在使用，不能被删除` | 400 | **不加**：**业务规则拒绝**，环境存在得很好（与 `100223` 同判） |
| `100102` | `开始时间必须小于等于已存在的结束时间`（PATCH） | 400 | **不加**：跨字段校验 |
| `100041` | `开始时间必须小于等于结束时间`（POST） | 400 | **不加**：同上 |
| `100003` | `'env_id'…不是有效的id` / `'status'|'provider'…不是有效的枚举值` / `'html_url'…不是URL格式` | 400 | **不加**：入参校验 |
| `100004` | `'start_at'…数值不是有效的时间戳`（`0` 与毫秒） | 400 | **不加**：入参校验 |
| `100006` | `'work_item_identifiers[0]'…值不能为空` | 400 | **不加**：入参校验 |
| `100008` | `'start_at'是必填字段` | 400 | **不加**：**跨模块**的"缺必填字段"码（testhub 的 `'start_at'`、S1c 的 `'status'` 都是它），映射它会污染全模块 |
| `100002` | `资源路径错误`（路径段非 ObjectId） | **404** | **不加**：状态码优先分支已给出 exit 5 |

前三条与 D11.4 的 `100200`/`100202`/`100209`、D12.8 的 `100201`/`100206`/`100207`、D13.4 的
`100208`/`100222`、ship 的 `100725`/`100711`、testhub 的 `100601`/`100603` 完全同形。
`100205` 出现在 `POST …/deploys` 上映射为 exit 5 是**准确的**，与 `100201` 出现在
`POST …/refs` 上同理：被路径/载荷**指名**的那条记录确实不存在。

`100203` 值得单独一句：它是**本 API 里第一个在 `DELETE` 上被观测到的 not-found 码**（scm 的
`100201` 在 DELETE 上也出现过，但那是同一家族的四动词之一）。删除后 `GET` 退 5，是"硬删除"的
直接证据。

### D14.10 实机残留：**零**

**本 child 在租户里没有留下任何对象。** 这是 S1 系列的第一次，原因是结构性的而不是运气：
这三个家族里两个有可用的 `DELETE`（build 有精修叶子，deploy/environment 有通用层），而
D14.7 的引用完整性保证了删除顺序存在（deploy → environment）。

| 对象 | 数量 | 清理方式 |
|---|---|---|
| 构建记录（`cli-smoke unit-test/lint/delete-probe/s1d-e2e` + 一条重复编号探测） | 5 建 5 删 | `build delete --yes`（精修叶子），以及探测阶段的 raw DELETE |
| 部署（`cli-smoke 1.0.0`/`2.0.1` + 3 条探测） | 5 建 5 删 | `pingcode api DELETE /v1/release/deploys/<id> --yes` |
| 环境（`cli-smoke-staging`/`-prod`/`-canary`/`-e2e`/`-delete-probe`） | 5 建 5 删 | `pingcode api DELETE /v1/release/environments/<id> --yes`，删 deploy 之后 |

收尾核对：`build list` / `release deploy list` / `release env list` 三个 `total` 全部回到
**0**，与 D14.1 的初始状态逐字一致。被服务端拒绝的写（重名环境、坏枚举、坏时间戳、缺必填、
反向时间窗、引用中的环境删除）**均未产生任何残留** —— 拒绝就是没写入。

唯一"外部副作用"是工作项 `YYHC-10` 上曾短暂出现过构建/部署关联，随对象删除一并消失。

### D14.11 本轮实机导致的代码改动

1. **`src/cli/commands/release/deploy.ts`：`update` 去掉 `--env`/`--env-id`**（D14.5），
   连带去掉那条路径上的 `runWrite`（没有任何需要失效的缓存 id 了），并把
   `--start-at` 的 help 改成写明"先改结束"（D14.6）。
2. **`src/core/catalog/index.ts`：新增 `OPTIONAL_QUERY_OVERRIDES`**（D14.2 第 1 条），
   一行 + 观测注释 + 自检测试。生成文件未动。
3. **`src/core/wire.ts`：`ERROR_CODE_OVERRIDES` 加三行**（`100203`/`100204`/`100205`），
   每行带日期 + 路径 + 动词，并写明八条明确不加的码及理由（D14.9）。这是 ground rules 里
   唯一授权的 forbidden-file 例外。
4. **`src/core/metadata/registry.ts`：`release-env` 一行**（D14.4），连带
   `metadata/index.ts` 的 `resolveEnvironment` 与 `test/help/resolve.test.ts` 的两个计数。
5. **`src/cli/commands/_shared/workItems.ts`：新文件**，把 S1b/S1c 放在
   `scm/branch.ts` 的四个工作项链接助手搬过来（`branch.ts` 改为再导出，其四个 importer
   一行未改）。理由：build 与 deploy 携带**完全相同**的 `work_item_identifiers` /
   `work_items` 契约（实机确认，不是从 scm 推断），而 `build.ts` 从 `scm/branch.ts` import
   会暗示一种不存在的关系；`common.ts` 仍然不碰（D13.6 的理由未变）。

**没有改**的两处，各有理由：`build list` 不加任何过滤器（一个都不生效）；`release deploy
list --env-id` 未知 id 读作空列表这件事**无法用 override 修**（服务端根本没报错，与
D13.1 的 `pull_requests/{unknown}/reviews` 同类），只能文档化 —— 已写进 `--help`、
`modules/cicd.md`，并建议改用 `--env <name>`（未知名字是 exit 2 且会列出真实候选）。

### D14.12 顺带确认的两条既有不变量（实机首次覆盖）

- **「一次调用绝不重发同一个变更请求」**（`.trellis/spec/backend/error-handling.md` 的不变量，
  §14.3a 建立）在本 child 的新代码路径上被真实触发并正确执行：反向时间窗的 `deploy create`
  被服务端拒绝后，`runWrite` 失效缓存、重新解析、发现 id 完全相同，于是
  **`RetryWouldBeIdentical` 生效、一个字节都没有重发**，stderr 两条 warning 如实说明。
- **`allowExcessArguments(false)`**（`20a91e3`）由新叶子正确继承：`build delete <id> --yes false`
  退 2 且**零请求**，与 D12.9 的修复一致 —— 这条在 `test/buildCommands.test.ts` 里也有回归断言，
  且该测试走的是真实 `buildProgram()`（新的 `test/helpers/cli.ts` harness 修掉了 D12.9 末尾
  记录的"手搓 root program"缺陷类，对它的两个调用方而言）。

---

## D15. S2a live findings (pjm 迭代 sprint + 发布 version) — 2026-08-04

**本节是实机记录，不是提议。** 全部经 `node dist/bin/pingcode.js`（探测阶段走通用层
`pingcode api`，happy path 走新增的精修叶子）对真实租户执行，`PINGCODE_CONFIG_DIR` 指向
临时目录（S1 系列的教训：探测脚本曾执行 `auth logout` 抹掉真实凭据）。租户：公有云，9 个项目。
凭据有效期至 2026-09-02。

写操作落在 **YYHC**（`元一海产数据辅助决策系统`，scrum，前序 child 已用作 smoke 项目）；
一次误落在 LHG 的发布已删除，见 D15.10。

### D15.1 前提确认与推翻

| 前提 | 结果 |
|---|---|
| `pcp:read/write:pjm:sprint` / `:release` 已授权 | ✅ 十条端点全部 200，无一处 403 |
| 迭代已存在数据 | ✅ YYHC 4 条真实迭代（Sprint 1–4），SHOU02 7 条 |
| 发布已存在数据 | ❌ **9 个项目全部 0 条发布**，本 child 是这个租户里第一个用发布的 |
| 迭代仅 scrum/hybrid 可用 | ✅ 但**报错方式出人意料**，见 D15.8 |
| 发布也仅 scrum/hybrid 可用 | ❌ **kanban 项目可以建发布**（只有迭代不行） |

### D15.2 `?name=` 是**子串**匹配 —— 与 D11.2 / D14 的结论相反

两个列表的 `?name=` **都是大小写不敏感的子串搜索**，不是 scm 平台/分支与 release 环境那种
精确匹配：

| 请求 | 结果 |
|---|---|
| `sprints?name=Sprint 2` | 1 条（`Sprint 2`） |
| `sprints?name=Sprint` | **4 条**（Sprint 1–4） |
| `sprints?name=print` | **4 条** —— 无前缀锚定，是真子串 |
| `sprints?name=2` | 1 条 |
| `sprints?name=SPRINT 2` | 1 条 —— 大小写不敏感 |
| `sprints?name= Sprint 2`（前导空格） | 0 条 —— 不做 trim |
| `versions?name=probe` / `PROBE` | 3 条 / 3 条 |

**这条推翻了「本 API 的 `?name=` 一律是精确匹配」这个正在成形的归纳。** D11.2 记录仓库的
`?name=` 被无声忽略、平台的是精确匹配，D14 记录环境的是精确匹配 —— 于是很容易假设 pjm 同款。
实机是第三种行为。后果两条：

1. `--name` 在 `project version list` 里如实描述为**搜索**（"substring, case-insensitive"），
   不是 "exact"。
2. 两个 resolver（`sprint`、新增的 `pjm-version`）仍然**整表加载**、客户端匹配 ——
   子串过滤器无法回答"有哪些"，而且一个错字会命中多条，正是 resolver 最不能要的行为。

### D15.3 有效与无效的过滤器

| 过滤器 | 迭代列表 | 发布列表 | 处置 |
|---|---|---|---|
| `name` | ✅ 子串 | ✅ 子串 | 暴露为 `--name`（发布列表；迭代列表在 `project meta sprints`，未动） |
| `status` | ✅ `pending\|in_progress\|completed`，枚举校验（坏值 400 `100003`） | ✅ 但含义是**发布阶段的 `type`**：`pending\|in_progress\|published` | 暴露为 `--status`，help 里写明发布侧的资源**没有** `status` 字段 |
| `created_between` / `updated_between` | ✅ | ✅ | 暴露为 `--created-between` / `--updated-between`（发布列表） |
| `stage_id` | — | ❌ **被无声忽略**（3 条全回，含不在该阶段的） | **不暴露**（D11.2 的规则） |
| `assignee_id` | ❌ 被无声忽略 | — | 不暴露 |
| `keywords` | ❌ 被无声忽略 | — | 不暴露 |

### D15.4 服务端把时间窗**吸附到整天**

`start_at` 与 `end_at` 都是 10 位 unix 秒，但资源是**天粒度**的：

```
PATCH {start_at: 1790827200 (10-01 12:00), end_at: 1793419200 (10-31 12:00)}
→ 回读 {start_at: 1790784000 (10-01 00:00:00), end_at: 1793462399 (10-31 23:59:59)}
```

create 与 patch、迭代与发布，四种组合行为一致。**这正是 `parseDateBoundaryFlag` 已经实现的
那条不对称规则**（`--start` → 当天 00:00:00、`--end` → 当天 23:59:59），所以两个家族用
`--start` / `--end` 收日期，而不是 build/deploy 那种 `--start-at` / `--end-at` 收瞬时。
若用瞬时语义，用户写 `--end 2026-09-30` 会被服务端悄悄延长到当天 23:59:59，CLI 回显的却是
自己发出去的值 —— 那是 `parseDateBoundaryFlag` 注释里预言的、smoke 看不出来的错误类。

吸附发生在**服务端时区**；本机 CST(+08) 与之一致，未能分辨服务端是否固定 +08，
故 help 与文档只承诺"当天"，不承诺时区。

### D15.5 两个 `*/bulk`：**原子**、无上限、返回裸数组

body 形状与文档一致（`{sprints:[…]}` / `{versions:[…]}`，每条自带 `project_id`），
但**响应形状是本 CLI 里唯一的裸顶层数组**：

```json
[ {"state":"success","version":{…}}, {"state":"success","version":{…}} ]
```

没有 `{page_index,page_size,total,values}` 信封，也不是 testhub bulk 那种只回计数
（[TH§11] 的 `TestRunBulkResult`）。每条一个 `state` + 一个资源对象。

**原子性：两个端点都是原子的** —— 这与 [TH§14.5]「testhub bulk 既非原子也非 best-effort」
不同，不可从那条外推：

| 批次 | 结果 | 残留 |
|---|---|---|
| versions `[有效, 缺 name]` | 400 `100039` `versions[1].name 是必填字段` | **0**（第 0 条未创建） |
| versions `[project_id 不存在, 有效]` | 400 `100001` `versions[0].project_id不存在` | **0** |
| versions `[新名字, 与已有同名]` | 400 `100001` `versions[1]:version named … had existed`（**英文**） | **0** —— 第 0 条未创建，这是原子性的关键证据 |
| versions `[同名, 同名]`（批内重复） | **HTTP 500** `100000` `内部服务错误` | **0** |
| sprints `[新名字, 与已有同名]` | 400 `100390` `'sprint.1''sprint'资源名称已存在`（带条目下标） | **0** |
| versions × 60（名字互不相同） | **200，60 条全建** | 60（已全部删除） |
| versions `[]` | 400 `100039` `versions 数组的长度必须大于等于 1` | 0 |

**没有上限**：60 条一次通过，所以 CLI **不发明客户端上限**（testhub 的 ≤50 是文档明写的，
这里没有任何依据）。两个端点的错误码不同（`100390` vs `100001`），且 `100001` 同时承载
"父不存在"与"重名"两种含义 —— 这是它坚决不进 `ERROR_CODE_OVERRIDES` 的理由之一。

### D15.6 项目段只在五个动词中的三个上被校验

这是本轮最需要写进文档的不一致：

| 动词 | 项目段错误时 |
|---|---|
| `GET …/projects/{X}/sprints/{sprint}` | 400 `100309` `'project'不匹配` ✅ 校验 |
| `PATCH …/projects/{X}/sprints/{sprint}` | 400 `100309` ✅ 校验 |
| `GET …/projects/{X}/versions/{version}` | **200，返回真实项目下的那个发布** ❌ 不校验 |
| `PATCH …/projects/{X}/versions/{version}` | **200，真的改掉了**（用 SHOU02 的路径改 YYHC 的发布，回读确认） ❌ 不校验 |
| `DELETE …/projects/{X}/versions/{version}` | 400 `1003107` `发布与项目不匹配`（**七位码**） ✅ 校验 |

即：**一个 version id 实际上是组织级主键**，读写都不看路径里的项目，只有删除看。
后果：`project version update --project <错的项目> <版本>` 会成功并改掉别处的发布，
CLI 无法在本地识别（它没有"这个 version 属于哪个项目"的独立事实来源）。
已写进 `--help`、`modules/pjm.md` 与 `endpoints.ts` 注释。

### D15.7 `operate_at` 与发布阶段：只在同一请求里才生效

- **单独发 `operate_at`：200，回显旧值，不落库。** 这是 D14.5（`env_id` 回显**新**值却不落库）
  的近亲，但更温和一档 —— 响应至少没有撒谎，回读能发现。
- **只发 `stage_id`**：目标阶段已有 `operate_at` 时成功；目标阶段的 `operate_at` 为 `null` 时
  400 `100395` `输入的'operate_at'必须在开始和发布时间之间`。
- **`stage_id` + `operate_at` 一起**：成功，落库，`stages[]` 里该阶段的 `operate_at` 被写上。

所以 CLI：`--operate-at` 单独出现是 `UsageError`（exit 2，说明它会被无声忽略），
`--stage-id` 的 help 写明"目标阶段没到过时需要一并给 `--operate-at`"。

另外，`progress`、`changelog`、`description`（发布没有这个字段）、`assignee_name`、`goal`
等未文档化字段一律 **200 + 静默丢弃**，与 D11.3 的通则一致。**`changelog` 因此是只读的** ——
它是发布上唯一的长文本字段，却没有任何文档化的写入途径。

### D15.8 错误码：2 条进 `ERROR_CODE_OVERRIDES`，10 条明确不进

| code | 观测 | HTTP | 处置 |
|---|---|---|---|
| `100308` | `'Iteration'资源不存在` —— `GET`/`PATCH …/sprints/{未知24位}`（**这就是全部动词**，迭代没有 DELETE） | 400 | → `not_found`（exit 5） |
| `100304` | `'version'资源不存在` —— `GET`/`PATCH`/**`DELETE`** `…/versions/{未知24位}` | 400 | → `not_found`（exit 5） |
| **`100300`** | `'project'资源不存在` —— 项目 id 不存在时；**以及 kanban 项目上 `POST …/sprints` 时** | 400 | **不加**，理由见下 |
| `100309` | `'project'不匹配`（迭代与项目不配对） | 400 | **不加**：两条记录都存在，只是配对错，与 D14 的 `100106` 同判 |
| `1003107` | `发布与项目不匹配` | 400 | **不加**：同上 |
| `100343` | `'Iteration'已经存在` | 400 | **不加**：重名冲突（与 `100220`/`100105` 同判） |
| `100337` | `'version'已经存在` | 400 | **不加**：同上 |
| `100390` | `'sprint.1''sprint'资源名称已存在`（bulk） | 400 | **不加**：整批拒绝，exit 5 会指名一条却暗示其余已落（与 [TH] `100619` 同判） |
| `100001` | `versions[0].project_id不存在` **与** `versions[1]:version named … had existed`（bulk） | 400 | **不加**：**一码两义**（缺父 + 重名）+ 整批拒绝，双重不合格 |
| `100042` | `开始时间必须小于结束时间` | 400 | **不加**：跨字段校验（与 D14 的 `100102`/`100041` 同判） |
| `100395` | `输入的'operate_at'必须在开始和发布时间之间` | 400 | **不加**：跨字段校验 |
| `100394` | `输入的'stage_id'和发布目前的'stage_id'重合`（移到当前阶段） | 400 | **不加**：业务规则拒绝（空操作），发布与阶段都存在 |
| `100003` | `'status'不是有效的字符串(不是有效的枚举值)` | 400 | **不加**：入参校验 |
| `100039` | `versions[1].name 是必填字段`、`versions 数组的长度必须大于等于 1` | 400 | **不加**：入参校验，是跨模块 `100008` 的 bulk 版本 |
| `100000` | `内部服务错误`（批内重名） | **500** | **不加**：真实服务端故障，必须保留 500 |
| `100002` | `资源路径错误`（路径段非 ObjectId） | **404** | **不加**：状态码优先分支已给 exit 5 |

**`100300` 是本轮最有价值的一条否决。** 起初的计划是把它映射成 `not_found` —— 它长得和
`100200`/`100205` 一模一样，而且我的十条端点每一条都能产生它。实机否掉了：

```
POST /v1/pjm/projects/{ESSENTIAL, 一个 kanban 项目}/sprints  → 400 100300 'project'资源不存在
GET  /v1/pjm/projects/{同一个项目}/sprints                    → 200, total 0
POST /v1/pjm/projects/{同一个项目}/versions                    → 400 100209 'user'资源不存在
```

即：**kanban 项目上建迭代，服务端说"项目不存在"**，而同一个项目的列表好好地回 200，
`project list` 里也看得见它。第三行证明这是能力检查而不是别的：换成发布就越过了这一关，
直接报到 assignee 上。若映射成 exit 5，`project sprint create --project <kanban 项目>`
会告诉 agent 去找一个它眼前就有的项目 —— 与 ship `100719`、scm `100223` 同一类错误。
改为在 `project sprint create` 的错误 hint 里解释 kanban 的情况。

### D15.9 迭代的 `status` 是普通字段，不是生命周期

`PATCH {status:"in_progress"}` 与 `{status:"completed"}` 都成功，但 `started_at` /
`completed_at` **始终为 `null`**；而租户里真实的 Sprint 1–4（人在网页上开始/完成的）两个
字段都有值。所以：

- API 写 `status` **不会**触发迭代的开始/完成流程，两个时间戳无法通过 API 写入；
- 三个故事点字段（`total_/completed_/started_story_points`）是派生的，**新建即为 `0`**
  而不是缺省不返回 —— 与 scm 的 `*_count` 同形（D11/D12），但这里它们不是入参，所以不构成
  "未传字段被存成 0" 的那类危险，只是渲染时不能把 `0` 当"未知"。

`project sprint update --status` 的 help 因此写明它只改字段、不跑流程。

### D15.10 本 child 留在租户里的对象

**迭代无法删除（上游没有 DELETE），所以迭代残留是永久的。** 发布全部可删，已清零。

| 对象 | 数量 | 清理 |
|---|---|---|
| 发布（`[CLI smoke] v-probe-1/2/3`、`v-bulk-a/b`、`v-cap-00..59`、`v-e2e-*`、LHG 的一条误建） | 建 70 / 删 70 | `project version delete --yes` 与通用层 `api DELETE` |
| 工作项 `YYHC-218`（`[CLI smoke] s2a version-reference probe`，用于验证删除发布是否留下悬垂引用） | 建 1 / 删 1 | 通用层 `api DELETE /v1/pjm/work_items/{id}`（回收站可恢复） |
| **迭代**（下表逐条列出） | 建 N / 删 0 | **不可能** —— 上游无 DELETE |

永久残留的迭代（全部在 YYHC，全部带 `[CLI smoke]` 前缀，见 D15.11 的最终清单）。
被服务端拒绝的写（重名、坏枚举、反向时间窗、批内重名、kanban 建迭代、缺必填）
**均未产生残留** —— 拒绝就是没写入，两个 bulk 的原子性在这里也被证实。

LHG（`联合国官网`）曾短暂多出一条发布（探测"非项目成员能否当 assignee"时误落），
已在同一轮内删除，`LHG versions total` 回到 0。

### D15.11 实机残留最终清单（收尾核对，2026-08-04）

**发布：零。** 全部 70 条建、70 条删；YYHC 与其余 8 个项目的 `versions` 全部回到 `total 0`
（逐项目核对，含探测阶段误落 LHG 的那一条）。工作项 `YYHC-218` 已删除（回收站可恢复），
`GET /v1/pjm/work_items?identifier=YYHC-218` 回 0。目录里没有任何幽灵身份
（`keywords=ghost` / `no-such` 均为 0）—— 与 D15.7 的"无 `*_name` upsert"一致。

**迭代：4 条，永久。** 全在 YYHC，全部带 `[CLI smoke]` 前缀：

| id | name | 来源 |
|---|---|---|
| `6a712ff4a2f1bc8bb00eba3f` | `[CLI smoke] s-probe-1` | 探测阶段（通用层），用于 PATCH 局部性/status/时间窗验证 |
| `6a715951a2f1bc8bb00ebf51` | `[CLI smoke] s-e2e` | `project sprint create` 的 happy path |
| `6a715977a2f1bc8bb00ebf58` | `[CLI smoke] s-bulk-e2e-1` | `project sprint bulk` 的 happy path |
| `6a715977a2f1bc8bb00ebf59` | `[CLI smoke] s-bulk-e2e-2` | 同上 |

YYHC 的迭代总数由 4 变为 8（`Sprint 1–4` 是租户真实数据，未被触碰）。**这四条无法清除**，
因为上游没有 sprint DELETE；这是本 child 唯一不可逆的外部副作用，且在开工前就是已知代价
（brief 明确接受）。若日后 API 增加 DELETE，这四个 id 即是清理清单。

被拒绝的写全部零残留，逐条核对过：kanban 建迭代（`100300`）、重名单建（`100343`/`100337`）、
两个 bulk 的 `[新, 重名]` 批次（`100390`/`100001`，**第 0 条确实没建**）、批内重名（500）、
空数组（`100039`）、反向时间窗（`100042`）、移到当前阶段（`100394`）。

### D15.12 本轮实机导致的代码改动

1. **`src/core/wire.ts`：`ERROR_CODE_OVERRIDES` 加两行**（`100308`/`100304`），各带日期 + 路径
   + 动词，并写明 12 条明确不加的码及理由（D15.8）。这是 ground rules 里唯一授权的
   forbidden-file 例外。**其中 `100300` 的否决是实机换来的**：初版计划要加它。
2. **`src/cli/commands/projectVersion.ts`：`--operate-at` 从 `parseTimestampFlag` 改为
   `parseDateBoundaryFlag(…, 'start')`。** smoke 时发现 `--start 2026-11-01 --operate-at
   2026-11-15` 在渲染里显示为 `00:00` 与 `08:00` —— `parseTimestampFlag` 用 `Date.parse`，
   而裸日期在 JS 里按 **UTC** 解析。同一条命令里两个日期标志用两种时区是 bug 级的意外，
   且 `operate_at` 有"必须落在窗口内"的服务端校验（`100395`），偏移 8 小时可能把值推出窗口。
   已加回归断言。
3. **未改**：`project meta sprints` 的列集合与 flag 集合一字未动（它是既有叶子，加 `--name`
   或加列都是对本任务不拥有的命令的行为变更）。`README.md` 同样未动 —— F1–S1d 全部把 README
   留给 X1，本 child 沿用（只改自己模块的 `modules/pjm.md` 与 SKILL.md 的 scope 表）。
4. **没有加 `PARAM_REQUIRED_OVERRIDES` 类的 catalog 修正**，尽管 `versions.stage_id` 的
   `required: true` 是文档错误（D15.5）：`missingRequired` 只检查**顶层** body 键，带点的嵌套键
   根本不参与判定，所以这条错误标注**不会拒绝任何调用**，唯一代价是 `api describe` 多印一个
   `(required)`。为一条纯显示问题去扩展一张共享 override 表的机制（现有的
   `OPTIONAL_QUERY_OVERRIDES` 只作用于 `entry.query`）不值得，已改为在 `endpoints.ts` 注释与
   `modules/pjm.md` 里如实记录。

---

## D16. S2b live findings (pjm 工作项写 / 关联 / 标签 / 流转记录 + 项目写 / 成员) — 2026-08-04

本 child 的 api 层（commit `233de02`）已带着一轮实机结论落地，**本节是 CLI 层收尾时第二轮实机的
结果**，租户 `YYHC`（元一海产数据辅助决策系统）与 `SHOU02`，全部经编译后的
`node dist/bin/pingcode.js` 驱动；只在需要绕开 CLI 自身前置读、或需要观察 CLI 故意不暴露的东西时
才走通用层 `pingcode api`，且逐条标注。

**第二轮最重要的产出是一条撤回**：api 层记录的头号发现是错的，而 CLI 层照它建了一道**错误的拒绝**。
撤回的理由、代价和教训写在 D16.1，因为这个错误比它所声称的事实更值得记住。

### D16.1 撤回：`POST /v1/pjm/work_items/search` **不是**不支持分页 —— 它分页完全正常

api 层注释（`endpoints.ts`、`api/workItems.ts`）与命令层（`runSearch`）都建立在这句话上：

> 「每一种写法都回 `page_index: 0, page_size: 30`；`total` 准确，但拿不到第 30 条以后的行。」

**实测推翻。** `--page` / `--page-size` 驱动，YYHC 共 197 行：

| 请求 | 回显 | 行数 | 说明 |
|---|---|---|---|
| p0 s3 | 0, 3 | 3 | `YYHC-10,11,12` |
| p1 s3 | 1, 3 | 3 | `YYHC-13,14,15` —— 与上一页不相交 |
| p2 s3 | 2, 3 | 3 | `YYHC-16,18,19` |
| p0 s30 | 0, 30 | 30 | 前 9 条与上面三页逐一吻合 → **换页长不改变顺序** |
| p1 s30 | 1, 30 | 30 | 不相交 |
| p6 s30 | 6, 30 | **17** | 末页短；6×30+17 = 197 = `total` ✓ |
| p70 s3 | **70**, 3 | 0 | 越界回显请求值，不 clamp、不回绕 |

`--all --page-size 3` 走完 197 行、去重后仍是 197、首 `YYHC-10` 末 `YYHC-223`。**这与 ship /
testhub 的 search 完全同构**，也就是说 D7.2 的「与 ship 的 search 同构」前提**本来就是成立的**。

**错在仪器，不在 API。** 原探测走的是
`pingcode api POST /v1/pjm/work_items/search --body '{…,"page_index":2,…}'`，而
`core/paginate.ts` 的 `buildSearchBody` **无条件覆盖** body 里的游标：

```ts
body.page_index = page.pageIndex;   // ← 覆盖 payload 里用户写的值
body.page_size  = page.pageSize;
```

`--page` 缺省 0、`--page-size` 缺省 30，所以**把游标写进 `--body` 的任何位置都会回 0/30** ——
对任何 `…/search` 端点都如此，与本端点无关。同一条调用改用 `--page 2 --page-size 3`，立刻回显
`page_index: 2` 并给出第三页不相交的数据（I4/I5）。

> **教训（已写进 `endpoints.ts` 注释）：探测 `…/search` 的游标必须用 `--page`，绝不能用 `--body`。**

**代价评估 —— 为什么这次是"贵"的那一类错误。** 被误导的不只是一条注释：

1. `runSearch` 对 `--all` 抛 `UsageError`（exit 2），理由是"`--all` 只可能骗人"。**这是对一个
   API 支持的合法操作的拒绝，而且没有任何 flag 能绕过它。** 被告知合法操作不可能的 agent 会停下
   —— 与 `08-01-ship-cli` §14.3 判掉 ticket transition 本地预校验时的结论一字不差。
2. 每一次走 search 通道的调用都在 stderr 上打一句"这是前 N 条中的前 30 条，没有办法要更多"，
   即 `--json` 成功读也会有 stderr 输出，破坏了「`--json` 成功读 stderr 为 0 字节」这条全局契约。
3. `test/pjmWorkItemCommands.test.ts` 与 `test/help/project.test.ts` 各有一条断言**把这条假话钉住**
   （前者断言 stderr 含 `ignores paging`，后者断言 help 含 `IGNORES`）—— 测试在这里起的是反作用：
   它让错误更难被改回来。

**已做的修改**（同一 commit）：`runSearch` 去掉拒绝、改为真正走 `iterateSearchWorkItems`；删掉那条
警告；`list --help` 改为「两个通道的分页/`--all`/`total` 行为一致，差别只在**能用哪些过滤器**」；
`endpoints.ts` 首条改为带撤回标记的记录；`api/workItems.ts` 两处 doc 注释更正；两条钉假话的断言
换成钉真行为的断言（含"help 不得再出现 `IGNORES`"的反向断言）。

**保留不动的部分**：`(search)` 标记、两个通道过滤器词表不同的说明、`--unassigned` 与 `--assignee`
互斥 —— 这三条都实测为真且有用。

### D16.2 更正：`100357` 不映射的**理由**是错的（结论暂不变）

`wire.ts` 原注释说：不映射 `100357`（`工作项不包含此标签`）是因为「对应的 DELETE 在同样情形下回
HTTP 500，映射会让同一个错误在读上 exit 5、在写上 exit 7」。

两半都复测了：
- 裸 DELETE 重复删**确实**回 500 `100000`（D15 走通用层验证，见下表）。
- 但 `project work-item tag delete` **在 `--yes` 闸门之前先读一次标签**，所以精炼叶子**永远走不到
  那个 DELETE**：第二次删除报的是读路径的 400 `100357`，exit 7。

也就是说**两条精炼路径本来就一致**，映射会让它们一致地 exit 5。原理由描述的那个不对称不存在。

**结论仍保持不映射**，但换了理由，并且是**明确留给裁决**而不是在收尾 commit 里替用户决定的：映射
会把精炼叶子（exit 5）与 `pingcode api DELETE`（exit 7 / HTTP 500）劈开 —— 与旧注释担心的是同一个
劈裂，只是换了位置。已在 `wire.ts` 如实改写，并把 `tag delete --help` 里那句「重复删会 500，不要
盲目重试」改成实况：**在这个叶子上重复删是安全的**，500 只在通用层可达。

### D16.3 更正：项目外标签被接受的条数是 **8**，不是 2

api 层记录「YYHC 的工作项拒绝全部 23 条，SHOU02 的工作项接受其中 2 条」。本轮把 23 条 × 两个项目
**逐条全试**：

- YYHC 工作项：**23 条全拒**（400 `100354`），一条不收 —— 与原记录一致。
- SHOU02 工作项：**接受 8 条**（需求 / 功能设计 / 原型设计 / UI设计 / 运维 / 算法 / 后端 / 前端，
  id 连成一段 `6a4e0f7f…`、`6a2903fb…`、`6a28fc05…`、`6a28fbf9…`、`6a28fbef…`、`6a28fbe7…`、
  `6a28fbe2…`、`6a28fbdc…`），即 SHOU02 自己那一套。

**结论方向不变、反而更强**：写侧强制项目作用域，读侧完全不管。`100354` 不映射的裁决、`meta tags`
的 help 警告、以及不给 `pjm-work-item-tag` 建 resolver 行这三个决定都不受影响，只有数字更正了
（`wire.ts`、`metadata/registry.ts`、`endpoints.ts` 三处 + `modules/pjm.md`）。

### D16.4 实机确认的部分（与文档/设计一致，逐条有据）

**关联链路端到端（本 child 的头号验收项）** —— 每一跳都记录：

1. `project meta relation-types` → 9 行、全 `is_system=1`、category 为
   `blocked_by / block / caused_by / cause / duplicate / relate / cloned_by / clone / mention`
   —— **与 F5 写进 D7.6 的表逐行吻合，零漂移**（id 为本租户值 `68389e7f33ee52bc5c2586 02..0a`）。
2. `link add YYHC-222 --target YYHC-223 --relation block` → 建成 `…ef5`，type `block`。
3. 反查：`link list YYHC-222` 得 `…ef5 / block / YYHC-223`；`link list YYHC-223` 得
   **`…ef6 / blocked_by / YYHC-222`** —— 服务端维护反向边，**且两侧 link id 不同**，与
   `endpoints.ts` 的记录一致。
4. `link get YYHC-222 …ef5` 取回同一行。用**另一端的** id（`…ef6`）去 get 则 400 `100351`
   → **exit 5**，正是那条 override 存在的理由（"地址上没有这条关联"）。
5. `link delete YYHC-222 …ef5`（先无 `--yes`：exit 2，且提示回显了两端）→ `--yes` 后两侧
   **同时消失**（两个 `link list` 都 `no results`）。
6. `--relation` 三种写法全部可用：category slug（`block`）、本地化名（`关联`）、id
   （`…258606` → 回显 `duplicate`）。

**两套 relation 不互相冒充（双向验证）**：
- `/v1/relations`（F5 的 `work-item relation`）对 `work_item → work_item` **确实拒绝**：
  400 `100049` `不支持的'principal_type'`，而且 F5 的实现还主动打印了指向 `link` 的说明。
- `link`（`/v1/pjm/work_items/{id}/relations`）只吃工作项、必须带 `relation_type`。
- 两边 help 各自点名对方：`link --help` 含 `/v1/relations` 与 `relation-types`；
  `relation --help` 含 `/v1/pjm/work_items/{id}/relations`（`test/help/project.test.ts` 已断言）。

**其余叶子（均含反查）**：

| 项 | 结果 |
|---|---|
| `bulk-update --title` 两条 | `requested 2 / updated 2`，两条 `work-item get` 反查标题都变了 |
| **bulk PATCH 是局部的** | 只改 `--assignee` 后，title / state / description 全部原样保留 |
| `--property sprint_id` | HTTP 200、`updated 0`、反查 `sprint` 仍 `undefined` —— **死旋钮确认**，CLI 的短缺警告正确触发，exit 0（200 就是 200） |
| `bulk-update` 零属性 / 两属性 | exit 2，请求前拒绝 |
| `history list` | 2 行（创建行 `FROM (new) → 打开`，`transition` 后多一行 `打开 → 进行中`）；`history get` 取回同一行；未知 id → 400 `1003108` **exit 5** |
| `tag get` / `tag delete` | SHOU02-284 上加 8 条后，`work-item get` 的 `tags[]` 列出全部 8 条（**这就是"没有 tag list"的替代读法**）；`tag get` 正常；无 `--yes` exit 2 且回显标签名 + 工作项标题；`--yes` 删除成功 |
| `project progress` | 单个计数块（183 / 52 / 12 / 119），无信封、无分页 —— 与 catalog 的 `paged` 标注不符，如实记录 |
| **`project` PATCH 是局部的** | 只改 `description`，name / start_at / visibility / assignee 全部保留 |
| **项目时间是瞬时值** | 送 `1790915696`（2026-10-02 12:34:56 +08）→ 原样存回 12:34:56。**与 sprint/version 的整日对齐相反**（D15.4），这就是本组用 `--start-at/--end-at`、那边用 `--start/--end` 的原因 |
| `visibility` / `is_archived` | 通用层 PATCH 送 `public` / `1` → 200，反查仍 `private` / `false`：**静默丢弃确认**，项目既不能删也不能归档 |
| `member add` → `get` → `list` | 加 谢超：11 → 12，`member get 谢超` 反查到 `普通成员`；重复加 → `100407` exit 7（唯一性冲突，按既有口径不映射） |
| **`member remove` 的通用层出口可用** | `api DELETE /v1/pjm/projects/<p>/members/<user> --yes` 成功，12 → 11。**这是"不给 remove 叶子"这个决定安全的实证** |
| `member get` 非成员 / 未知 id | 两者都回 400 `100405` **exit 5**，且**不可区分** —— 所以这里的 exit 5 意思是"不是本项目成员"，不一定是"没有这个人"（已写进 `modules/pjm.md`） |
| `project create` | 仅 `--dry-run`（见 D16.6）：body 正确、`Authorization` 已脱敏、`project list` 事后仍 10 个项目、`CLINEVER` 不存在；坏 `--type agile` → exit 2，请求前拒绝 |
| `work-item delete` | 无 `--yes` → exit 2 且回显 `YYHC-222 "[CLI smoke] s2b bulk title"`；`--yes --dry-run` 打出 DELETE 计划且**事后仍在**；`--yes` 真删 6 条全部成功；删后 `work-item get` → exit 5 |
| 坏凭据（仅 env，未 `--save`） | 400 `100024` → **exit 3**，且 URL 里 `client_secret` 已 `***REDACTED***` |

**分页（三条新 list 叶子逐条测）** —— 回显忠实、页间不相交、末页短、越界回显请求值且 0 行、
`--all` 走全量且去重：

| 叶子 | 行数 | 分页 | `--all` |
|---|---|---|---|
| `member list` | 11 | p0/p1/p2 @4 → 4/4/3；p9 → 回显 9、0 行 | count 11、unique 11 |
| `history list` | 2 | p0/p1 @1 → 1/1；p5 → 回显 5、0 行 | count 2 |
| `link list` | 2 | p0/p1 @1 → 1/1；p4 → 回显 4、0 行 | count 2 |

注意 S2a 在 pjm 上观察到的「换页长会改变顺序」在 search 这里**没有**出现（D16.1 的 p0s3 与 p0s30
逐条吻合）。不外推到别处。

**过滤器真的在过滤**（D11.2 的规矩：静默忽略的过滤器不得做成 flag）：
- `--title-contains "CLI smoke"` → 197 中的 4 条，全部真含该串。
- `--unassigned` → 7 条，`values.every(v => v.assignee === undefined)` 为真。
- `--created-after 2026-08-04` → 5 条。
- `meta tags --name 端` → 23 中的 7 条（前端/后端，**子串**匹配）；`--name poc` → 1 条 `POC`
  （**大小写不敏感**）。这是「pjm 的 `?name=` 是子串 + 大小写不敏感」的第三例，与 S2a 的
  sprint/version 一致 —— 但仍**不外推**到 scm。
- **`meta tags` 的 `--project` 是被忽略的那一类**，但它是端点的必填参数，所以 flag 必须保留；
  已在 help 里写明"required by the endpoint and then IGNORED by it"，这是 D11.2 的例外形态：
  不是"不暴露"，而是"暴露并写明它不起作用"。

**无 `*_name` upsert 幽灵（验证过的"不存在"）** —— D12.1 要求：断言一个不存在的隐患和漏掉一个真
隐患一样错，所以这里只记录"测过、没有"，**不写幽灵警告**：
- `bulk-update --property` 送 `assignee_name` / `state_name` / `tag_name` / `type_name`：四者全部
  `updated 0`，`settings users` 仍 20 人、0 幽灵。
- 项目 PATCH（通用层）送 `assignee_name` + `member_names`：200，`settings users` 仍 20 人 0 幽灵，
  `member list` 0 幽灵。
- 与 S2a 对 sprint/version 用 `assignee_name` 的结论一致：**pjm 这一片没有 scm 那种 upsert 行为。**

### D16.5 错误码：三行 override 全部实机复核，四条明确不加

api 层加的三行，本轮**逐行在 CLI 上复现**（不是照抄注释）：

| code | HTTP | 触发 | 结果 |
|---|---|---|---|
| `100351` | 400 | `link get` 用另一端的 relation id | **exit 5** ✓ |
| `1003108` | 400 | `history get` 未知 id | **exit 5** ✓ |
| `100405` | 400 | `member get` 非成员 / 未知 id | **exit 5** ✓ |

不加的，各有写下的理由（`wire.ts` 注释）：`100354`（项目外标签，见 D16.3，**这是 `100300` 的同类
陷阱**）、`100357`（理由已按 D16.2 改写，结论待裁决）、`100407` / `100350` / `100352`（唯一性冲突）、
`100043` / `100044` / `100335` / `100336` / `100001` / `100039` / `100042`（入参校验）、`100000`
（真服务端故障，重复删标签的 500）。

**`100300` 再次确认不映射。** 本轮又在两处遇到它（未知项目的 `meta tags?project_id=`、未知项目的
`PATCH /projects/{id}`），两处确实是"没有这个项目"；但 S2a 证明它也会为一个 `project list` 明明
列得出来的项目而返回（kanban 建迭代），**一个码不能有两个答案**。

**顺带实机确认了一条全局不变量**：`project update CLIS2BX --start-at <晚于 end_at>` 触发
`withCacheInvalidation`，stderr 依次打出「服务端拒绝了用缓存 id 的写，刷新后重试一次」与
**「重解析得到相同的 id，所以缓存不是原因，什么都没有重发」**，然后报 400 `100042`。这正是
`.trellis/spec/backend/error-handling.md` 的「一次调用绝不重复发送同一个变更请求」，在实机上被看到
了一次。

### D16.6 本轮的裁量：**没有**创建第二个项目

`project create` 只跑了 `--dry-run`。理由是硬的：**这个 API 没有项目 DELETE，`is_archived` 也不可
写**，所以每一次真建都是一条永久残留。租户里已经有一条 api 层留下的 `CLIS2BX`，够用来验证
`project update` / `progress` / `member` 的全部路径（并且它就是为此而存在的），再建一条只会把不可逆
的残留翻倍而换不到任何新信息。`create` 的 body 组装、`--member` 的名字解析、`--type` 枚举校验、
时间戳换算都已在 dry-run 的请求计划里逐字核对。

**这一条是本 child 与 S1*/S2a 的自觉差异**：那些 child 的 create 都可回收（build/branch/version 有
DELETE），本 child 的项目 create 不可回收，所以验收方式必须不同。

### D16.7 叶子 / 端点计数（与 brief 的预期数字对不上，原因如下）

实测（遍历 `buildProgram()` 的叶子，非硬编码）：

| 提交点 | 叶子数 |
|---|---|
| S1d 收尾 `db50915` | **205** ✓ 与"S1d 205"吻合 |
| S2a CLI `1ad5d21` | **216** |
| HEAD（S2b api 层）`233de02` | **217** |
| 本轮（S2b CLI 层） | **236** |

brief 预期 "215 → 234"，差 2。原因**不是任何 child 超建**，而是 **`resolve` 组把 metadata kind
当叶子枚举**：每加一个 kind，`resolve <kind>` 就自动多一个叶子。

- S2a 的 11 = 10 条命令叶子 + `resolve pjm-version`。
- S2b api 层的 1 = `resolve pjm-relation-type`。
- S2b CLI 层的 **19 = 恰好是 implement.md 点名的那 19 条**（集合差比对，逐条吻合，无第 20 条）。

所以 S2b 合计 20 个叶子 = 19 命令叶子 + 1 个 kind 叶子，**20 个端点**（search 1 + bulk PATCH 1 +
DELETE 1 + relations 4 + tags 3 + transition_histories 2 + relation_types 1 + tag 词表 1 +
projects 写 2 + progress 1 + members 3）。**`project member remove` 不存在**，`test/help/project.test.ts`
连同 `tag list` / `project delete` 一起断言其缺席，三设集合恒等式（53 + 107 + 299 = 459）与八 child
端点和 92 未被破坏，再拆规则未被触发。

### D16.8 Coordination point 4：metadata 只加了**一个** kind，另一个是**主动谢绝**

brief 说 api 层加了两个 kind；实际是**加一个、拒一个**，而被拒的那个才是有信息量的一半
（`test/help/resolve.test.ts` 的两个计数 31→32、29→30 与快照行均已对上）。

**`pjm-relation-type`（已加）**，四项逐条过关：
- **无 parent**：`GET /v1/pjm/work_item/relation_types` 完全没有参数，`ResolverSpec` 的单 parent 槽
  用不上 —— 与 `release-env`、`scm-platform` 同形。
- **名字唯一**：9 行，被阻塞/阻塞/结果/原因/重复/关联/副本/拷贝/提及，且 `category` slug 也唯一
  （已作为 alias 注册，因为 id 按租户变、slug 不变）。
- **是配置且极静态**：9 行全 `is_system=1`，24 小时缓存不可能过期成问题。
- **没有可疑的服务端 `?name=`**：端点无任何查询参数，整表加载，查不到时能列出真候选。

**`pjm-work-item-tag`（谢绝）** —— 它长得跟三个 project-scoped 行一模一样，而且是唯一的标签枚举
入口，所以本来是"显然要加"的：
- **`project_id` 必填却被忽略**（D16.3：三个项目返回逐字节相同的 23 行），所以这一行只能一边声称
  project parent、一边缓存一个 parent 并不切分的列表 → N 份相同缓存，断言一个 API 没有的作用域。
- **resolver 会自信地给错答案**：写侧真的按项目校验（23 全拒 vs 8 接受）。resolver 的契约是
  "某作用域内的名字 → 该作用域内有效的 id"，这个端点无法履约。
- **名字不唯一**（四个 `后端`、三个 `前端`、三个 `算法`、两个 `运维`），最常用的标签会解析成一串
  无法区分的候选。

所以 `work-item tag add --tag <name>` 在**命令层**做一次不落缓存的实时解析（`tagIdOf`），并在
`100354` 时解释真实原因。这是诚实的形状：一次实时查询，其结果不被提升为记住的事实。

### D16.9 本 child 留在租户里的对象

**工作项有 DELETE（与迭代不同），所以工作项残留已清零。**

| 对象 | 数量 | 清理 |
|---|---|---|
| 工作项 `YYHC-222/223`（本轮建）、`YYHC-219/220/221`（api 层轮次残留）、`SHOU02-284`（本轮建） | 建 3 / 删 **6** | `project work-item delete --yes`（回收站可恢复） |
| 工作项关联（`block`/`relate`/`duplicate` 各若干，含服务端自建的反向边） | 建 6 / 删 2 + **随宿主工作项消失** | `link delete --yes` 与工作项删除 |
| 标签挂接（SHOU02-284 上 8 条） | 建 8 / 删 1 + **随宿主工作项消失** | `tag delete --yes` 与工作项删除 |
| 项目成员 谢超@YYHC | 建 1 / 删 1 | 通用层 `api DELETE …/members/<user>` |
| **项目 `CLIS2BX`** | 建 0（api 层轮次留下） / 删 **0** | **不可能** —— 上游无项目 DELETE，`is_archived` 不可写 |

**收尾核对（2026-08-04）**：`work-item list --project YYHC --title-contains "CLI smoke"` → `no
results`；`SHOU02` 同样 → `no results`；`meta tags` 仍 23 行（没多没少）；`member list --project
YYHC` 回到 11；`settings users` 仍 20 人、0 幽灵。YYHC 的 `progress` 由 183 变 **180**，正是清掉了
api 层那三条残留（`219/220/221`）。

**永久残留只有一条**：项目 `CLIS2BX`（`[CLI smoke] s2b project (renamed)`，
id `6a717c8d3e127a186f112433`，scrum，private，0 成员，描述现为
`[CLI smoke] s2b partial-patch probe`，`start_at` 现为 2026-10-02 12:34:56 +08）。它是 api 层那一轮
建的，本轮**没有再建第二条**（D16.6），并被复用为 `project update` / `progress` / `visibility` /
`is_archived` / `*_name` 全部探测的宿主。若日后 API 增加项目 DELETE，这个 id 即是清理清单。

被服务端拒绝的写全部零残留：`100354`（23×2 条标签写）、`100407`（重复加成员）、`100042`（反向时间
窗）、`100043`/`100044`（不支持的过滤器与操作符）、`100049`（`/v1/relations` 拒同类）—— 拒绝就是
没写入。

### D16.10 本轮实机导致的代码改动

1. **撤回 search 分页结论（D16.1）**，四个文件：`src/cli/commands/workItem.ts`（去掉 `--all` 拒绝、
   接上真正的 `iterateSearchWorkItems`、删掉每次都打的假警告、改 `list` 的 `addHelpText`）、
   `src/core/endpoints.ts`（首条改为带撤回标记的记录 + 探测教训）、`src/api/workItems.ts`（模块头
   注释与两个函数的 doc 注释）、两个测试文件（把钉假话的断言换成钉真行为的，含 help **不得**再含
   `IGNORES` 的反向断言）+ `project.test.ts` 快照。
2. **`src/core/wire.ts`：只改注释，未增删任何映射行。** `100357` 的理由按 D16.2 改写并明确标为
   待裁决；`100354` 的数字按 D16.3 更正。这是 ground rules 允许的范围内最小的动作 —— 有了实机观察
   却仍然**不**改 exit code，因为那是行为变更，应当由裁决而不是收尾 commit 决定。
3. **`tag delete` 的 help 与 hint 更正**：原文说"重复删会 HTTP 500，不要盲目重试"，实测该隐患在这
   个叶子上**不可达**（叶子先读一次）。改成"在这个叶子上安全，500 只在通用层可达"。
4. **数字更正**（D16.3）：`wire.ts`、`core/metadata/registry.ts`、`endpoints.ts`、`modules/pjm.md`
   四处的"2 条"改为"8 条 / 逐条全试"。
5. **文档**：`skills/pingcode/modules/pjm.md` 增项目写 + 成员 + 两个 meta 词表 + 双通道过滤 +
   `bulk-update` + `delete` + `link` vs `relation` + `tag`（含缺失的 list）+ `history`；
   `SKILL.md` scope 表加 `pcp:write:pjm:project`（**本 child 唯一的新 scope**，其余 19 个端点都落在
   已列的 `pjm:project`/`pjm:workitem` 读写里）；`test/help/skill.test.ts` 加 12 行
   `REQUIRED_FLOWS` 与该 scope。
6. **未改**：`src/core/{auth,http,config,errors,redact}.ts`、`src/cli/output.ts`、`src/cli/registry.ts`
   （无新命令组）、`test/help/__snapshots__/root.test.ts.snap`（逐字节不变）、`README.md`（留给
   X1，F1–S2a 一致做法）、`project meta sprints`（S2a 明确不动）、`package-lock.json`。

---

## D17. S3 live findings (testhub 用例批量 / 执行记录 / 执行历史 / 计划写 + 两个词表) — 2026-08-04

租户 `CLI Smoke`（测试库 `CLISMOKE`）与 `[CLI] bootstrap 08021926`。全部经编译后的
`node dist/bin/pingcode.js` 驱动；只在需要观察 CLI 故意不暴露的东西（数组上限、被静默丢弃的字段、
库 PATCH）或在叶子存在之前先探形状时才走通用层 `pingcode api`，且逐条标注。

本轮**推翻了三条**被 research 明确写下、且被上一个 testhub child 写进类型与注释的结论。三条都不是
细节：一条决定了要不要两个 deserializer，一条决定了批量上限该取多少，一条决定了 `--set` 能不能有
名字解析。

### D17.1 推翻：case 侧与 run 侧的 history **是同一个形状，而且是同一条记录**

[TH§11] / GOTCHA #3 说：`/cases/{id}/histories` 的元素是扁平 `status` 字符串、**没有**
`executed_status` 对象、**没有** `remark`，并据此要求「两个 deserializer，绝不共用」。

实机（`GET /v1/testhub/cases/{id}/histories`）：元素同时带 `status`、`executed_status`
**和** `remark`，即 run 侧的完整形状；每个元素的 `url` 指向
`/runs/{run_id}/histories/{id}`，且 `id` 与 run 侧读到的**完全相同**。它不是"另一种 history"，
而是同一批记录的另一个查询入口 —— 语义是「这条用例每个 run 的**最新**一条结果」，所以行数 = run
数，不是尝试次数。

**处理**：`TestCaseHistoryItem` 与 `parseTestCaseHistoryItem` 补上 `executed_status` / `remark`
（原来会把它们丢掉，这才是真正的 bug），但**仍然保留两个类型、两个 parser**。理由写在代码注释里：
厂商文档确实声明了两套字段集，只测了一个租户，两个小 parser 的成本远低于一次错误假设的成本。测试
从「断言 case 侧没有这些字段」改为「断言两侧各自如实读回自己收到的东西，且函数不是同一个」。

顺带一条同类：run 侧 history 也带**未声明的扁平 `status`**（[th#55] 只列 `executed_status`），
已加入类型并在注释里标为未声明但实测存在。

### D17.2 推翻：四个 `bulk` 的上限是 **100 且服务端强制**；plan 内的 `runs/bulk` **一条都不强制**

[TH§7] GOTCHA 15 说 `cases[]` ≤100、`runs[]` ≤100、`inserts/updates/deletes` ≤50，而
`PATCH /cases/bulk` 与 `PATCH /runs/bulk` **无上限**（"defensively assume 100"）。D7.3 据此让本
child「沿用 ≤50 保守限制」。

实机（**零写入**探测：全部用非法元素触发校验，服务端先查长度再查字段，所以一条都没落库）：

| 端点 | 101 条 | 51 条 | 结论 |
|---|---|---|---|
| `POST /v1/testhub/cases/bulk` | 400 `100039` `cases 数组的长度必须小于等于 100` | 字段错误 | **服务端强制 100** |
| `PATCH /v1/testhub/cases/bulk` | 同上 | 字段错误 | **强制 100**（文档说无上限 → 错） |
| `POST /v1/testhub/runs/bulk` | 400 `runs 数组的长度必须小于等于 100` | 字段错误 | **强制 100** |
| `PATCH /v1/testhub/runs/bulk` | 同上 | 字段错误 | **强制 100**（文档说无上限 → 错） |
| `POST …/plans/{plan}/runs/bulk` | **无长度错误**（101/201/**1001** 都直接进字段校验） | 无长度错误 | **一条都不强制** |

最后一行还追加了一次判定性探测：把第 51 个元素（下标 50）写成格式非法，服务端回
`updates[50].run_id 必须是一个 ObjectId` —— 它**确实读到了第 51 条**，所以既没有截断在 50，也没有
长度门。

**决定（与 D7.3 的措辞相反，按 ground rules「实机胜」）**：

- 四个新叶子（`cases bulk-create|bulk-update`、`runs bulk-create|bulk-update`）客户端上限取
  **100**，即 API 自己的上限。取 50 会拒绝服务端明确接受的 51–100 条，而 ship §14.3 已经裁定
  「本地拒绝一个合法操作且无法绕过」是不可接受的。
- 既有的 `runs bulk`（plan 内）**保持 50 不动**：文档写 50、服务端不校验，这正是本 API 反复出现的
  「接受但静默半途而废」的形状（已有三例）。一个未被强制的文档上限，宁可客户端替它守住。
- 两处不同的数字都在 `--help`、`modules/testhub.md` 与 `entries.ts` 的注释里写明了各自的依据。

### D17.3 推翻（并因此**不加** resolver 行）：`case/properties` 返回的是**内建字段**，不是 `--set` 键

D7.3 引 [TH§14.4] 说本租户「只有 8 个内建属性、无自定义属性，所以 `--set` 基本不可实测」。前半句对，
但结论方向错了 —— 问题不是"测不了"，而是**照 ship 的样子加一个 `testhub-case-property` resolver 会
造成有害写入**。

实机 `GET /v1/testhub/case/properties?library_id=`（8 行）的 `id` 全是内建字段名本身：
`maintenance_uid` / `state_id` / `type` / `important_level` / `precondition` / `steps` /
`description` / `test_type`。把其中任意一个塞进 `properties` map：

| 写法 | 结果 |
|---|---|
| `properties={"important_level": "<级别 id>"}` | **HTTP 500** `100000` |
| `properties={"description": "x"}` | **200，并且改写了顶层 `description`** |
| `properties={"CLIsmokeprop": "hello"}`（组织级存在、但不在本库方案里） | **HTTP 500** `100000` |
| `properties={"nope": "x"}`（哪儿都不存在） | 400 `100043` `'properties[nope]'不存在` —— 拒绝，不是丢弃 |

第二行是最难发现的：用户以为在写一个自定义属性，服务端却改了另一个字段，而且回 200。一个按名字
解析的 resolver 恰好会把「重要程度」解析成 `important_level` 并触发第一行或第二行。

**决定**：`metadata/registry.ts` **不加** `testhub-case-property` 行（理由整段写在表里，与 S2b 谢绝
工作项标签同一判据：无法履行「一个作用域内的名字 → 该作用域内可用的 id」这个契约就不给行）。
`testhub meta case-properties` 只作为**读**存在，`--help` 与 `modules/testhub.md` 把上表写清楚，
`SET_HINT` 从「本里程碑没有查询命令」改为「有了，但只有真正自定义的行才是 `--set` 键」。

**顺带一条：该视图连"哪行是自定义"都答不了。** 库级视图每行只有
`{id, url, name, type, options}` —— 没有 `is_removable` / `is_name_editable` /
`is_options_editable`，正是 [th#57] 的 `is_system` 那个坑（一个永远渲染为空的列）。所以本叶子
**故意不设 `CUSTOM` 列**，而在 help 里指向组织级 `GET /v1/testhub/case_properties`（43 行，逐行带
三个 `is_*`，本租户里 `CLIsmokeprop` 就是唯一一条自定义）。

### D17.4 `POST /runs/bulk` 与 `PATCH /runs/bulk` 的失败语义**相反**（两者都无文档）

同一个路径的两个动词：

- **`POST` 是逐元素 best-effort**：HTTP **200**，返回裸数组，每个入参一行
  `{state: 'success'|'failure', run?, message?}`。三条一批（其中一条是已在计划里的用例）→ 两条
  `success` + 一条 `{state:'failure', message:'创建失败或已创建'}`。
- **`PATCH` 是原子的**：一条无效 `run_id` → 400 `100016` `存在无效run_id`，**整批不落**。用读回
  验证：批前 `not_start`/`remark: null`，批被拒后仍然 `not_start`/`null`。

命令层因此对两个叶子给了不同的契约：`bulk-create` 渲染逐元素 `STATE`/`MESSAGE` 列并在有失败时打
stderr 警告（退出码仍为 0 —— 请求本身成功、结果已在 stdout，与 pjm `bulk-update` 回 `updated: 0`
的先例一致）；`bulk-update` 则可以承诺全有或全无。`--help` 里两条都用大写点明，`modules/testhub.md`
用一张三行表并列了它和 plan 内 `runs bulk` 的第三种语义（只回计数）。

其余实机确认（与文档一致，逐条有据）：`PATCH /runs/bulk` 每条都必须带 `status_id`（否则
`100008`），省略 `executor_id` **保留**原执行人（与单条 PATCH 一致，[TH§7] 的更正再次成立），且每条
生效的更新都会**在该 run 的 history 里追加一行** —— 所以批量结果是可审计的，这一点**不要**从 pjm
推广过来（pjm 的 `bulk-update` 在任何 feed 里都不出现）。

### D17.5 `cases delete` 会**级联删掉该用例的所有 run**

文档只说「删除一条用例（返回完整用例体）」。实机：删掉一条在计划里有 run 的用例后，该计划的
`runs list` 少了一行，且那条 run 的 `GET` 回 `100603`（不存在）。这与 release 的环境删除
（被引用时**拒绝**，D14.7）完全相反，也比 scm 分支删除留下 500 的孤儿（D12.5）更彻底。

**处理**：`cases delete` 在 `--yes` 门之前**多读一次** `POST /runs/search`（`filter: case.id`），把
run 条数写进拒绝消息和成功后的 stderr。一次额外请求换一个「你正要销毁 N 条执行记录」的确认，在
D8.1 的口径下是划算的。

另外两条：**它是软删除** —— `cases list --include-deleted` 仍能看到 `is_deleted: 1`，但 API 没有
undelete，所以对外仍按一次性对待；**路径只吃 id** —— `short_id` 回 404 `100002`，所以叶子先解析。

### D17.6 `PATCH …/plans/{plan_id}`：部分更新、时间戳**不吸附**、空 body 回 200

| 探测 | 结果 |
|---|---|
| 只传 `name` | 200，`state`/`assignee`/时间窗/`summary` 全部未动 → **真部分更新** |
| `state_id`（取自**组织级** `plan_states`） | 200，状态改为 进行中 |
| 半天的 `start_at`/`end_at`（22:25 / 05:58） | **原样存储** —— 与 pjm 迭代/发布被吸附到整天（D15.4）**相反** |
| `summary` | 可写（测试报告总结） |
| `summary: ""` | 400 `100003` `'summary'不是有效的字符串(值不能为空)` → **不能清空** |
| 空 body `{}` | **200，什么都没变** |
| 路径用 `short_id` | 404 `100002` → 只吃 id |
| 真 plan id + **错的 library 段** | 400 `100602` → library 段是被校验的 |

**处理**：命令层拒空 patch（否则会把「200 且什么都没发生」报成一次成功的编辑）；`--summary ""`
也在客户端拒掉并说明服务端理由；`--start/--end` 沿用 `parseDateBoundaryFlag`，help 里明确写「服务端
不吸附」，避免读者从 pjm 推广过来。

### D17.7 错误码：2 条进 `ERROR_CODE_OVERRIDES`，6 条明确不进

进表：

| code | HTTP | 观察到的位置 | 稳定性 |
|---|---|---|---|
| `100602` `测试计划不存在或无权限访问` | 400 | `GET` **与 `PATCH`** `…/libraries/{l}/plans/{p}` | 未知 24-hex id、未知 short_id 形状、**真 plan 挂错 library** 三种写法都是它；格式非法则回真 404（已被状态分支覆盖） |
| `100642` `执行历史不存在` | 400 | `GET …/runs/{run}/histories/{history}` | 合法但不存在的 history id；别的写法都走别的码 |

**`100602` 的可达性要如实说清**：精修层的 `plans get` / `plans update` 都先走 `resolveTestPlan`，
未知 plan 会在**解析阶段**以 exit 2 + 候选列表结束，根本到不了服务端。所以这一行的实际收益在**通用
层**（`pingcode api GET /v1/testhub/libraries/{l}/plans/{p}` 由 7 变 5），与其他家族「精修叶子直接
受益」的情形不同。仍然加，因为它稳定、不歧义，且让两层的退出码一致。`100642` 则是精修层直接可达的：
`runs history get <run> <未知 id>` 实测 exit 5。

不进表，逐条有理由：

- **`100619` `执行用例不存在`** —— 它在 `GET /runs/{unknown}/histories` 上**确实**只表示「没有这个
  run」，本来是一条显而易见的候选。但同一个码也用在 `runs/bulk` 批量拒绝上（上一个 child 已记录），
  那时 exit 5 会指着某一条 run 说 not_found，同时暗示其余条目已落库 —— 而它们没有。一个码不能有两
  个答案，与 `100300`、ship 的 `100719`/`100702` 同判。
- **`100643` `执行历史和测试用例不匹配`** —— history 存在但挂在**另一个 run** 上。注意它是 S1c
  `100222` 的镜像：那里厂商把「配对不存在」报成 absent 并因此进表，这里厂商报成 mismatch，CLI 就照
  厂商说的报，不做归一化（厂商措辞在 run 路径上还写成"测试用例"，措辞不是契约，只匹配 code）。
- **`100016` `存在无效run_id`** —— `PATCH /runs/bulk` 的原子前置拒绝，批级别，同 `100619` 的理由。
- **`100605` `创建执行用例失败`** —— 往计划里加一条已存在的用例。唯一性冲突，与 `100220` /
  `100343` / `100105` 同判。
- **`100039`**（`cases 数组的长度必须小于等于 100`、`updates[50].run_id 必须是一个 ObjectId`）与
  **`100008`**（`'run[0].status_id'是必填字段`）—— 入参校验；`100008` 更是**跨模块**必填码，任何时候
  都不许映射。
- **`100000` `内部服务错误`** —— 真 500（内建字段塞进 `properties` 时出现）。服务端故障必须保留 500。

### D17.8 分页：三个新列表全部如实

| 端点 | 行数 | 观察 |
|---|---|---|
| `GET /v1/testhub/plan_states` | 3 | `page_size=1` 的 0/1/2 页各 1 行且不重叠；`page_index=9` 回空并回显 9 |
| `GET /v1/testhub/case/properties?library_id=` | 8 | `page_size=3` 的第 0/2 页 → 3 行 / 2 行，不重叠 |
| `GET /v1/testhub/runs/{run}/histories` | 3 | 0/1 页不重叠、**最旧在前**；`page_index=9` 回空 |
| `GET /v1/testhub/cases/{case}/histories` | 2 | 0/1 页不重叠；`--all --page-size 1` 走完两页 |

`--all` 在 `runs history list` 与 `cases history list` 上都实测走通（`{count, all: true}`）。
`core/paginate.ts` 的「回显页码不符即停」防线在 testhub 上仍然一次都没触发（与 [TH§14.2] 一致）。

### D17.9 过滤器：`plans list --name` 是**子串**、大小写不敏感

三个计划（`CLI Smoke Plan`、`… Plan 2`、`… Plan 3`）：`name=CLI Smoke Plan 2` → 1 行；
`name=Smoke Plan` → **3 行**；`name=cli smoke plan 2` → 1 行；`name=zzzz` → 0 行。

即与 pjm 的迭代/发布列表同款（D15.2），**不是** scm 平台/分支与 release 环境的精确匹配（D11.2、
D14），也不是仓库列表的「静默忽略」。原 help 只说「按名称过滤（名称在库内唯一）」，容易被读成精确
匹配，已改为「子串、大小写不敏感」。这一条再次印证 D11.2 的告诫：**每个家族都要单独探，不要推广。**

### D17.10 顺带确认/更正的三条

1. **库有 PATCH，没有 DELETE。** 上一个 child 在 `modules/testhub.md` 写成「没有 library update
   也没有 delete」。实机：`PATCH /v1/testhub/libraries/{id}` 可写（改了 `description` 两次），
   `DELETE` 则确实不存在。文档已更正为「无 DELETE（永久） + PATCH 上游有、只是没包装」，并给出
   `pingcode api PATCH` 的写法 —— 这与 release 组区分「API 没有」和「CLI 没包」的先例一致。
2. **第四例「接受并回显但不落库」**：`PATCH /libraries/{id}` 带 `description: ""` 回 **200**，
   读回仍是旧值。前三例是 deploy 的 `env_id`（D14.5）、`operate_at` 缺 `stage_id`（S2a）、pjm 批量
   PATCH 的 `sprint_id`。这也是本 CLI 一律不提供「清空字段」的又一条根据。
3. **`POST /cases/bulk` 的字段真相比 GOTCHA #16 更细**：`suite_id` 确实被静默丢弃（200，
   `suite: null`），`state_id` 也被静默丢弃（停在库默认状态）——**但 `type_id` 未声明却生效**
   （创建后读回带上了类型）。所以命令层拒前两个、放行第三个，并在 help 里写明它「上游未声明、实测
   可用」。`maintenance_id`、`important_level_id`、`description`、`precondition`、`steps` 均如文档
   生效；`steps` 里不带 `step_id` 的步骤会被生成新 id（GOTCHA #9 的推论，实测确认）。

### D17.11 本 child 留在租户里的对象

**用例与 run 都有删除路径，所以本轮建的对象已清零**，租户回到 S3 开工前的状态：6 条用例、
`CLI Smoke Plan` 5 条 run、`Plan 2` 1 条、`Plan 3` 2 条。

| 对象 | 建 / 删 | 清理方式 |
|---|---|---|
| 用例 `CLISMOKE-7…12`（6 条：bulk 探测 2、delete 探测 1、字段探测 1、import 2） | 建 6 / 删 **6** | `cases delete --yes`（**软删除**，`--include-deleted` 仍可见，无 undelete） |
| run（`Plan 2` 内 5 条：单条 create 1、bulk-create 1、为既有用例建的 2、级联附带） | 建 5 / 删 **5** | 3 条随宿主用例级联消失，2 条用 `runs bulk --remove-run` 显式删（它们挂在**我没建**的用例上，所以不能删用例） |
| run history（本轮记录的 5 条结果） | 建 5 / 删 5 | 随 run 消失 |

**残留三条，全部说明**：

1. **计划 `CLI Smoke Plan 3` 的 `summary`** 现为 `[CLI smoke] S3 report summary`。名称、状态、
   时间窗都已用 `plans update` 复原，但 `summary` **无法清空**（D17.6：`""` 回 400），且计划没有
   DELETE。这是本轮唯一改动了「不是我建的对象」的地方，改动本身是 `plans update` 的验收所必需。
2. **测试库 `[CLI] bootstrap 08021926` 的 `description`**（上一个 child 的残留库）现为
   `[CLI smoke] scratch library; description set by an S3 probe and not clearable …`。原值是空串，
   而 `description: ""` 回 200 却不落库（D17.10 第 2 条），所以只能把它改成一句自我说明的标注。
3. **6 条软删除的用例** `CLISMOKE-7…12` 仍在 `--include-deleted` 视图里（`is_deleted: 1`）。API
   没有硬删除，也没有 undelete。

不属于本 child 的既有永久残留（未触碰）：测试库 `CLI Smoke` / `[CLI] bootstrap 08021926` 本身、
6 条 `[CLI smoke]` 用例、3 个 `CLI Smoke Plan*`、`YYHC` 的 4 条迭代、项目 `CLIS2BX`、scm 的
`cli-smoke*`。

被服务端拒绝的写全部零残留（拒绝就是没写入）：`100039` 的 5 次长度/格式拒绝、`100016` 的原子拒绝、
`100605` 的重复 run、`100003` 的空 summary、`100043` 的未知属性键、`100000` 的两次 500。

### D17.12 本轮实机导致的代码改动

1. **拆分先行、零行为变化**（design D6.5）：`src/cli/commands/testhub.ts`（1865 行）→
   `cli/commands/testhub/{index,libraries,cases,plans,runs,meta}.ts`。共享机制放在 `libraries.ts`
   （bootstrap 资源持有 flag-pair 与 parent hop，与 `scm/platform.ts` 同构），**没有**第六个
   "shared" 文件。证明：拆分前后 testhub 组的 52 段 `--help`（组 + 5 子组 + 47 叶子）全文
   **逐字节相同**（sha256 `b76aee28…`，两份 46 455 字节），且 `test/help/testhub.test.ts`、
   其快照、`testhubCommands.test.ts`(107)、`testhub.test.ts`(57)、`testhubMetadata.test.ts`(49)、
   `layering.test.ts` 全部**未经修改**通过。
2. **13 条端点 / 12 个叶子**：`endpoints.ts` 加 9 个新路径常量（复用已有的 `testhubCase` /
   `testhubLibraryPlan`），`types/testhub.ts` 加 5 个类型并更正 2 个，`api/parse/testhub.ts` 加 4 个
   parser + `parseBareArray` 并更正 1 个，`api/testhub.ts` 加 13 个 wrapper，命令层加 12 个叶子。
3. **`metadata/registry.ts` 只加一行** `testhub-plan-state`（组织级、无 parent），并把**谢绝**
   `testhub-case-property` 的完整论证写进表里。`metadata/index.ts` 加一行 `resolveTestPlanState`。
   连带 `test/help/resolve.test.ts` 的 32→33 / 30→31 两处计数与快照（Coordination point 4 预告过的
   那处 diff，+1 行）。
4. **`src/core/wire.ts`：追加 2 行 override**（`100602`、`100642`）+ 一段逐条说明不加另外 6 个码的
   注释。这是 ground rules 唯一许可的例外，已在此显式点出；`test/http.test.ts` 的镜像表同步。
5. **一处 help 更正**：`plans list --name` 由「按名称过滤（名称唯一）」改为「子串、大小写不敏感」
   （D17.9）。**一处 help 补充**：`libraries create` 增加「库永久 + PATCH 在通用层可用」的
   `addHelpText`（D17.10 第 1 条）。
6. **文档**：`modules/testhub.md` 加 12 个叶子的用法、三种 "state" 词表对照表、两个 bulk 半边的失败
   语义对照表、并更正 rule 5（上限）、rule 11（`--set` 与 `case-properties`）、rule 15（库 PATCH）
   + 新增 rule 17–20；`test/help/skill.test.ts` 加 8 行 `REQUIRED_FLOWS` 与一整条新断言组。
   **无新 scope** —— 13 条端点全落在已列出的 `pcp:read/write:testhub:testcase|testplan|configuration`
   里。
7. **未改**：`src/core/{auth,http,config,errors,redact}.ts`、`src/cli/output.ts`、
   `src/cli/commands/common.ts`、`src/cli/registry.ts`（无新命令组）、
   `test/help/__snapshots__/root.test.ts.snap`（逐字节不变）、`README.md`（留给 X1，F1–S2b 一致做法）、
   `package-lock.json`。

---

## D18. S4 live findings (ship 需求排期 + 需求流转记录) — 2026-08-05

5 端点 / 5 叶子，**全部是 GET**。因此本节的残留结论（D18.9）是结构性的零，而不是清理的结果。

### D18.1 前提确认与推翻

| 前提（来自 research / D7.4） | 实机结果 |
|---|---|
| `/v1/ship/idea/plans` 是单数段陷阱 | ✅ 确认，且 `?product_id=` **必填**（不带 → 400 `100008`） |
| 「排期」三义同名（[S§6]） | ✅ 确认，并已在 `modules/ship.md` 建表消歧（rule 10） |
| ship 全域没有任何 DELETE | ✅ 确认，且**更强**：排期与流转记录的 POST/PATCH/DELETE 一律 **HTTP 405 `Method Not Allowed`**（纯文本，非 JSON） |
| plan 有两种结构（GOTCHA #12） | ⚠️ **无法实机验证**：本租户 3 个产品**一条排期都没有**（见 D18.5）。按文档实现为两个类型 + 两个 parser |
| ship 的 `transition_histories` 与 pjm 同形 | ❌ **推翻**：父字段是 `idea` 而非 `work_item`，且是**富引用**（见 D18.2） |
| 子列表可能用 200 + 空列表掩盖父对象缺失（S1c 模式） | ❌ **不适用**：两个新列表都**真校验父对象**（见 D18.3） |

### D18.2 推翻：ship 的流转记录是**第三个** history 家族

实机单条记录（`GET /v1/ship/ideas/{id}/transition_histories/{id}`，7 个字段）：

```
id · url · idea · from_state · to_state · created_by · created_at
```

与 pjm 的 `WorkItemTransitionHistory` 逐字段对比：

| | pjm `work_items/{id}/transition_histories` | ship `ideas/{id}/transition_histories` |
|---|---|---|
| 父字段名 | `work_item` | **`idea`** |
| 父字段内容 | `Ref` | **富引用**：`{id, url, identifier, title, short_id, html_url}` |
| `from_state` / `to_state` | 有 | 有（`to_state` 带 `type`：`pending`/`in_progress`/`completed`） |
| 创建行 `from_state` | `null` | `null`（同） |
| `remark` | 无 | 无 |

所以**流转模型确实是同一套**（状态变更、创建行 `from_state: null`），但**父键不同**，共享 deserializer 会把 `idea`
漏掉并凭空造一个永远 `undefined` 的 `work_item` —— 因此 S4 写了第三个类型与第三个 parser，而**没有**为了共享而共享。
这与 D17.1（testhub 两侧 history 实为同一条记录，因此**合并**）是同一种判断方式得出的相反结论：先量，再决定。

顺带一条 UX 结论：富引用**没有 `name`**，所以 `refName()` 会退化成打印裸 id —— 人类读流转记录时最不需要的那种形式。
命令层因此加了 `ideaRefLabel()`，优先取 `identifier`。

### D18.3 两个新列表都**真校验父对象**（与 S1c 的陷阱相反）

| 请求 | 结果 |
|---|---|
| `GET /ideas/{未知 24-hex}/transition_histories` | 400 `100725 需求不存在或无权访问` → **exit 5**（`100725` 早已映射） |
| `GET /products/{未知}/plans` | 400 `100701 产品不存在或无权访问` → exit 7 |
| `GET /products/{未知}/plans/{未知}` | 400 **`100701`** —— **产品段先校验**，plan 段的错误码不会先冒出来 |
| `GET /ideas/{未知}/transition_histories/{真实 history id}` | 400 **`100725`** —— 同样是父段先校验 |
| `GET /ideas/{真实但不同的 idea}/transition_histories/{真实 history id}` | 400 `100740` → **exit 5**：`(idea, history)` 这一**对**才是地址 |

所以 S1c 在 `pull_requests/{unknown}/reviews` 上发现的「200 + 空列表掩盖父缺失」在这里**不成立**：空列表就是真的没有行。
注意这也与 D15.6（pjm 发布的项目段在 5 个动词中只有 3 个校验）相反 —— **父段是否被校验，必须逐族测量，不可泛化**。

⚠️ 仍未测量：`(product, plan)` 这一**对**是否被校验（即真实排期挂在别的产品下会怎样）。租户零排期，无法构造。

### D18.4 单数 `idea` 段之外的第二个路径陷阱：**子集合只认 24-hex id**

| 引用形式 | `GET /v1/ship/ideas/{x}`（资源本体） | `GET /v1/ship/ideas/{x}/transition_histories`（子集合） |
|---|---|---|
| 24-hex `id` | 200 | 200 |
| 8 位 `short_id`（`HxUyPHCz`） | **200** | **404 `100002 资源路径错误`** |
| 人类 `identifier`（`PD-YYHC-1`） | **200** | **404 `100002`** |

这同时**确认**了 08-01 的 §14.4（资源本体三种都收，`modules/ship.md` rule 8 的旧说法是错的，已在本 child 更正）
并**新增**了它的边界：子集合一种都不收。命令层因此在所有 history 调用前先 `resolveShipRef`，
`product idea history list PD-YYHC-1` 才能工作。

`resolveShipRef` 的两条路径都实机走通：`PD-YYHC-1` 因带短横产品前缀而**不匹配** `IDENTIFIER_RE`，
走 1 次直连 GET；`SLC-1` 形状会走 `POST …/search` + 客户端精确匹配。两条都产出真 id。

### D18.5 本租户**零排期**：明确说明未能验证什么

`GET /products/{p}/plans` 与 `GET /idea/plans?product_id=` 在**全部 3 个产品**上都返回 200 / `total: 0`。
46 条需求（PD-YYHC）的 `plan` 字段**全部为 `null`**。这不是权限或未开通问题 —— 未知产品会报 `100701`，
无 `product_id` 会报 `100008`，端点本身工作正常，就是没有数据。排期也**无法由 CLI 或 API 创建**（写动词全 405），
只能在网页端建。

**因此以下三项如实标记为未验证**，而不是假装通过：

1. **GOTCHA #12 的两种 plan 结构**（`{id,url,name}` vs 全量 `{…, assignee, start_at, end_at}`）。按文档实现为
   `ShipPlanSummary` / `ShipPlan` 两个类型 + 两个 parser；若实机某天证明两者同形，代价为零（未提取的字段仍
   通过展开原样进 `--json`），但**人类表格**会少两列日期，届时合并。
2. **`plan get` 的 product 段是否校验 (product, plan) 配对**（D18.3 末尾）。
3. **排期列表的排序与过滤**：`?name=` 在零行上无法区分「被忽略」与「过滤掉了」。已按最保守方式处理：**不暴露任何
   过滤 flag**（D11.2 原则），help 里写明原因。

### D18.6 过滤器：流转记录列表**接受三个过滤器并全部静默忽略**

| 请求 | total | 结论 |
|---|---|---|
| `…/transition_histories`（3 行的需求） | 3 | 基线 |
| `?name=zzz` | 3 | **静默忽略** |
| `?state_id=zzz` | 3 | **静默忽略** |
| `?keywords=zzz` | 3 | **静默忽略** |

这是本任务第四种 `?name=` 行为观测（前三种：scm 仓库静默忽略、scm 平台/分支精确匹配、pjm 迭代/发布与 testhub 计划子串匹配）。
**再次证明不可泛化。** 按 D11.2，静默失败的过滤器比没有更糟，所以 `product idea history` 与 `product plan` 两组
**一个过滤 flag 都不提供**，并在 help 里点明原因（避免下一个 child 以为是漏了）。

### D18.7 分页：两个新列表全部如实，且服务端自己也卡 100

| 请求 | 观测 |
|---|---|
| `…/transition_histories?page_size=1&page_index=0/1/2` | 各 1 行，三页 id **互不重叠**，`total: 3` 恒定 |
| `page_index=9`（越界） | 200，`values: []`，**回显所请求的 9**（不夹取、不循环） |
| `page_size=2` | 2 行，`page_index`/`page_size` 如实回显 |
| `page_size=200`（超上限） | **400 `100009` `'page_size'的取值范围是1到100`** —— 服务端与 CLI 客户端上限一致 |
| `product plan list --all --page-size 2` | 走通（零行），`{values:[],count:0,all:true}` |
| `product idea history list --all --page-size 1` | 3 行、按 id 去重、`{count:3,all:true}` |

复用 `core/paginate.ts` 的 query 风味，**没有**写第二条分页路径。注意本 child 的两个 list 是 **GET query 分页**，
不是 ship 的 idea/ticket 那种 `POST …/search` body 分页 —— 同一个模块里两种风味并存。
`paginate.ts` 的「回显索引不符即停」防御在此**从未触发**（回显一律忠实），保留为防御。

### D18.8 错误码：1 条进 `ERROR_CODE_OVERRIDES`，5 条明确不进

**进**：`100740 需求流转记录不存在` → `not_found`（exit 5）。理由与 pjm 的 `1003108`、testhub 的 `100642` 完全同构，
且更强一点：它对「未知 id」与「真实 id 挂在别的 idea 下」返回同一个码，正是 S1c `100222` / S2b `100351` 被接纳的形状
（厂商自己说的是「不存在」而非「不匹配」，所以不属于 D17 拒绝 `100643` 的那一类）。

**不进**，逐条理由：

1. **`100721 产品排期不存在`** —— 本 child 最诚实的一条空缺。它看起来该进：`GET …/plans/{未知}` 报它，语义就是「没有这条排期」。
   但**杀死 `100354` 与 `100300` 的那种情形（对象明明存在、只是挂在别的父下）在本租户不可观测**（零排期），而同一个码
   **也被写路径复用**（`PATCH /v1/ship/ideas/{id}` 带未知 `plan_id` → `100721`），而那恰恰是用户会把 A 产品的排期 id
   递给 B 产品需求的地方。映射它等于断言一个没被测量过的无歧义性。沿用 `100357` 的判词：*只证明了它像，没证明它是*。
   → 保持 exit 7，`product plan get --help` 自己写明这一点与如何读消息。**待证据**：任意租户里两个产品各有 ≥1 条排期即可settle。
2. **`100701 产品不存在或无权访问`** —— ship 的 `100300`。它是**父对象**缺失码，被整个 product-scoped 面共享
   （两个新列表都报它），在一个只有 5 条端点的 child 里映射它会**静默改掉既有 10 个 `product meta` 叶子**的退出码；
   且 pjm 的孪生码已被证明还能表示「这个模块在此项目不可用」，本租户同样无法反证。
3. **`100008 'product_id'是必填字段`** —— 跨模块通用必填码，第四次拒绝。
4. **`100003 'product_id'不是有效的字符串(不是有效的id)`** —— 输入校验。
5. **`100009 'page_size'的取值范围是1到100`** —— 输入校验，且是个**好消息码**（D18.7）：证明服务端与 CLI 的上限一致。

另：`100002 资源路径错误` 走的是**真 404**，`wire.ts` 的 status 分支已经把它映射成 exit 5，无需加行 —— 这是 404 分支
在本 API 上第一次被观测到确实活着（此前注释里写的是「未观测到本 API 返回 404」，D18.10 已据此更正该注释的措辞前提）。

### D18.9 本 child 留在租户里的对象：**零**

**结构性的零，不是清理后的零**：5 条端点全是 GET，本 child 一次写请求都没发过（`git`/CLI/raw 三条路径都没有）。
探针里唯一的「写」是 6 次故意打在**不存在的 id / 空 body** 上的 405 探测（POST/PATCH/DELETE 各两族），
它们连路由都没进 —— 405 是路由层拒绝，不可能落库。

**实测复核（不只是论证）**：唯一被打过写请求的对象 `PD-YYHC-1`（一次 `PATCH plan_id=<未知>`，被 `100721` 拒绝）
在探针前后逐字段一致 —— `state` 仍 `已完成`、`plan` 仍 `null`、流转记录仍 **3** 行，且 `updated_at` 仍是
`1785739752`（2026-08-03T06:49Z，**上一个 child F5** 的跨对象 smoke 留下的时间戳），并未变成 2026-08-05。
即被拒绝的 PATCH 连 `updated_at` 都没碰。

既有永久残留（**未触碰、未清理**，按 brief 要求）：项目 `CLIS2BX`、YYHC 的 4 条迭代、scm 的 `cli-smoke*` 系列、
testhub 的 6 条软删用例与 3 个 `CLI Smoke Plan*`。ship 侧在 S4 前后都**没有**任何 smoke 残留。

### D18.10 本轮实机导致的代码改动

1. **5 条端点 / 5 个叶子**：`endpoints.ts` 加 5 个路径常量（`shipProductPlans`/`shipProductPlan`/`shipIdeaPlans`/
   `shipIdeaTransitionHistories`/`shipIdeaTransitionHistory`）并把单数段注释由「all four lookups」改为「all five」；
   `types/ship.ts` 加 3 个类型；`api/parse/ship.ts` 加 3 个 parser；`api/ship.ts` 加 8 个 wrapper
   （list/iterate/get × 2 族 + 1 个 meta lookup）；命令层加 5 个叶子。
2. **命令面**：`product plan list|get`（新子组，注册在 `ticket` 与 `meta` 之间）、`product idea history list|get`
   （新子组，注册在 `update` 与跨对象子组之间，与 pjm 的 `work-item history` 同位）、`product meta idea-plans`
   （第 11 个 meta 叶子）。叶子总数 249 → **254**，命令组仍 **10**，`root.test.ts.snap` 逐字节不变。
3. **`metadata/registry.ts`：一行都没加**，因此 `resolve` 组的叶子数与 `test/help/resolve.test.ts` 的计数/快照
   **完全未动**（Coordination point 4 这次不触发）。论证：`ship-plan` 唯一的候选也被否 —— 本租户零排期，
   `?name=` 行为不可测（D18.5 第 3 条），名字唯一性无从验证，且它的唯一消费者 `idea update --plan-id` 是既有叶子、
   不在本 child 范围内。没有干净论证就不加，这与 S3 否掉 `testhub-case-property` 同一条标准。
4. **`src/core/wire.ts`：追加 1 行 override**（`100740`）+ 逐条说明不加另外 5 个码的注释。这是 ground rules
   唯一许可的例外，已在 commit body 点出；`test/http.test.ts` 的镜像表同步。
5. **一处文档更正**：`modules/ship.md` rule 8 由「ship identifiers are not lookup keys，`SLC-1` 不能直连」
   改为「资源本体收 id/short_id/identifier 三种，子集合只收 24-hex id」—— 前半句是 08-01 §14.4 已记录但没同步到
   模块文档的旧结论，后半句是本 child 的新测量（D18.4）。
6. **一处 UX 修正**：`ideaRefLabel()`，因为富引用没有 `name`（D18.2）。
7. **文档**：`modules/ship.md` 加两节用法 + rule 10「排期/测试计划/配置方案」三义对照表（并把原 rule 10 顺延为 11）；
   `SKILL.md` 的模块树、scope 清单与模块地图三处补上新叶子（**无新 scope** —— 5 条端点全在已列出的
   `pcp:read:ship:product` / `pcp:read:ship:idea` 里）；`test/help/skill.test.ts` 加 3 行 `REQUIRED_FLOWS` 与一整条
   新断言组。
8. **缺失对称操作的断言化**：`test/help/product.test.ts` 新增一组「ship 没有的写叶子」测试 —— 6 个禁止叶子逐个断言
   不存在、ship 自有叶子里 `delete` 结尾的集合恒为空、`update` 结尾的集合恒为 idea+ticket 两个。按 S1d 立下的
   「各组只断言自己的叶子」原则，**没有**重复 S2a 的全局 `CATALOG.filter` 断言。
9. **未改**：`src/core/{auth,http,config,errors,redact}.ts`、`src/cli/output.ts`、`src/cli/commands/common.ts`、
   `src/cli/registry.ts`（无新命令组）、`src/core/metadata/**`、`test/help/__snapshots__/root.test.ts.snap`
   （逐字节不变）、`README.md`（留给 X1，F1–S3 一致做法）、`package.json` / `package-lock.json`。
