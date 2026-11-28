# dsh-ofm-credit-watch

悬浮监控 Our Free Model（OFM）EAC router 各渠道剩余积分的 DSH 插件。

在主界面右上角嵌入一个可拖动的悬浮卡片，每分钟刷新一次，显示每个渠道的剩余额度、
本分钟消耗与当日累计消耗。最近有消耗的渠道排在最前面。

> 本仓库由 `dsh-ofm-credit-watch` 与早期的 `dsh-ofm-credits-widget` 合并而来。
> 前者是现在的实现：走 OFM 自己的 channel-pack 通道取数，不复制上游逻辑；
> 后者是一个自带查询脚本与 PowerShell 悬浮窗的早期版本，已在本版本移除。

## 功能

- **剩余额度**：每个渠道一行，按单位格式化（积分 / 美元 / token / 百分比）
- **今日消耗**：与下方 WorkBuddy 账号行的「今日」列对齐，一行一个口径
- **今日 token**：余额下方小字显示本渠道当天的 token 用量（输入 + 缓存读 + 输出）
- **可调高度**：渠道列表与 WorkBuddy 分区之间的横条可上下拖动改列表高度（拖动期间监听
  window，指针拖出卡片也不断），双击复位；统计界面的明细区同理
- **活跃优先排序**：五分钟内有过消耗的渠道置顶，其余按余额从多到少
- **积分包构成**：悬停渠道名看每个账号下各积分包（套餐 / 资源包 / 每日赠送）的
  剩余、总额与过期时间
- **分级告警色**：余额偏低转黄（token < 10 万、美元 < $0.5、积分 < 500、配额 < 20%），
  归零或更少转红
- **失败降级**：某个渠道查询失败时保留上一次的读数并标记失败，不让整片变空；
  超过 30 分钟没有成功读数就改显「—」，不把过期余额当成现在的数字
- **可配置显示**：勾选隐藏用不上的渠道，悬浮窗随之变矮；隐藏的渠道降频到 5 分钟一轮
- **WorkBuddy 账号消耗**：列表下方独立分区，带列头「账号 / 今日 / 余额」，逐账号显示
  当日积分消耗与当前余额；分区头部另给所有账号的今日 token 总量
- **北辰 API 余额与用量**：列表下方的独立折叠分区，标题栏常驻剩余余额（美元，按告警
  档位变色）与今日扣费、token 总量，展开看余额、当日三桶与按模型累计明细；
  统计界面里北辰进合计与明细，跟着日期条翻每天的用量
- **GPT 订阅限额**：独立折叠分区。折叠时标题栏给两个胶囊（5h / 1w），胶囊内的
  小进度条就是剩余比例，不展开也能看出余量；展开后每行一条细进度条 + 百分比。
  鼠标停在标题栏上给出多行提示，逐窗口列出剩余量与重置时刻（本地绝对时间 +
  还剩多久），末尾附今日 token 与采样时刻。限额读 dsh-codex-subscription 落盘的预测快照；
  今日 token 由本插件自己的 llm/stream 采集器统计（订阅插件只回百分比，不带用量），
  统计界面按日列出订阅线路的 token 用量，与 OFM 渠道、WorkBuddy 并列；
  剩余 ≤10% 转红、≤25% 转黄，进度条同步变色，极低余量保底 3% 可见
- **Gemini / Claude 订阅**：两个独立折叠分区，各对应 Antigravity 账号池的一个模型族。
  折叠时标题栏给两个胶囊与今日 token 合计，展开后按账号逐行给进度条与百分比，
  并在账号行上方多出一行今日 token 明细（输入 / 缓存命中 / 输出）。限额读 agy-link
  落盘的账号池快照；今日 token 由本插件自己的 llm/stream 采集器统计，按模型名前缀归栏：
  google 族（Gemini 4 系列与 Orchestrator）进 Gemini 栏，anthropic 族（Claude Opus /
  Sonnet，以及同池的 GPT-OSS）进 Claude 栏，其余模型两栏都不进。统计界面按日各列一行，
  与 OFM 渠道、WorkBuddy、GPT 订阅并列
