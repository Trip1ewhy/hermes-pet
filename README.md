# Hermes 桌宠 🪽

> 给本地 [Hermes Agent](https://github.com/) 配一张脸 —— 一个戴翅膀头盔的小机器人，常驻你的 macOS 桌面。

**形态即价值。** 功能上不比直接用 `hermes chat` 多什么，但桌宠的存在感、陪伴感、和"拖东西过来叼住"的物理直觉是聊天框给不了的。

---

## 截图

> _TODO：放一张普通模式截图、一张工作模式截图、一张三气泡浮出的截图_

```
[普通模式]                    [工作模式]                  [三气泡]
   桌面正中                      右上角半头                hover 后浮出
```

---

## 这是什么

Hermes 桌宠是 [Hermes Agent CLI](https://github.com/) 的桌面前端。它不是新造一个 agent，而是给你已经在用的 Hermes 套了：

- 一张**脸**：戴 Hermes 翅膀头盔的小机器人，大头小身
- 三个**气泡入口**：research / 对话 / cowork
- 一点**陪伴感**：摸头、idle、睡眠、拖东西过来张嘴接住

后端"思考"完全由你本机的 Hermes Agent 完成，桌宠只负责前端壳。

---

## 两种形态

桌宠有两种相互独立的状态，**手动切换**（默认快捷键 `⌘⇧H`）。状态指示靠头盔上的两只翅膀分开发光。

### 普通模式（陪伴 / 休息）

- 全身可见，待在桌面上
- 没事就原地转圈、扭头（每分钟一次 idle 动画）
- 鼠标长时间不靠近 → zzz 睡着
- 可以摸头（点击头部触发反馈动画 + 默默累计亲密度）
- 头盔**左翅膀亮金色**

### 工作模式（高效 / 专注）

- 钻进屏幕右上角，只露半个头 + 单侧翅膀
- hover 才浮出三个气泡：research / 对话 / cowork
- 头盔**右翅膀亮蓝色**
- 任务跑的时候涨红脸；做完了挥一下手

---

## 三个入口（仅工作模式可见）

| 气泡       | 干什么                                                                          |
|-----------|--------------------------------------------------------------------------------|
| **research** | 调研类任务，内置一个万能分析骨架（拆问题、列假设、找证据、给结论）                  |
| **对话**     | 多轮对话，可临时展开 / 收起 system prompt 编辑（改了只对当次有效）                  |
| **cowork**   | 派单：交付一个完整任务                                                          |

三个气泡的输出**不直接全部显示**，点开它才查看结果。详细行为见 [`docs/features/`](docs/features/)。

---

## 拖放

两种模式都能往桌宠身上拖东西（**文件 / 选中文本 / URL**），它会朝鼠标这边凑过来张嘴接住。工作模式下，拖动时 hover 哪个气泡，东西就进哪个气泡。

---

## 一键接入：让你的 Hermes 跑桌宠

> 桌宠**不自带** Hermes Agent。它会去找你本机已有的 `hermes` 命令。

### 前置条件

- macOS 12+（V1 仅支持 macOS）
- 已安装 [Hermes Agent](https://github.com/)，能在终端跑 `hermes --version`

### 安装步骤

```bash
# 1. 下载最新 release
# （TODO：填 GitHub releases 链接）

# 2. 拖到 /Applications

# 3. 双击启动
```

### 自动发现 Hermes

桌宠启动时按以下顺序找 `hermes` 二进制（找到第一个就用）：

1. 用户在设置面板手动指定的路径
2. 环境变量 `$HERMES_BIN`
3. 系统 `PATH`（`which hermes`）
4. 常见 fallback：
   - `~/.local/bin/hermes`
   - `/opt/homebrew/bin/hermes`（Apple Silicon Homebrew）
   - `/usr/local/bin/hermes`（Intel Homebrew）

如果都没找到，桌宠会弹出引导面板，告诉你怎么装 Hermes 或在哪里手动指路径。

### 不动你的 Hermes 配置

桌宠对你已有的 Hermes 是**只读 + 隔离**的：

- 所有调用都带 `--source tool` 标签 → 桌宠的会话**不污染**你 `hermes sessions list` 的视图
- 不会写 `~/.hermes/config.yaml`，不会改你的模型偏好或 skills
- 用 `hermes chat -Q -q "..."` 单次查询，跑完即退；不常驻 daemon
- 对话气泡的多轮上下文交给 Hermes 自己的 session 机制（`-r <session_id>`）持久化，桌宠只存一个 ID

技术细节见 [`docs/tech.md`](docs/tech.md) §3-§5。

---

## 项目状态

**当前阶段：技术骨架已就位（2026-04-28），开始 V1 实现。**

- ✅ 产品设计：本 README + `docs/features/`
- ✅ 视觉设计：`docs/UI-UX-Style.md`
- ✅ 技术骨架：`docs/tech.md`（V1 拍板版）
- ✅ 项目脚手架：Tauri 2.10 + React 19 + TS 5.8 + Vite 7（`cargo check` & dev 启动均已验证）
- ⏳ 第一周 spike：Tauri 透明窗口 + Hermes runner + SVG 角色（三流并行）
- ⏳ V1 MVP：三气泡能跑通 + 普通模式基础动画 + 拖放 + 设置面板

---

## 文档索引

### 起点

- 本 README ← 你现在看的
- [`AGENTS.md`](AGENTS.md) —— 项目地图，给协作者 / AI agent 看

### 设计

- [`docs/UI-UX-Style.md`](docs/UI-UX-Style.md) —— 视觉与交互的统一规则（角色、色板、动画）
- [`docs/features/`](docs/features/) —— 单功能详述
  - [normal-mode.md](docs/features/normal-mode.md) —— 普通模式
  - [work-mode.md](docs/features/work-mode.md) —— 工作模式
  - [mode-switching.md](docs/features/mode-switching.md) —— 模式切换
  - [research-bubble.md](docs/features/research-bubble.md) —— research 气泡
  - [dialog-bubble.md](docs/features/dialog-bubble.md) —— 对话气泡
  - [cowork-bubble.md](docs/features/cowork-bubble.md) —— cowork 气泡
  - [drag-and-drop.md](docs/features/drag-and-drop.md) —— 拖放
  - [settings.md](docs/features/settings.md) —— 设置面板

### 技术

- [`docs/tech.md`](docs/tech.md) —— 技术骨架 V1 拍板版（栈选择、CLI 接入、状态机、进程通信、第一周计划、风险清单）

---

## 范围

### MVP（V1）必须有

- 两种模式 + 手动切换 + 翅膀颜色指示
- 工作模式三个气泡能正常发起任务并取回结果
- 后端跑通：spawn `hermes chat` 子进程，流式拿输出
- 普通模式基础动画（idle、睡眠、摸头反馈）
- 拖放接住文件 / 文本 / URL
- 任务运行 → 涨红脸；完成 → 挥手；展开看结果
- 设置面板：退出、Hermes CLI 路径、prompt 默认值

### MVP 不做（推到 V2+）

- 多屏幕支持
- 桌宠在屏幕里走动
- 亲密度的 UI 可视化（V1 只默默记，不展示）
- 自定义皮肤、主题
- Windows / Linux 支持

---

## 反馈与贡献

> _TODO：填 issue 链接、贡献指南、行为准则_

桌宠主作者：[@wayney]()

---

## License

MIT —— 详见 [LICENSE](LICENSE)
