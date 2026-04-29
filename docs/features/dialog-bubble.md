# Feature: 对话 气泡

## 一句话

工作模式下三个气泡的中间一个 —— 跟 Hermes 普通聊天，可以临时改 system prompt，改了只对这次有效。

## 输入

- placeholder：`说点什么…`
- 单行输入（带 `⌄` 指示可展开 system prompt 编辑区）；回车提交
- 支持拖入文件 / URL / 文本：内容追加到输入框（不直接提交）

## System Prompt 临时编辑

气泡右侧的 `⌄ system prompt` 标识可点击：

- 点击 → 在气泡下方滑出一个多行编辑区（约 4 行高，可手动拉伸）
- 默认显示当前默认 system prompt（设置里维护，详见 [settings.md](../settings.md)）
- 用户在编辑区里改任何内容 → 只对**当前这次对话**生效
- 不点"保存为默认"按钮，关掉桌宠再开就会恢复成默认值
- 编辑区右下角有两个动作：
  - **保存为默认** —— 把当前编辑区的内容覆盖默认 prompt（写入设置）
  - **重置** —— 把编辑区内容恢复成默认值
- 再点 `⌄`（变成 `^`）或点编辑区外 → 收起编辑区

## 多轮对话

**上下文完全交给 Hermes Agent 管，桌宠端只存 `session_id`。**

- 首次提交：`hermes chat -Q --accept-hooks -q "<system_prompt>\n\n<user_input>"`，从 stdout/stderr 中拿到 `session_id` 存到内存
- 后续提交：`hermes chat -Q --accept-hooks -r <session_id> -q "<user_input>"`（不再带 system prompt，Hermes 自己记得这个 session 的上下文）
- 切到普通模式或重启桌宠 → V1 阶段**丢掉内存里的 session_id**（用户想找回可以走 `hermes sessions browse`，V2 再加恢复入口）
- 编辑过的临时 system prompt 因为只在首次注入，**会话内自动保持有效**；新对话（用户点 ×）回归默认值

详见 [../tech.md](../tech.md) §3.2 / §5。

## 视觉反馈

- 输入提交 → 红脸（任务运行）
- 输入提交后立即进入当前 session 的对话流：**用户问题在右侧，Hermes 回复在左侧**
- 流式输出过来的内容：**实时累积到最新一条 Hermes 回复气泡里**（与 research 不同，对话需要看到流的过程）
- 流结束 → 红脸消退 + 挥手
- 用户可在 history 浮窗里继续输入，无需重新 hover

## 结果展开形式

不同于 research 是"点开看结果"，对话气泡的 history 浮窗在**首次提交后默认展开并保持**：

- 浮窗位置：贴在对话气泡下方，宽 380px
- 浮窗内：
  - 当前 session 的完整对话流
  - 右侧：用户每一次提问
  - 左侧：Hermes 每一次回复，运行中时最新回复气泡实时增长
  - 底部：与对话气泡输入框联动的输入区（实际同一个输入）
  - 顶部右上：×（关闭并重置整个对话）
- 点击浮窗外不收起（避免对话被打断）；点 × 才完全关闭和重置

## 历史记录

- V1：当前会话的 `session_id` 和**用于界面展示的消息列表**存在桌宠内存；上下文判断仍完全交给 Hermes session，不靠桌宠重放历史
- 关掉桌宠 / 切普通模式 / 点 × → 丢掉 id 和界面消息列表，下次是新 session。Hermes Agent 那边的 session 数据其实还在（`~/.hermes/`），只是桌宠不再主动续接
- V2 可选：把"最近 N 个对话 session_id"持久化到 settings，提供"上次聊到哪"入口，背后还是 `hermes chat -r <id>`

## 错误情况

- 同 [research-bubble.md](research-bubble.md) 的处理：困惑表情 + 错误内容显示 + 重试按钮

## 与其他特性的关系

- system prompt 默认值 → [settings.md](settings.md)
- 拖入内容追加到输入框 → [drag-and-drop.md](drag-and-drop.md)
- 后端调用协议 → [tech.md](../tech.md)

## 验收标准

- system prompt 展开 / 收起动画 < 200ms
- 编辑区拉伸顺畅
- 同一 session 内多轮消息不被覆盖：右侧保留用户问题，左侧保留 Hermes 回复
- 对话流式输出延迟（CLI stdout → UI 显示）< 100ms
- 关闭对话（×）→ 上下文真的清干净，不会泄漏到下次

## 未决问题

- system prompt 的临时编辑是否应该在**会话内多轮间持续有效**，还是每条对话独立？V1 拟定会话内一致；如果跨气泡切换（去 research 又回来），是否保留？
- "保存为默认"应该多明显？担心用户误点把默认 prompt 改坏
- 拖入文件给对话气泡时，是把文件内容粘贴到输入框，还是把文件路径传给 CLI 让 Hermes 自己读？