- **统一的视觉层级**：各栏标题栏各带一根身份色条与折叠三角（三角有旋转过渡），
  数据行悬停时淡蓝高亮，分区之间有分隔线；配色全部走 `--dsw-alias-*` 主题变量，
  明暗主题自动跟随
- **OFM 模型今日 token**：独立分区，列出 OFM 十个账号渠道与免费车道当天的
  token 用量（本插件自己挂 llm/stream 采集），头部给合计；每行小字给出
  输入 / 缓存命中 / 输出三项
- **大栏隐藏**：设置面板可勾选隐藏北辰 / GPT 订阅 / Gemini 订阅 / Claude 订阅 /
  OFM 模型 / WorkBuddy 六个大栏
- **token 统计界面**：标题栏的统计按钮把整张卡片切换到统计页，按日期查看每日用量。
  顶部七格给合计、OFM 渠道、WorkBuddy、GPT 订阅、Gemini 订阅、Claude 订阅与北辰，
  下面一行小字把合计拆成输入 / 缓存命中 / 输出；明细区逐渠道列出当天用量，每行小字
  同样是三桶构成，GPT 订阅、两个订阅栏与北辰各自单独占一行；末尾给 WorkBuddy 所有
  账号的累计积分消耗
- **窗口可拉伸**：四个边、四个角都能拉，对边固定（跟 Windows 窗口一致），双击任一处复位
- **高度跟随大栏**：折叠或展开北辰 / GPT 订阅 / OFM 模型 / WorkBuddy 任一大栏时，卡片高度回到随内容自适应，展开变高、折叠变矮；内容区最高 320px，超出部分在内容区滚动，卡片不铺满屏幕
- **位置与尺寸记忆**：位置相对右下角保存，尺寸一并记住；窗口缩放后自动贴回并夹进视口

## 支持的渠道

| 渠道 | provider id | 单位 |
|------|-------------|------|
| Qoder | `qoder` | credits |
| Qoder 中国版 | `qodercn` | credits |
| TRAE | `trae` | credits |
| Cline | `cline` | USD |
| Loomy | `loomy` | credits |
| Raccoon | `raccoon` | credits |
| MiniMax Code | `minimax` | credits |
| ZCode | `zcode` | token |
| LobsterAI | `lobsterai` | credits |
| Gemini | `gemini` | % |

## 架构

两半各司其职，界线是「浏览器做不了什么」：

### 浏览器半身（`client.js`）

渲染与查询都在这里。它挂在 DSH 的 `shell.overlay` 悬浮层上，通过 OFM 已经注册的
`channel-pack` 通道（`connection.rpc.call(conn.rpc, '/api', 'channel-pack', ...)`）
查询 `credits.balances`。

**为什么不自己抓上游**：凭据解析、响应缓存与失败分类都由 channel-pack 负责，
再抄一份端点与鉴权逻辑，等于在 OFM 升级时给自己埋一个静默漂移。

### Host 半身（`index.js`）

只做一件浏览器做不了的事：**当日累计消耗的账本**。

