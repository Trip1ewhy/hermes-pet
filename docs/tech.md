# 技术骨架（V1 拍板版）

> 上一版是占位讨论稿。本版基于 Hermes CLI v0.10.0 实测能力 + 与 Wayne 的第一轮深聊确认。
> 标记 ✅ = 已拍板；🟡 = 实施中可能微调；⚠️ = 仍需验证。

---

## 1. 总体形态

桌宠 = **Tauri 桌面壳 + 本地 Hermes CLI 子进程**。

- 桌宠端**不直接接 LLM**，所有"思考/工具调用/上下文/会话持久化"全部交给 Hermes CLI。
- 桌宠负责：窗口 / 动画 / 状态机 / 拖放 / 把用户输入翻译成 CLI 调用 / 流式收 stdout 反馈到 UI。
- **接入目标**：用户从 GitHub 下载桌宠，只要本机已安装 Hermes，**一键接入零配置**（详见 §3 自动发现）。

---

## 2. 已拍板的技术决策（✅）

| 项 | 决策 |
|---|---|
| 平台 | macOS 优先；不做多屏（V1） |
| 前端壳 | **Tauri 2.x** |
| UI 层 | TypeScript + React + SVG + Framer Motion |
| 状态管理 | XState（桌宠状态机） + 轻量 store（Zustand 或 React Context） |
| 后端壳语言 | Rust（Tauri 自带），用 `tokio::process` spawn Hermes |
| Hermes 接入方式 | `hermes chat -Q --accept-hooks -q "..."` 子进程模型（详见 §3） |
| 上下文持久化 | **完全交给 Hermes**，桌宠只管 session_id（详见 §4） |
| V1 切片 | research / 对话 / cowork **三个气泡一起做**，普通模式同期推进 |
| 渲染 | SVG + 少量 CSS 动画 + Framer Motion 处理切换/弹跳 |
| 项目结构 | 见 §8 |

---

## 3. Hermes CLI 接入方案（核心）

### 3.1 实测的 CLI 关键能力

```
hermes chat -q "<query>" -Q [--source tool] [--continue|--resume <id>]
            [--ignore-rules] [--ignore-user-config] [-s <skills>]
            [--max-turns N] [--accept-hooks]
```

关键开关解释（决定我们怎么用）：

| 开关 | 作用 | 我们用它干什么 |
|---|---|---|
| `-q, --query` | 单次非交互查询 | **每次气泡提交 = 一次 spawn**（详见 §3.3） |
| `-Q, --quiet` | 关掉 banner / spinner / 工具预览 | **必须开**，让 stdout 干净，方便我们当流读 |
| `--source tool` | 给会话打"非用户"标签 | **V1 暂不开**。2026-04-29 实测 `-Q` + `--source tool` 会明显变慢（`hi` 从约 10s 到约 44s），等 Hermes 侧确认后再恢复 |
| `-c, --continue` | 续接最近会话 | 对话气泡多轮用 |
| `-r, --resume <id>` | 按 session_id 续接 | 我们自己存 id，对话气泡精准续接 |
| `--accept-hooks` | 自动同意未见过的 shell hook | 桌宠是无 TTY 环境，**必须开** |
| `--yolo` | 跳过所有危险命令确认 | **不开**（cowork 类任务可能跑工具，让 Hermes 自己策略走） |
| `--ignore-user-config` | 不读 `~/.hermes/config.yaml` | 给"重置桌宠到干净状态测试"的设置项用，平时不开 |
| `-s, --skills` | 预加载 skill | 高级用户可在设置里给某个气泡指定 skill |

### 3.2 三气泡 = 同一入口 + 不同 system prompt（方案 1）✅

每个气泡的差异**只是 system prompt + 是否带上下文**：

| 气泡 | system prompt 来源 | 上下文 | spawn 命令模板 |
|---|---|---|---|
| **research** | settings.system_prompts.research | 单轮（每次新 session） | `hermes chat -Q --accept-hooks -q "<system_prompt>\n\n<user_input>"` |
| **对话** | settings.system_prompts.dialog（可被气泡内"临时改"覆盖） | 多轮（首次 spawn 拿 session_id，后续 `-r <id>`） | 首次同上；后续：`hermes chat -Q --accept-hooks -r <session_id> -q "<user_input>"` |
| **cowork** | settings.system_prompts.cowork | 单轮 | 同 research |

