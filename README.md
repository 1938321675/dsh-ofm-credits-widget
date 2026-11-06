# dsh-ofm-credits-widget

DSH 本地自研插件，在主界面右下角嵌入 OFM 渠道积分卡片，显示各 AI 渠道剩余额度与当日消耗，支持按渠道隐藏显示。

## 功能

- 卡片显示每个渠道的剩余额度、本次消耗量（相对上次刷新）和当日累计消耗
- 活跃渠道（有消耗的）排在前面
- 鼠标指向渠道名，tooltip 显示账号和各积分包构成（剩余/总额）
- 设置按钮可勾选要显示的渠道，配置持久化到浏览器 localStorage
- 卡片可拖动，默认贴在 DSH 窗口右下角，随 DSH 移动而跟随
- 每 60 秒自动刷新，也可通过托盘图标手动立即刷新

## 支持的渠道

| 渠道 | 标签 | 单位 |
|------|------|------|
| Qoder | Qoder | credits |
| Qoder 中国版 | Qoder 中国版 | credits |
| TRAE | TRAE | credits |
| Cline | Cline | USD |
| Loomy | Loomy | credits |
| Raccoon | Raccoon | credits |
| MiniMax Code | MiniMax Code | credits |
| ZCode | ZCode | tokens |
| LobsterAI | LobsterAI | credits |

## 数据来源

查询脚本 `widget/credits-query.mjs` 与 `dsh-our-free-model` 插件的 `channel-pack/credits.balances` 数据源同源：
- 凭据读取 `~/.dsh/.credentials.yaml`
- 账号读取 `~/.dsh/channel-pack/state.json`
- 直连各渠道余额 API

## 安装

插件通过 Cordis bundle patch 挂载：

```yaml
- insert:
    - id: ofm-credits-widget
      name: 'dsh-ofm-credits-widget'
      config: {}
```

将插件目录放到 `~/.dsh/ofm-widget-plugin`，DSH 启动时自动加载。

## 文件说明

| 文件 | 作用 |
|------|------|
| `package.json` | 插件清单，name 为 `dsh-ofm-credits-widget` |
| `index.js` | 宿主半身，注册 `/api/ofm-credits/*` 查询路由 |
| `client.js` | 浏览器半身，React 渲染积分卡片 |
| `cordis.patch.yml` | Cordis bundle patch，挂载插件 |
| `widget/credits-query.mjs` | 查询各渠道余额的 Node 脚本 |
| `widget/credits-widget.ps1` | 独立 PowerShell 悬浮窗（旧形态） |
| `widget/credits-widget.lnk` | 悬浮窗快捷方式 |

## 实现说明

当日消耗累计数据保存在 `~/.dsh/ofm-widget/daily-YYYY-MM-DD.json`，跨天自动重置。各渠道 API 若未返回积分包过期时间，tooltip 中对应位置显示 `—`。