注册 `/api/ofm-credit-watch/*` 路由：

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/ofm-credit-watch/ledger` | 读当前账本（今日累计 + 基准时间） |
| POST | `/api/ofm-credit-watch/ledger` | 报一轮读数 `{ readings: [{provider, total}] }`，返回累加后的今日累计 |
| GET | `/api/ofm-credit-watch/wb` | 读 WorkBuddy 账本（今日 + 累计 + 基准时间） |
| POST | `/api/ofm-credit-watch/wb` | 报一轮读数 `{ readings: [{key, total}] }`，返回累加后的今日与累计 |
| GET | `/api/ofm-credit-watch/usage` | 按天汇总的 token 用量（统计页与 WorkBuddy 今日合计；本地采集账本与 cost-meter 账本按日合并，同日以本地为准） |
| GET | `/api/ofm-credit-watch/beichen` | 北辰 API 的余额与按日用量（Host 侧用 API Key 取数并逐日留存） |
| GET | `/api/ofm-credit-watch/codex` | GPT 订阅的 5 小时/周限额（读订阅插件的预测快照） |
| GET | `/api/ofm-credit-watch/ofm-tokens` | OFM 各渠道今日 token 用量（读本插件自己的采集账本） |
| GET | `/api/ofm-credit-watch/ping` | 健康检查 |

**为什么差值必须由 Host 算**：同时开两个窗口时，让浏览器各自算差值会把同一笔消耗
记两遍。放在 Host 上，先到的请求把基准推到最新、后到的自然得到 0 差值，天然幂等。

**两条不记账的规则**（宁可少记，不要凭空记账）：

1. 基准距上次采样超过两小时 —— 差值归属不明（可能是关了一晚上 DSH）
2. 基准跨了一天 —— 23:59 采到 1000、00:01 采到 900，那 100 是昨天的账

两种情况下只更新基准，不累加。

读数与上一轮完全一致时不写盘（内容没变，写下去的还是旧值），最迟 10 分钟强制落一次，
避免基准时间停住之后每轮都被判成「过旧」。

### 北辰 API 读数

北辰是中转网关，余额与用量都在网关的只读接口 `GET /v1/usage` 上：网页 `/usage` 走登录态，
这条接口接受 API Key，Host 侧用 `Authorization: Bearer` 直接取。北辰一个分组一个 Key，
网关只认当前 Key 名下的账，所以插件会按分组逐个取数再合并，不会只算其中一个分组。

Key 的解析顺序（去重、空项忽略）：环境变量 `BEICHEN_API_KEYS`（逗号或换行分隔的多分组
列表）、环境变量 `BEICHEN_MAIN_API_KEY`、`~/.dsh/.credentials.yaml` 里的 `BEICHEN_API_KEYS`
列表与全部 `BEICHEN*_API_KEY` 命名条目（每个分组各占一条，如 `BEICHEN_MAIN_API_KEY`、
`BEICHEN_CC_API_KEY`）。多分组时每个 Key 各取一次，当天与按模型明细按日期、模型名相加；
余额取各分组读数的最大值——同一账户下各分组共用同一个钱包，相加会放大成组数倍。
单个分组取数失败只记下原因，不影响其它分组，全部失败才显示取数失败。

网关的 `daily_usage` 要等结算后才落当天那行，盘中当天常常查不到。此时按两条路取当天：

1. **登录态实时统计**（优先）：网页 `/usage` 的今日数字来自 `/api/v1/usage/stats?period=today`，
   它读按小时聚合表，调用完就能看到。插件从本机已登录的浏览器数据里取 `auth_token` 调这条接口，
   拿到当天精确的请求数、三桶 token 与金额。浏览器数据目录按 Edge、Chrome 顺序查找，可用
   环境变量 `BEICHEN_BROWSER_DATA` 指定。依赖 `classic-level` 用于解析 leveldb；未安装时退回
   文件扫描，仍能工作，只是可能先取到历史残留的旧令牌（会被验活跳过）。
2. **余额差估算**（兜底）：两轮合计余额的差额记入当天，余额上升不算负消耗，基准过旧或跨天不记。

接口补上当天行后一律以接口为准。

请求带 60 秒缓存与并发去重，页面每分钟轮询不会把上游打成压力测试。每次成功取数把当天
汇总并进 `beichen-days.json`，保留 90 天。这条接口按天返回，多天趋势由此逐日累积：接入
之前的日期没有记录，统计界面翻到那些天会显示「这一天没有调用记录」。

### WorkBuddy 账号账本

账号的积分由 WorkBuddy 插件自己的只读路由 `/plugins/dsh-connect-workbuddy/account-credits`
提供，一个账号一次上游读取。浏览器每 5 分钟采一轮，报给 Host 的账本键是
`wb:<region>:<accountId>`，国内版与国际版同号也不会串账。

两份累计的口径不同：

| 记录 | 规则 |
|------|------|
| 累计 | 余额每下降一次就累加一次；跨天、停机之后的那段同样成立 |
| 当日 | 只在「距上次采样 ≤ 2 小时且同一天」时累加，跨天与过旧都不记 |

余额上升（签到、领积分、换包）不算负消耗，单次读取失败不动基准。

### token 用量统计

数据由本插件自己挂在宿主 `llm/stream` 瀑布上采集，落在 `$DSH_HOME/ofm-credit-watch/ofm-tokens-YYYY-MM-DD.json`。
本插件自带的账本只是其一；没有它时仍可回落到 cost-meter 的日聚合账本 `$DSH_HOME/storages/cost-meter/ledger.json`，那是另一份
现成的「按天 × provider × model」记录，插件的每笔调用都落在那里。在这份账本上再算一遍既能
避免与会话日志的口径漂移，也不必去解析 zstd 多帧的会话文件。

账本键是 `provider:model`。OFM 的十个渠道在账本里各是独立的 provider 前缀，WorkBuddy 是
`workbuddy` 与 `workbuddy-global`（两个区域合并成一个数）。订阅线路同样走这张键：
GPT 订阅是 `openai-codex`，Antigravity 的两个订阅栏共用 `antigravity`，靠模型名前缀归栏。
账本 1.7MB 量级，按 mtime + size 做了一层缓存，面板轮询时命中缓存只 stat 一次文件。

单个 token 数字的口径是 `输入 + 缓存读 + 输出`，与 cost-meter 面板一致。缓存读通常占大头
（一次长对话能到输入输出的十几倍），把它单列会让「今天用了多少」反而没有答案。

账本保留的天数由 cost-meter 自己的设置决定；插件只读不写。

### 数据目录

`$DSH_HOME/ofm-credit-watch/`：

- `daily-YYYY-MM-DD.json` 渠道当日累计，跨天自动换文件
- `last.json` 渠道上次采样的余额基准与日期
- `wb-daily-YYYY-MM-DD.json` WorkBuddy 账号当日累计
- `wb-total.json` WorkBuddy 账号累计消耗
- `wb-last.json` WorkBuddy 账号上次采样的余额基准
- `ofm-tokens-YYYY-MM-DD.json` 当日 token 用量，含 OFM 渠道、WorkBuddy、GPT 订阅
  与两个订阅栏的桶；四个合计桶在文件里直接落键

Host 不可用时（路由 404），浏览器退到 `localStorage` 的本地兜底账本。这只是降级：
换浏览器或清缓存后会从头开始。

## 安装

插件通过 Cordis bundle patch 挂载：

```yaml
- insert:
    - id: ofm-credit-watch
      name: 'dsh-ofm-credit-watch'
      config: {}