> system prompt 注入方式：**拼到 `-q` 文本最前面**。Hermes CLI 当前没有 `--system-prompt` 开关，但单轮 query 把骨架前置 + `--ignore-rules` 可以达到等价效果。如果 Hermes 后续加了原生 `--system-prompt`，桌宠端只改命令模板这一个常量。

### 3.3 为什么是"每次气泡提交 = 一次 spawn"，而不是常驻 daemon

候选方案对比：

| 方案 | 优点 | 缺点 | 选择 |
|---|---|---|---|
| **A. 每次提交 spawn 新进程** | 实现最简单；天然并发隔离；崩了不影响其他气泡 | 启动开销（实测 Hermes 冷启 ~0.5-1s） | ✅ V1 |
| B. 常驻一个 hermes chat 交互进程 | 避免冷启 | 多气泡并发要排队；崩了全挂；交互模式没有 `-Q` 那种干净流 | ❌ |
| C. `hermes mcp serve` + 桌宠走 MCP 客户端 | 协议化 | MCP 是给"别的 agent"用的，桌宠不是 agent；杀鸡用牛刀 | ❌ |
| D. `hermes acp` + ACP 协议 | 编辑器集成的标准协议 | 桌宠不是编辑器，行为模型对不上（ACP 假定有"打开的文件"等概念） | ❌ |

冷启 1s 在桌宠的"按回车 → 红脸 → 流出来"节奏里完全感知不到，方案 A 胜。

### 3.4 流式输出处理

`hermes chat -q -Q` 的 stdout 行为（实测验证项）：

- ✅ 2026-04-29 实测：`-Q` 模式下 stdout 可按行读取；简单回复可能一次吐出多行，也可能只吐一行，但 `BufReader::lines()` 能稳定处理。
- ✅ `session_id:` 实际可能写到 stderr；stderr 必须实时读取，否则 pipe buffer 可能导致子进程阻塞，表现为简单请求耗时从约 10s 拉长到 30s+。

桌宠端的处理（无论哪种）：

- 前端先生成 `task_id`，立即进入 running，再 `invoke("hermes_start_chat", { args: { task_id, ... } })`
- Rust 端 spawn Hermes，stdout/stderr 两个 reader 同时跑
- stdout 普通行 → `emit_to("pet", "hermes-chunk", { task_id, line })`
- stdout/stderr 中的 `session_id:` 行 → `emit_to("pet", "hermes-session", { task_id, session_id })`
- 子进程退出 → `emit_to("pet", "hermes-done", { task_id, exit_code })`
- exit_code != 0 或 reader 异常 → `emit_to("pet", "hermes-error", { task_id, message })`

注意：

- 事件名必须用 kebab-case（如 `hermes-chunk`），不要用 `hermes://chunk` 这类 URL 风格；Tauri 2 前端 `listen()` 收不到。
- `src-tauri/capabilities/default.json` 的 `windows` 必须包含实际窗口 label。当前窗口 label 是 `pet`，不是默认模板里的 `main`。
- 后端事件投递优先用 `emit_to("pet", ...)`，避免后续多窗口阶段事件误投。

### 3.5 多任务并发

- 每次 spawn 分配一个 `task_id`（uuid）
- Rust 端用 `HashMap<task_id, Child>` 管子进程
- 任意一个还在跑 → 工作模式头部保持红脸
- 同一气泡内 V1 限制串行（cowork 提交时如果上一个没完，提示用户）；不同气泡之间允许并发

---

## 4. 一键接入：`hermes` 自动发现

> 目标：用户 `git clone` 桌宠 → `npm tauri build` → 双击 .app → 桌宠直接能跑，**不用打开任何配置面板**。

### 4.1 启动时自动发现 Hermes 二进制

按以下顺序探测，第一个命中即用：

