// BubbleStack —— 工作模式三气泡的容器。
//
// 布局（V1）：
//   - 渲染在 PetCircle 左侧
//   - 默认收起：竖向三个小圆点（每个气泡 16px），用户能看到入口存在
//   - hover 桌宠区域 / 气泡区域 → 整个 stack 展开成药丸状（带输入框）
//   - 鼠标离开 trigger 区域 + 没有正在跑的任务 + 没有打开的浮窗 → 收回
//
// 三个气泡顺序（从上到下）：research / dialog / cowork
//
// hit region：
//   - 收起态：上报『trigger 矩形』（覆盖桌宠左侧 + 三个小点）
//   - 展开态：上报展开后的完整矩形 + 浮窗矩形
//   每次状态变更通过 updateHitRegion 写入，rAF 合并 invoke。
//
// 不在这里做的：
//   - Markdown 渲染（V1 纯文本流）
//   - 拖入文件（流 C）
//   - 角色 SVG 替换（先借 PetCircle 占位）

import { useEffect, useMemo, useRef, useState } from "react";
import { updateHitRegion } from "../hitRegions";
import { useHermesTask } from "../hooks/useHermesTask";
import {
  DEFAULT_SYSTEM_PROMPTS,
  type BubbleKind,
} from "../lib/prompts";
import "./BubbleStack.css";

interface BubbleStackProps {
  /** 桌宠当前位置（左上角，CSS px） */
  petPos: { x: number; y: number };
  /** 桌宠尺寸 */
  petSize: number;
}

const STACK_WIDTH_COLLAPSED = 24; // 收起态：仅小圆点的列宽
const STACK_WIDTH_EXPANDED = 280; // 展开态：药丸宽度
const STACK_GAP = 12; // 气泡到桌宠的水平间距
const BUBBLE_HEIGHT = 40; // 单个气泡（药丸）高度
const BUBBLE_GAP = 8; // 气泡之间垂直间距
const POPOVER_WIDTH = 380;
const POPOVER_MAX_HEIGHT = 320;

interface BubbleConfig {
  kind: BubbleKind;
  label: string;
  placeholder: string;
  /** 是否多轮续接（dialog = true） */
  multiTurn: boolean;
}

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const BUBBLES: BubbleConfig[] = [
  {
    kind: "research",
    label: "research",
    placeholder: "研究主题…",
    multiTurn: false,
  },
  {
    kind: "dialog",
    label: "对话",
    placeholder: "说点什么…",
    multiTurn: true,
  },
  {
    kind: "cowork",
    label: "cowork",
    placeholder: "交个任务…",
    multiTurn: false,
  },
];

