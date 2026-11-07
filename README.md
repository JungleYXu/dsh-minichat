# dsh-minichat · 随手问答

**输入框旁边的一个小面板：问一句、答一句，主对话一个 token 都不会涨。**

[![npm](https://img.shields.io/npm/v/dsh-minichat?label=npm&color=blue)](https://www.npmjs.com/package/dsh-minichat)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![status](https://img.shields.io/badge/status-1.0.0-brightgreen)](#状态)
[![platform](https://img.shields.io/badge/DSH%20Desktop-0.2.x-5b6b8c)](https://www.deepseek.com/harness/)

DeepSeek Harness 插件。它**不是会话**：不建 session、不写消息、不进主对话上下文 —— 走 `ctx.llm.stream` 直接调一次模型，答完就关。

适合那些「不值得开一个会话」的问题：`这个正则为什么这么写`、`帮我把这段话改短`、`今天几号`。

---

## 核心能力

### 不进主对话

主对话的上下文长度、费用、缓存全都不受影响。面板自己的历史只有**最近 10 轮**，第 11 轮挤掉最早的一轮 —— 标题栏一直写着这条规则，不需要猜。

### 固定尺寸，不做第二块聊天窗口

消息区高约三条对话，再长就在面板内部滚动，面板不会越问越大。它有意不做多会话、文件夹、工具调用、@文件、图片、语音 —— 想聊长的，转给主对话。

### 收藏是一问一答

☆ 只出现在提问那条，一点就连答案一起收藏并置顶到顶部条；收藏页可单独删掉某一组。`⟳` 只清窗口、保留收藏；`🗑` 连收藏一起清（点两下确认）。收藏不占轮次，不会被挤掉。

### 知道今天几号

系统提示第一行注入当前日期时间（`Asia/Shanghai`），问日期、星期、几点直接答，不用联网。

### 联网是显式开关

底部「网络 · 自动 / 开 / 关」。自动模式下，只有问题看起来**时效相关**（今天、最新、股价、天气、新闻…）才用 `ctx.web.search` 查一次，并抓第一条正文节选；这些内容只拼进当次请求，不入库。搜不到就明说「无法确认」，不凭记忆编。

### 延迟写在脸上

```
首字 0.9s / 共 2.3s · 3/10 轮
```

只报耗时和轮次，不算钱。转给主对话时，面板把结论拼成一段摘要塞进输入框（不发送），面板内容保持不动。

---

## 安装

```bash
dsh plugin --profile web add dsh-minichat
# 或从源码装
dsh plugin --profile web add github:JungleYXu/dsh-minichat
```

或在插件市场里搜「minichat」一键安装。

本地开发：在 profile 的 `package.json` 里加 `"dsh-minichat": "link:/abs/path/to/dsh-minichat"`，把 `dsh-minichat` 加进 `dsh.profile.bundles`，在 profile 目录 `pnpm install`，重启 DSH。

## 配置

不需要配置：模型用 profile 里的默认选择，窗口长度固定在代码里（10 轮）。

## 数据

只存一个纯文本文件，原子写（tmp + rename）；插件启动时把它重写为空：

```
~/.dsh/minichat.json   # { schema: 2, messages, favorites, usage }
```

存在 `DSH_HOME` 时以它为准。

**重启 DSH 就清空** —— 插件启动时把窗口重置为空，所以重启后对话、收藏、用量都不会回来；这个面板只服务当前这次运行。关闭面板、刷新页面（Ctrl+F5）、切换会话都不会清空。

## 状态

`1.0.0`：稳定版。自测覆盖宿主与客户端两侧（`test/smoke.mjs` 54 项、`test/client.mjs` 10 项）。1.0 起数据格式固定为 `schema: 2`，面板不再显示金额估算，重启 DSH 即清空窗口。

## 兼容性

- DSH Desktop 0.2.x（Web 客户端），宿主 Node ≥ 20
- 客户端注入 `@deepseek-ai/dsh-client-locale`、`-ui-slots`、`-ui-conversation`；只 `require('react')`

## 开发

```bash
# 两侧都不需要启动 DSH
$env:ELECTRON_RUN_AS_NODE='1'
& "<DSH install>/DeepSeek Harness.exe" test/smoke.mjs    # 54 项：宿主路由 / 窗口 / 收藏 / 联网 / 重启清空
& "<DSH install>/DeepSeek Harness.exe" test/client.mjs   # 10 项：客户端渲染
```

改 `client.js` 只需 `Ctrl+F5`；改 `index.js` 要重启 DSH。

## English summary

A quick-answer panel for DeepSeek Harness. Not a session: it makes one model call through `ctx.llm.stream` with only its own rolling window of the last 10 turns — no session record, no tools, no growth of the main conversation's context. Fixed-height UI, pin-able Q&A pairs, injected current date, opt-in web lookup for time-sensitive questions, and a latency/round readout.

## License

MIT © JungleYXu