1. 用户在设置面板里手动指定的路径（覆盖一切）
2. 环境变量 `$HERMES_BIN`
3. 在 PATH 里 `which hermes`（Rust: `which::which("hermes")`）
4. 常见安装位置硬编码 fallback：
   - `~/.local/bin/hermes`（pip --user 默认，Wayne 本机就是这个）
   - `/usr/local/bin/hermes`（Homebrew Intel / 手动安装）
   - `/opt/homebrew/bin/hermes`（Homebrew Apple Silicon）
   - `/usr/bin/hermes`
5. 全部找不到 → 弹引导窗口"未检测到 Hermes，安装方法：..." + 一个"我已安装，让我手动指定路径"按钮

### 4.2 启动时健康检查

找到二进制后，桌宠后台跑：

```
<hermes_bin> --version          # 拿版本
<hermes_bin> doctor              # 看配置/凭据是否就绪（可选，比较慢）
```

- 版本 < 桌宠声明的最低支持版本 → 弹"建议升级"
- `doctor` 报严重问题（如未登录任何 provider）→ 桌宠头上挂个小问号 + 引导用户跑 `hermes setup`

### 4.3 设置面板的"测试连接"按钮

跑一次：

```bash
<hermes_bin> chat -Q --accept-hooks -q "ping, reply with 'pong' only"
```

- exit 0 + stdout 含 "pong" → ✅
- 失败 → 显示 stderr 全文 + 常见原因清单

### 4.4 `--source tool` 隔离（V1 暂缓）

理想状态下，所有桌宠发起的会话都应打 `--source tool` 标签，这样：

- 用户在终端跑 `hermes sessions list` 不会被桌宠的会话刷屏
- 用户也可以 `hermes sessions list --source tool`（如果支持过滤）单独看桌宠会话

但 2026-04-29 实测发现，`-Q` 与 `--source tool` 组合会让简单请求明显变慢。V1 runner 暂不带 `--source tool`，先保证交互延迟；后续等 Hermes CLI 行为确认后再恢复会话隔离标签。

---

## 5. 上下文持久化（决策更新）

**上下文完全委托给 Hermes Agent。** 桌宠端只存当前会话的 `session_id`，以及一份内存里的 UI 展示消息列表；不会把历史重放给 Hermes，也不做持久化。

- 对话气泡首次提交：spawn 不带 `-r`，从 stdout/stderr 中解析 `session_id:`，存到内存。2026-04-29 实测 `session_id` 实际在 stderr
- 同一对话气泡后续提交：用 `hermes chat -Q -r <session_id> -q "<新输入>"`
- 对话浮窗展示当前 session 的完整消息流：右侧是用户问题，左侧是 Hermes 回复；最新回复随 stdout chunk 实时增长
- 关闭对话浮窗的 × → 丢掉内存里的 session_id 和 UI 消息列表（V1 不做"恢复昨天那个对话"）
- 用户如果想找回 → 走 `hermes sessions browse` 自己处理（桌宠 V2 可以加"恢复会话"入口）

> ✅ 2026-04-29 实测：`-Q` 模式会输出 `session_id:`，但它可能在 stderr 而不是 stdout；runner 必须两边都扫。

---

## 6. 状态机（XState）

桌宠的"灵魂"就是这张状态机。两套并行 machine：

### 6.1 模式 machine（顶层）

```
normal_mode  <-- 切换 -->  work_mode
   |                         |
   | (transition_to_work)    | (transition_to_normal)
```

### 6.2 普通模式子状态

```
base
 ├── idle_anim          (60s 触发，800ms 后回 base)
 ├── head_pat           (点击头部，500ms 后回 base)
 ├── catching           (拖入接住，500ms 后回 base)
 └── sleeping           (鼠标 N 分钟未靠近 → 进；鼠标靠近 → 退到 base)
```

### 6.3 工作模式子状态

```
hidden  ──hover head──> bubbles_shown
                              |
                              ├── 用户提交 ──> task_running ──流结束──> done(挥手) ──> bubbles_shown
                              └── 鼠标离开全区域 ──> hidden
```

