# Lessons Learned

> 稳定沉淀 V1 实现过程中的 bad case、根因和修复方案。`docs/progress.md` 记录过程上下文；本文件只保留后续开发最容易复用的排障结论。

---

## Tauri / macOS 窗口与鼠标穿透

| Bad case | 现象 | 根因 | 修复 / 经验 |
|---|---|---|---|
| 透明窗口整屏吃点击 | 桌宠启动后，其它 app、桌面图标都不能点 | 全屏 webview 启动后强制 `ignoresMouseEvents = false` | 启动默认 `set_ignore_cursor_events(true)`，只在前端注册的 hit region 内取消穿透 |
| 纯前端 hover 切穿透不可行 | 一旦窗口穿透，webview 收不到后续 `mousemove`，无法切回可交互 | macOS 已把鼠标事件交给下层窗口，前端不会再收到 hover / move | 后端轮询全局鼠标坐标，不依赖 webview 事件找回命中 |
| 拖动宠物时容易丢事件 | 宠物拖出原矩形后窗口重新穿透，拖动中断 | hit-test 只看鼠标当前位置是否在 region 内 | 后端检测左键按下后进入捕获态，松开后释放，拖动期间保持可交互 |
| hit region 精度不足 | 圆角或透明角落也会参与命中 | 当前 hit region 是矩形，不是精确 mask | V1 可接受；角色 SVG 落地后再考虑精确 mask 或多矩形拆分 |

---

## Tauri Event / Capability

| Bad case | 现象 | 根因 | 修复 / 经验 |
|---|---|---|---|
| 前端收不到 Hermes 回复 | 后端日志显示 `EMIT chunk -> Ok("ok")`，UI 仍停在等待 | `src-tauri/capabilities/default.json` 授权窗口是 `main`，实际窗口 label 是 `pet` | capability 的 `windows` 必须包含 `["pet"]` |
| 全局 event 投递不明确 | 后端 `app.emit(...)` 返回 ok，但前端收不到时难判断目标窗口 | 单窗口阶段用全局 emit 容易掩盖窗口 label / capability 问题 | 后端优先用 `emit_to("pet", ...)`，后续多窗口也更安全 |
| `hermes://chunk` 风格事件名不可用 | 后端 emit 成功，前端 `listen()` 回调不触发 | Tauri 2 event name 不适合 URL 风格 `//` | 事件名统一用 kebab-case：`hermes-chunk` / `hermes-session` / `hermes-done` / `hermes-error` |

---

## Hermes Runner / CLI

| Bad case | 现象 | 根因 | 修复 / 经验 |
|---|---|---|---|
| 事件可能早于前端 busy 状态到达 | Hermes 快速输出时，listener 用旧 ref 过滤掉早到事件 | 后端生成 `task_id` 并在 `invoke()` 返回前已开始 emit | 前端先生成并登记 `task_id`，传给后端复用 |
| `session_id` 不在 stdout | 前端拿不到多轮 session id，或 stdout 只有正文 | Hermes 将 `session_id: ...` 当 meta 信息写到 stderr | stdout 和 stderr 两边都实时逐行扫描 `session_id:` |
| 不实时读取 stderr 会拖慢或卡住 | 简单 `hi` 从约 10s 拉长到 30s+ | 子进程 stderr pipe buffer 可能阻塞 Hermes 写入 | stdout / stderr 两个 reader 同时跑；stderr 非 session 行只在 exit 非 0 时上报 |
| `--source tool` 明显变慢 | `hi` 耗时从约 10s 飙到约 44s | Hermes CLI 当前版本下 `-Q` + `--source tool` 组合性能异常 | V1 runner 暂不带 `--source tool`，等 Hermes 侧确认后再恢复会话隔离标签 |
| 中文 system prompt 触发后端 panic | 输入后没有回答，日志显示 `end byte index ... is not a char boundary` | 调试日志用 `&a[..60]` 按字节截断中文字符串，切到 UTF-8 字符中间 | 字符串预览用 `chars().take(n).collect()` 按字符截断 |

---

## 三气泡 UI / Session 状态

| Bad case | 现象 | 根因 | 修复 / 经验 |
|---|---|---|---|
| research / cowork 输入后看不到返回 | 后端已有 chunk，UI 不弹结果 | 三气泡重构后只有 dialog 会 `onPopoverToggle(true)`；research / cowork 输出留在 hook state 里但浮窗没打开 | 三个气泡提交后统一打开结果浮窗，直接展示流式输出 |
| 点击完成后的未读 session 可能清空内容 | 任务完成出现红点后，点击对应 session tab，下方输出 / 消息流消失 | 点击 session 会 `task.reset()`；如果完成态 `runningSessionIdRef` 尚未被 effect 清掉，空 hook 状态会回写到刚完成的 session | session 切换 / 新建 / 删除前先清空运行 ref，再 reset hook |
| 收起生成过程后完成，点击红点看不到结果浮窗 | 任务完成后点击红点 / 气泡，只显示上方输入 pill，看不到下方消息框 | 运行中点过"收起生成过程"后，`generationCollapsed` 保持 true；点击气泡只切 `popoverOpen`，浮窗仍被 `!generationCollapsed` 挡住 | 点击气泡准备打开结果时强制 `setGenerationCollapsed(false)` |
| 气泡红点打开后显示空 session 或只剩输入 pill | 任务完成后气泡有红点，点击气泡打开浮窗却看不到刚完成的消息记录 | 气泡级红点只表示某个 session 未读；点击输入框走 focus 路径时没有复用 label 点击的打开逻辑，可能仍停在空 active tab 或保留 `generationCollapsed` | 抽出统一的 `openBubbleView()`：打开气泡时一律优先切到第一个 `unread` session，并强制解除 `generationCollapsed`；label 点击和 input focus 都走这条路径 |
| session tabs 行被消息区挤压 | 展开对话记录后，session tab 模块高度变窄 | session tabs 容器作为 flex 子项可收缩，下方消息区挤压了它 | 给 `.bubble-session-tabs` 固定 `flex: 0 0 36px`，tab / `+` 按钮固定同高 |

---

## 文件拖放

| Bad case / 注意点 | 现象 | 根因 | 修复 / 经验 |
|---|---|---|---|
| 拖入文件不应直接污染输入框正文 | 输入框塞满 `@<绝对路径>`，视觉拥挤且影响用户继续输入 | 文件是附件语义，不是用户自然语言正文 | 拖入后在输入框下方显示 file chip；提交时再把路径按 `@<绝对路径>` 附加到 Hermes query |
| 拖到桌宠头部没有明确目标气泡 | 用户把文件丢给桌宠本体，不知道进哪个入口 | 工作模式下头部不是具体任务入口 | V1 默认进入 `dialog` 气泡；拖到具体气泡则进入对应气泡 |
| 多文件路径传给 Hermes 的表现未验证 | UI 能显示多个 chip，但 Hermes 是否稳定读取多路径还需肉眼验证 | 依赖 Hermes CLI 对多行 `@<绝对路径>` 的处理 | 多文件提交时按多行 `@<绝对路径>` 附加；保留后续观察 |

