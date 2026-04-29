# AGENTS.md

给在此目录下工作的 AI agent / 协作者看的项目地图。

## 项目是什么

Hermes 桌宠 —— 一个常驻在 macOS 桌面的小机器人形象，背后挂的是用户本地的 Hermes agent（CLI 形态）。桌宠不是新造一个 agent，而是给已有 Hermes agent 套了一层"有翅膀的脸 + 三个交互入口 + 陪伴感"。

## 当前阶段

**技术骨架已就位（2026-04-28），开始 V1 实现。** 项目脚手架（Tauri 2.10 + React 19 + TS 5.8 + Vite 7）已搭好，进入第一周三流并行 spike 阶段。

## 文件结构

```
hermes-pet/
├── README.md            # 对外索引（GitHub 入口）
├── AGENTS.md            # 本文件 - 项目地图 + AI 协作者工作约定
├── LICENSE              # MIT
├── docs/
│   ├── PRD.md           # 产品愿景与需求（对内）
│   ├── UI-UX-Style.md   # 视觉与交互风格
│   ├── tech.md          # 技术骨架 V1 拍板版
│   ├── progress.md      # 实现进度 / 常见错误 / 排障记录
│   └── features/
│       ├── normal-mode.md
│       ├── work-mode.md
│       ├── mode-switching.md
│       ├── research-bubble.md
│       ├── dialog-bubble.md
│       ├── cowork-bubble.md
│       ├── drag-and-drop.md
│       └── settings.md
├── src/                 # React 前端（占位脚手架）
├── src-tauri/           # Rust + Tauri 后端
├── public/
├── package.json / vite.config.ts / tsconfig*.json
└── index.html
```

## 阅读顺序建议

新人协作者：

1. README.md —— 快速了解产品形态
2. docs/PRD.md —— 详细产品需求
3. docs/UI-UX-Style.md —— 角色长什么样、交互克制度
4. docs/tech.md —— 技术决策、CLI 接入方案、状态机、第一周计划
5. docs/features/ —— 按需查特定功能的详细行为

## 工作约定

1. 所有设计讨论结果更新到 `docs/` 下的 markdown 文件（`docs/PRD.md` / `docs/tech.md` / `docs/UI-UX-Style.md` / `docs/features/*.md`）。
2. 实现过程中的常见错误、踩坑、排障结论、临时 workaround，要及时记录到 `docs/progress.md`；稳定后的技术决策再同步回 `docs/tech.md` 或对应 feature 文档。
3. **Git 节奏（Plan C）**：当前不开 feature 分支，直接在 `main` 上推进。每个里程碑必须独立 commit + 完整 commit message（背景 / 涉及文件清单 / 关键决策原因），多条逻辑独立的改动要拆成多个 commit。
4. **Push 规则**：本地 commit 后**不要立刻 push**。必须先本地 `npm run tauri dev` 跑通 + 用户肉眼验证 + 用户明确点头，才能 push。AI 不可自作主张 push。
5. 不要在仓库之外创建或修改文件，除非用户明确要求（例如 `~/.hermes/`、Tauri 应用 bundle 等运行时路径）。
6. 文档语言中文为主，技术术语和 API 名保英文。
7. 任何"待定 / TBD"在写代码前必须回头跟用户确认。
8. README.md 是对外的索引，PRD.md 是对内的产品需求；两者重叠部分以 README 为准。

## 角色

| 名称 | 角色 |
|---|---|
| Wayne | 产品负责人 / 用户本人 |
| Hermes Agent (CLI) | 后端 —— 桌宠所有"思考"与"输出"的真正来源 |
| 桌宠 | 前端 —— Hermes Agent 的脸和手 |

## 已经定下来的核心决策（速查）

- **形象**：戴 Hermes 翅膀头盔的小机器人，大头小身
- **模式**：普通 / 工作 两种，手动切换（默认 `⌘⇧H`）
- **模式指示**：头盔左翅亮金色 = 普通；右翅亮蓝色 = 工作
- **工作模式**：藏在屏幕右上角，露半个头 + 单侧翅膀，hover 浮出三气泡（research / 对话 / cowork）
- **普通模式**：全身可见，原地转圈扭头，每分钟 idle，无操作久了 zzz 睡，可摸头
- **技术栈**：Tauri 2.10.3 + React 19.1 + TS 5.8 + Vite 7 + Rust 1.95.0 stable
- **后端接入**：每次气泡提交 spawn 一次 `hermes chat -Q --accept-hooks -q "..."`；`--source tool` 因性能异常 V1 暂缓
- **三气泡**：同入口 + 不同 system prompt + 是否带 `-r <session_id>` 区分
- **上下文持久化**：完全交给 Hermes（桌宠只存 session_id）
- **平台**：macOS only（V1），不做多屏

## 待 spike 验证（写代码中要回收）

按 `docs/tech.md` §10：

1. macOS 透明窗口 + 鼠标穿透 + always-on-top（Tauri 2 兼容性）
2. `hermes chat -Q -q` 的 stdout 流式特性（✅ 2026-04-29 已验通：按行读取可用）
3. `-Q` 模式下 session_id 输出位置（✅ 2026-04-29 已验通：可能在 stderr）
4. 多 hermes 子进程并发（SQLite session store 锁）
5. macOS 拖放 API 兼容性