`task_running` 是**计数态**：维护 `running_task_count`，spawn +1，task_done -1，归 0 才回 done。

### 6.4 跨态规则

- 任何状态切换到工作模式 → 强制走 transition_to_work（带 600ms 飞行动画）
- transition 期间所有交互 ignore
- sleeping 状态下收到模式切换快捷键 → 先 wake 再切

---

## 7. 进程 / 通信架构

```
┌────────────────────────────────────────────────────────┐
│  Tauri Main (Rust)                                     │
│                                                        │
│  ├─ Windows                                            │
│  │   ├─ pet_window      透明 / always-on-top / 无装饰  │
│  │   ├─ settings_window 普通窗口，按需创建            │
│  │   └─ result_popovers 每个气泡的展开浮窗（按需）    │
│  │                                                     │
│  ├─ HermesRunner                                       │
│  │   ├─ discover()      自动找 hermes 二进制          │
│  │   ├─ health_check()                                 │
│  │   └─ spawn(task) -> task_id                        │
│  │       ├─ tokio::process::Command                   │
│  │       ├─ stdout reader → emit_to("pet", "hermes-chunk") │
│  │       ├─ stderr reader → 扫 session_id / 累积错误       │
│  │       └─ wait → emit "done" / "error"              │
│  │                                                     │
│  ├─ State                                              │
│  │   ├─ settings (持久化到 settings.json)             │
│  │   ├─ affection (持久化到 affection.json)           │
│  │   └─ active_tasks: HashMap<task_id, Child>         │
│  │                                                     │
│  └─ Tauri Commands (前端调用)                          │
│      ├─ submit_task(bubble, input, opts) -> task_id   │
│      ├─ cancel_task(task_id)                          │
│      ├─ get_settings / update_settings                │
│      ├─ pat_pet (亲密度 +1)                           │
│      └─ ...                                            │
└────────────────────────────────────────────────────────┘
                ↕ Tauri events / invoke
┌────────────────────────────────────────────────────────┐
│  Frontend (React + XState + TS)                        │
│                                                        │
│  ├─ machines/                                          │
│  │   ├─ modeMachine.ts                                 │
│  │   ├─ workBubblesMachine.ts                          │
│  │   └─ taskMachine.ts (per-bubble)                   │
│  │                                                     │
│  ├─ pet/  Pet.tsx + Pet.svg + animations/             │
│  ├─ bubbles/  Research / Dialog / Cowork              │
│  ├─ dnd/  全局拖放 layer                               │
│  └─ settings/                                          │
└────────────────────────────────────────────────────────┘
```

事件流（以一次 cowork 提交为例）：

1. 用户在 cowork 气泡按回车 → 前端先生成 `task_id` 并进入 running
2. 前端 `invoke('submit_task', { task_id, bubble: 'cowork', input: '...' })`
3. Rust 端拼好命令，spawn，返回同一个 `task_id`
4. 前端 taskMachine 进入 `running` → 通知 modeMachine `running_task_count++` → 桌宠红脸
5. Rust 端持续 `emit_to('pet', 'hermes-chunk', { task_id, line })` → 前端按 task_id 累积到对应气泡的 buffer
6. Rust 端 `wait` 到子进程退出 → `emit_to('pet', 'hermes-done', { task_id, exit_code })`
7. 前端 taskMachine → `done`，modeMachine `running_task_count--`，归 0 → 红脸消 + 挥手 + 气泡红点

---

## 8. 项目结构（V1）