export default function BubbleStack({ petPos, petSize }: BubbleStackProps) {
  const [hovered, setHovered] = useState(false);
  // 当前打开浮窗的气泡（最多一个）。null = 都没开
  const [openPopover, setOpenPopover] = useState<BubbleKind | null>(null);

  // stack 是否处于"展开态"（hover OR 任意浮窗打开 OR 任意输入框聚焦）
  const [hasFocus, setHasFocus] = useState(false);
  const expanded = hovered || openPopover !== null || hasFocus;

  // stack 整体位置：桌宠左侧
  const stackWidth = expanded ? STACK_WIDTH_EXPANDED : STACK_WIDTH_COLLAPSED;
  const stackHeight =
    BUBBLE_HEIGHT * BUBBLES.length + BUBBLE_GAP * (BUBBLES.length - 1);
  const stackX = petPos.x - STACK_GAP - stackWidth;
  const stackY = petPos.y + (petSize - stackHeight) / 2;

  // ---- hit region 上报 ----
  useEffect(() => {
    updateHitRegion("bubble-stack", {
      x: stackX,
      y: stackY,
      width: stackWidth,
      height: stackHeight,
    });
    return () => updateHitRegion("bubble-stack", null);
  }, [stackX, stackY, stackWidth, stackHeight]);

  return (
    <>
      <div
        className={`bubble-stack${expanded ? " is-expanded" : ""}`}
        style={{
          left: stackX,
          top: stackY,
          width: stackWidth,
          height: stackHeight,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {BUBBLES.map((cfg, idx) => (
          <Bubble
            key={cfg.kind}
            cfg={cfg}
            expanded={expanded}
            popoverOpen={openPopover === cfg.kind}
            yOffset={idx * (BUBBLE_HEIGHT + BUBBLE_GAP)}
            onPopoverToggle={(open) =>
              setOpenPopover(open ? cfg.kind : null)
            }
            onFocusChange={setHasFocus}
            // 浮窗位置基准：气泡所在的全局 y
            popoverAnchor={{
              left: stackX + stackWidth + 8,
              top: stackY + idx * (BUBBLE_HEIGHT + BUBBLE_GAP),
            }}
          />
        ))}
      </div>
    </>
  );
}

// =============================================================
// 单个气泡 + 它自己的浮窗
// =============================================================
interface BubbleProps {
  cfg: BubbleConfig;
  expanded: boolean;
  popoverOpen: boolean;
  yOffset: number;
  popoverAnchor: { left: number; top: number };
  onPopoverToggle: (open: boolean) => void;
  onFocusChange: (focused: boolean) => void;
}

function Bubble({
  cfg,
  expanded,
  popoverOpen,
  yOffset,
  popoverAnchor,
  onPopoverToggle,
  onFocusChange,
}: BubbleProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverBodyRef = useRef<HTMLDivElement>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);

  // 每个气泡一个独立的 task hook
  const task = useHermesTask();

  // running = starting 或 streaming
  const isRunning = task.status === "starting" || task.status === "streaming";

  // 红点：done / error 时挂红点提示（直到用户打开浮窗看过）
  const hasUnreadResult =
    !popoverOpen && (task.status === "done" || task.status === "error");

  // 提交
  function handleSubmit() {
    const text = input.trim();
    if (!text) return;

    if (cfg.multiTurn) {
      const assistantMessageId = globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}`;
      currentAssistantMessageIdRef.current = assistantMessageId;
      setMessages((prev) => [
        ...prev,
        {
          id: globalThis.crypto?.randomUUID?.() ?? `user-${Date.now()}`,
          role: "user",
          content: text,
        },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
        },
      ]);
    }

    // dialog 多轮：第二轮起带 sessionId，不再带 systemPrompt
    const submitArgs = cfg.multiTurn && task.sessionId
      ? { text, sessionId: task.sessionId }
      : { text, systemPrompt: DEFAULT_SYSTEM_PROMPTS[cfg.kind] };

    task.submit(submitArgs);
    setInput("");

    // 三个任务提交后都打开浮窗，让用户能直接看到流式输出。
    onPopoverToggle(true);
  }

  // 点击气泡（非展开态时）→ 展开浮窗看历史
  // 点击气泡（展开态时）→ 切换浮窗
  function handleBubbleClick() {
    onPopoverToggle(!popoverOpen);
  }

  // 浮窗 hit region
  useEffect(() => {
    if (!popoverOpen) {
      updateHitRegion(`popover-${cfg.kind}`, null);
      return;
    }
    // 估算浮窗高度（取 max 即可，hit region 不需要精准）
    updateHitRegion(`popover-${cfg.kind}`, {
      x: popoverAnchor.left,
      y: popoverAnchor.top,
      width: POPOVER_WIDTH,
      height: POPOVER_MAX_HEIGHT,
    });
    return () => updateHitRegion(`popover-${cfg.kind}`, null);
  }, [popoverOpen, popoverAnchor.left, popoverAnchor.top, cfg.kind]);

  // 浮窗打开后自动聚焦输入框（dialog 体验）
  useEffect(() => {
    if (popoverOpen && cfg.multiTurn) {
      inputRef.current?.focus();
    }
  }, [popoverOpen, cfg.multiTurn]);

  // dialog 浮窗展示的是当前 session 的消息流：右侧用户问题，左侧 Hermes 回复。
  useEffect(() => {
    if (!cfg.multiTurn) return;
    const assistantMessageId = currentAssistantMessageIdRef.current;
    if (!assistantMessageId) return;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantMessageId
          ? { ...message, content: task.output }
          : message,
      ),
    );
  }, [cfg.multiTurn, task.output]);

  useEffect(() => {
    if (!cfg.multiTurn) return;
    if (task.status === "done" || task.status === "error" || task.status === "cancelled") {
      currentAssistantMessageIdRef.current = null;
    }
  }, [cfg.multiTurn, task.status]);

  useEffect(() => {
    if (!popoverOpen || !cfg.multiTurn) return;
    const body = popoverBodyRef.current;
    body?.scrollTo({ top: body.scrollHeight });
  }, [popoverOpen, cfg.multiTurn, messages, task.output]);

  // 状态色（V1 简化：idle 灰 / running 红 / done 绿 / error 红）
  const dotColor = useMemo(() => {
    if (isRunning) return "#E94B4B"; // 红脸
    if (task.status === "error") return "#E94B4B";
    if (task.status === "done") return "#4FB477"; // 绿色提示
    return "#9AA0A6";
  }, [isRunning, task.status]);

  return (
    <>
      {/* 收起态：小圆点 */}
      {!expanded && (
        <button
          className="bubble-dot"
          style={{
            top: yOffset + (BUBBLE_HEIGHT - 16) / 2,
            backgroundColor: dotColor,
          }}
          onClick={handleBubbleClick}
          title={cfg.label}
        >
          {hasUnreadResult && <span className="bubble-dot-badge" />}
        </button>
      )}

      {/* 展开态：药丸 */}
      {expanded && (
        <div
          className={`bubble-pill${isRunning ? " is-running" : ""}`}
          style={{ top: yOffset, height: BUBBLE_HEIGHT }}
        >
          <span
            className="bubble-pill-label"
            style={{ color: dotColor }}
            onClick={handleBubbleClick}
          >
            {cfg.label}
            {hasUnreadResult && <span className="bubble-pill-badge" />}
          </span>
          <input
            ref={inputRef}
            className="bubble-pill-input"
            type="text"
            placeholder={cfg.placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={isRunning}
          />
          {isRunning && (
            <button
              className="bubble-pill-cancel"
              onClick={() => task.cancel()}
              title="取消"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* 结果浮窗 */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          className="bubble-popover"
          style={{
            left: popoverAnchor.left,
            top: popoverAnchor.top,
            width: POPOVER_WIDTH,
            maxHeight: POPOVER_MAX_HEIGHT,
          }}
        >
          <div className="bubble-popover-header">
            <span className="bubble-popover-title">{cfg.label}</span>
            <span className="bubble-popover-status">
              {task.status === "idle" && "等待输入"}
              {task.status === "starting" && "启动中…"}
              {task.status === "streaming" && "运行中…"}
              {task.status === "done" && "完成"}
              {task.status === "error" && "出错"}
              {task.status === "cancelled" && "已取消"}
            </span>
            <button
              className="bubble-popover-close"
              onClick={() => {
                onPopoverToggle(false);
                if (cfg.multiTurn) {
                  // 对话气泡的 × = 完全重置
                  currentAssistantMessageIdRef.current = null;
                  setMessages([]);
                  task.reset();
                }
              }}
              title="关闭"
            >
              ×
            </button>
          </div>
          <div
            ref={popoverBodyRef}
            className={`bubble-popover-body${cfg.multiTurn ? " is-conversation" : ""}`}
          >
            {cfg.multiTurn ? (
              messages.length > 0 ? (
                <div className="conversation-list">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`conversation-row is-${message.role}`}
                    >
                      <div className="conversation-message">
                        {message.content || (
                          <span className="conversation-message-pending">
                            {isRunning ? "Hermes 正在想…" : "没有收到回复。"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="bubble-popover-empty">
                  在上方输入框里发条消息开始。
                </span>
              )
            ) : task.output || (
              <span className="bubble-popover-empty">
                {task.status === "idle"
                  ? "在上方输入框里发条消息开始。"
                  : "等待输出…"}
              </span>
            )}
            {task.errorMessage && (
              <div className="bubble-popover-error">
                {task.errorMessage}
              </div>
            )}
          </div>
          {task.sessionId && cfg.multiTurn && (
            <div className="bubble-popover-footer">
              session: <code>{task.sessionId.slice(0, 8)}…</code>
            </div>
          )}
        </div>
      )}
    </>
  );
}