```

把插件目录放到 profile 的 `node_modules/` 下（或做成 junction 指向源码目录），
DSH 启动时自动加载。

## 测试

```bash
npm test
```

五套离线测试，共 581 项检查：

| 文件 | 覆盖 |
|------|------|
| `selftest.cjs` | 格式化、单位识别、告警档位、过期时间、readChannel 归一、tooltip、位置解算、尺寸夹取、八向缩放几何、本地账本、并发上限、隐藏降频、失败时效、WorkBuddy 汇总、token 口径 |
| `rendertest.cjs` | 组件渲染链路：行数、配置面板、当日列、告警档位、单位生效、失败行、账本回退、八向热区、WorkBuddy 分区、订阅分区、统计视图切换 |
| `ledgertest.mjs` | 记账规则：下降才记、回升不计、失败不动基准、跨天不记、过旧不记、幂等、累加、脏数据、写盘节流、WorkBuddy 双口径、用量聚合与缓存、订阅线路模型归栏、回填指纹去重 |
| `routetest.mjs` | 真 HTTP：路径前缀、方法分派、body 解析、loopback 守卫、两套账本往返、用量路由、订阅限额响应 |
| `beichentest.mjs` | 北辰多分组取数与合并 |

账本测试通过 `OFM_CREDIT_WATCH_DIR` 指向临时目录，不会碰用户真实账本。

## 许可证

MIT