```
hermes-pet/
├── README.md                     # 一键接入说明（重要！面向 GitHub 用户）
├── package.json
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── windows/
│       │   ├── pet.rs            # 透明置顶窗口
│       │   ├── settings.rs
│       │   └── popover.rs
│       ├── hermes/
│       │   ├── discover.rs       # §4.1 自动发现
│       │   ├── health.rs         # §4.2 健康检查
│       │   ├── runner.rs         # spawn + 流式
│       │   └── prompts.rs        # 三气泡默认 prompt 常量
│       ├── state/
│       │   ├── settings.rs
│       │   └── affection.rs
│       └── commands.rs           # 暴露给前端的 Tauri commands
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── machines/
│   │   ├── modeMachine.ts
│   │   ├── workBubblesMachine.ts
│   │   └── taskMachine.ts
│   ├── pet/
│   │   ├── Pet.tsx
│   │   ├── Pet.svg               # 单一 SVG，所有变体用 props 切
│   │   └── animations/
│   │       ├── breathe.ts
│   │       ├── idle.ts
│   │       ├── sleep.ts
│   │       ├── transition.ts
│   │       └── wave.ts
│   ├── bubbles/
│   │   ├── ResearchBubble.tsx
│   │   ├── DialogBubble.tsx
│   │   ├── CoworkBubble.tsx
│   │   ├── BubbleStack.tsx
│   │   └── ResultPopover.tsx
│   ├── dnd/
│   │   └── DragLayer.tsx
│   ├── settings/
│   │   ├── SettingsApp.tsx       # 独立窗口的 entry
│   │   └── sections/
│   └── lib/
│       ├── hermes.ts             # 调 Tauri commands 的 wrapper
│       └── events.ts             # 监听 hermes-chunk / done / error
├── assets/
│   ├── sounds/
│   │   ├── pat.wav
│   │   ├── snore.wav
│   │   └── done.wav
│   └── icons/
└── tests/
    └── ...
```

---

## 9. 第一周 V1 切片（开干计划）

按 Wayne 拍板：**research / 对话 / cowork 三气泡同期 + 普通模式同期**。

但仍要保留"先验证最高风险"的纪律。第一周拆三个并行小流：

### 流 0 — 项目脚手架 ✅（2026-04-28 完成）

- `npm create tauri-app@latest --template react-ts` 起模板
- 实际版本：Tauri 2.10.3 / React 19.1 / Vite 7 / TypeScript 5.8 / Rust 1.95.0 stable
- `cargo check` 通过；`npm run tauri dev` 跑通默认 GUI 弹窗
- `Cargo.lock` 纳入 git（Tauri app 类项目锁依赖版本）

### 流 A — Tauri 窗口骨架（最高风险，最先做）⚠️ 阶段一 ✅（2026-04-28）

1. 透明全屏窗口 + 一个 SVG 圆 + 鼠标在 SVG 外能正常点穿到 Finder（**spike 验证 macOS 透明 + 穿透**）
2. 第二个独立窗口（设置面板占位）
3. always-on-top + 不抢焦点验证

**验证标准**：能看到圆，圆外能点桌面图标，圆能拖动。任何一项不通就考虑 fallback 到 Electron。

**阶段一实际进展（2026-04-28）：**

- ✅ 透明窗口 + always-on-top（NSWindow level=floating）+ all-spaces + never-hide：稳定
- ✅ 200×200 米色 SVG 圆，铺在透明全屏窗口里
- ✅ 圆内 hover 表情 + 按住拖动：稳定
- ⚠️ **圆外点穿桌面：未通过**。两条路都失败：
  - 前端切 `set_ignore_cursor_events`：穿透后 webview 收不到事件，没法切回，死锁
  - Rust 30Hz 轮询 `NSEvent.mouseLocation` + emit "global-mouse" 给前端命中切：编译/运行通过，但前端 IPC 链路没生效，调试条无反应。已回退。
- 决策：**这条 spike 暂搁置**，等流 B/C 跑通后单独啃。`set_pet_passthrough` Tauri command 在 lib.rs 里保留，给后续用。

第二个独立窗口（设置面板占位）和"圆外点穿"留到阶段二。


### 流 B — Hermes Runner（中风险）

1. Rust 端写 `discover` + `spawn(query) -> stream`
2. Tauri command `submit_task` 跑通：前端 invoke → 后端 spawn `hermes chat -Q --accept-hooks -q "hello"` → stream 事件回到前端 console.log
3. 验证 `-Q` 模式 stdout 是否流式（决定 §3.4）
4. 验证 session_id 输出方式（决定 §5）

**阶段一实际进展（2026-04-29）：**

- ✅ `discover` + `spawn` 跑通；当前 runner 在 `src-tauri/src/runner.rs`
- ✅ 临时 `ChatPanel` 跑通端到端：前端 invoke → 后端 spawn Hermes → stdout/stderr reader → Tauri event → 前端累积显示
- ✅ stdout 可按行读取；`session_id:` 实际写到 stderr，runner 已同时扫描 stdout/stderr
- ✅ Tauri event 名称改为 kebab-case：`hermes-session` / `hermes-chunk` / `hermes-done` / `hermes-error`
- ✅ capability 坑已修复：窗口 label 是 `pet`，`src-tauri/capabilities/default.json` 必须授权 `["pet"]`
- ⚠️ `--source tool` 暂停使用：与 `-Q` 组合性能异常，详见 §4.4
- ⚠️ Hermes CLI 简单请求仍可能 30-40s 才吐第一行，需继续确认是 Hermes/provider 延迟还是 CLI 模式问题

### 流 C — UI 角色（低风险）

1. 画 Pet.svg（普通模式 + 工作模式两套姿态）
2. Framer Motion 接呼吸 + idle + 红脸切换
3. 状态机骨架（XState）

第一周收尾：流 A + B 合流跑通 cowork 端到端（输入 → 红脸 → 流 → 挥手 → 点开看结果），流 C 出可用的角色和呼吸动画。

---

## 10. 仍需 spike 验证的清单（⚠️）

按风险降序：

1. **macOS 透明窗口 + 鼠标穿透 + always-on-top 多窗口** —— Tauri 2 在 macOS 下能否同时满足
   - 透明 + always-on-top + all-spaces + never-hide：✅ 已验通（2026-04-28）
   - **鼠标穿透（圆外点桌面）：❌ 未验通，已搁置**。前端切穿透会死锁；Rust 轮询 emit IPC 链路没跑通。lib.rs 里保留了 `set_pet_passthrough` command 占位。
   - 多窗口：未验
2. **`hermes chat -Q -q` 的 stdout 流式特性** —— ✅ 已验通：按行读取可用；简单回复可能一次吐一批行
3. **`-Q` 模式下 session_id 输出位置** —— ✅ 已验通：可能在 stderr，runner 必须 stdout/stderr 两边都扫
4. **多个 hermes 子进程并发** —— 三气泡同时跑会不会撞 `~/.hermes/` 的锁、SQLite session store？
5. **macOS 拖放 API** —— 从 Finder/浏览器/编辑器拖文件、文本、URL 进透明窗口的兼容性

每项验通后回填到本文件对应章节。

---

## 11. 与 features/ 的对齐（变更通告）

本轮决策已同步到以下 feature 文档（2026-04-28）：

- ✅ `features/research-bubble.md` 后端调用段 → 改为本文件 §3.2 的命令模板
- ✅ `features/dialog-bubble.md` 多轮对话 / 历史记录段 → 改为"由 Hermes session 托管，桌宠只存 session_id"（§5）
- ✅ `features/cowork-bubble.md` 后端调用段 → 同 research，标注不开 `--yolo`
- ✅ `features/settings.md` Hermes Agent 区块 → V1 默认自动发现，路径项是 fallback / 高级用户用（§4.1）
- ✅ `features/drag-and-drop.md` 文件传递 → V1 决定：`@<绝对路径>` 拼到 `-q` 文本，依赖 Hermes 自带的工具读文件（§10 第 5 项 spike 后再终审）

---

## 12. 历史决策摘要

- 2026-04-28：第一轮深聊确认 Tauri / 三气泡同步 / 上下文交给 Hermes / 一键接入 / 项目结构。本文件从"占位"升级为"V1 拍板版"。
- 2026-04-28：完成对 features/ 5 个文档的回填同步（§11）。
- 2026-04-28：项目脚手架就位，敲定实际版本（Tauri 2.10.3 / React 19.1 / Vite 7 / TS 5.8 / Rust 1.95.0），`Cargo.lock` 改为入库。详见 §9 流 0。
- 2026-04-29：流 B Hermes Runner 端到端跑通；修复 Tauri capability 窗口 label、event name、task_id 时序、stderr 实时读取等问题。过程记录见 `docs/progress.md`。
