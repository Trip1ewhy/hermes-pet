// BubbleStack —— 工作模式三气泡的容器。
//
// 布局（V1）：
//   - 渲染在 PetCircle 左侧
//   - 默认收起：竖向三个小圆点（每个气泡 16px），用户能看到入口存在
//   - hover 桌宠区域 / 气泡区域 → 三个入口展开成药丸状（带输入框）
//   - 某个输入被选中 / 浮窗打开后，只保留当前入口，其它入口收起
//   - 当前入口移动到 stack 顶部，浮窗贴在它下方
//
// 三个气泡顺序（从上到下）：research / dialog / cowork
//
// hit region：
//   - 收起态：上报『trigger 矩形』（覆盖桌宠左侧 + 三个小点）
//   - hover 展开态：上报三入口完整矩形
//   - 单入口激活态：上报当前入口矩形 + 浮窗矩形
//   每次状态变更通过 updateHitRegion 写入，rAF 合并 invoke。
//
// 不在这里做的：
//   - Markdown 渲染（V1 纯文本流）
//   - 图片 / 富文本拖入（V1 先只接文件路径）
//   - 角色 SVG 替换（先借 PetCircle 占位）

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { updateHitRegion } from "../hitRegions";
import { useHermesTask, type TaskStatus } from "../hooks/useHermesTask";
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
  /** 任一气泡等待 / 接收 Hermes 输出时，上报给桌宠本体做表情反馈 */
  onWaitingOutputChange?: (kind: BubbleKind, waiting: boolean) => void;
}

const STACK_WIDTH_COLLAPSED = 24; // 收起态：仅小圆点的列宽
const STACK_WIDTH_EXPANDED = 280; // 展开态：药丸宽度
const STACK_GAP = 12; // 气泡到桌宠的水平间距
const BUBBLE_HEIGHT = 40; // 单个气泡（药丸）高度
const BUBBLE_GAP = 8; // 气泡之间垂直间距
const POPOVER_GAP = 8;
const POPOVER_WIDTH = STACK_WIDTH_EXPANDED; // 下方浮窗宽度跟上方选中输入保持一致
const POPOVER_MAX_HEIGHT = 320;
const FILE_CHIP_STRIP_HEIGHT = 36;

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

interface BubbleSession {
  id: string;
  title: string;
  sessionId: string | null;
  messages: ConversationMessage[];
  output: string;
  status: TaskStatus;
  errorMessage: string | null;
  unread: boolean;
}

interface DropRequest {
  id: string;
  kind: BubbleKind;
  paths: string[];
}

type DragDropPosition = {
  x: number;
  y: number;
};

type TauriDragDropPayload =
  | { type: "enter"; paths: string[]; position: DragDropPosition }
  | { type: "over"; position: DragDropPosition }
  | { type: "drop"; paths: string[]; position: DragDropPosition }
  | { type: "leave" };

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

function createLocalId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random()}`;
}

function createBubbleSession(index: number): BubbleSession {
  return {
    id: createLocalId("session"),
    title: `Session ${index}`,
    sessionId: null,
    messages: [],
    output: "",
    status: "idle",
    errorMessage: null,
    unread: false,
  };
}

function titleFromText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled";
  return normalized.length > 14 ? `${normalized.slice(0, 14)}...` : normalized;
}

function normalizeDragPosition(position: DragDropPosition): DragDropPosition {
  const dpr = window.devicePixelRatio || 1;
  const looksPhysical =
    dpr > 1 && (position.x > window.innerWidth || position.y > window.innerHeight);

  return looksPhysical
    ? { x: position.x / dpr, y: position.y / dpr }
    : position;
}

function formatDroppedPaths(paths: string[]): string {
  return paths.map((path) => `@${path}`).join("\n");
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export default function BubbleStack({
  petPos,
  petSize,
  onWaitingOutputChange,
}: BubbleStackProps) {
  const [hovered, setHovered] = useState(false);
  // 当前打开浮窗的气泡（最多一个）。null = 都没开
  const [openPopover, setOpenPopover] = useState<BubbleKind | null>(null);
  // 当前被用户选中的输入气泡。选中后只显示这一条，其它 hover 入口收起。
  const [activeKind, setActiveKind] = useState<BubbleKind | null>(null);
  const [dragTargetKind, setDragTargetKind] = useState<BubbleKind | null>(null);
  const [dropRequest, setDropRequest] = useState<DropRequest | null>(null);
  const [droppedPathsByBubble, setDroppedPathsByBubble] = useState<Record<BubbleKind, string[]>>({
    research: [],
    dialog: [],
    cowork: [],
  });
  const dragTargetKindRef = useRef<BubbleKind | null>(null);

  // stack 是否处于"展开态"（hover OR 已选中某个输入 / 浮窗打开）
  const expanded = hovered || activeKind !== null || dragTargetKind !== null;
  const activeOnly = activeKind !== null;

  // stack 整体位置：桌宠左侧
  const stackWidth = expanded ? STACK_WIDTH_EXPANDED : STACK_WIDTH_COLLAPSED;
  const fullStackHeight =
    BUBBLE_HEIGHT * BUBBLES.length + BUBBLE_GAP * (BUBBLES.length - 1);
  const activeFileChipHeight =
    activeKind && droppedPathsByBubble[activeKind].length > 0
      ? FILE_CHIP_STRIP_HEIGHT
      : 0;
  const stackHeight = activeOnly
    ? BUBBLE_HEIGHT + activeFileChipHeight
    : fullStackHeight;
  const stackX = petPos.x - STACK_GAP - stackWidth;
  const stackY = petPos.y + (petSize - fullStackHeight) / 2;

  useEffect(() => {
    dragTargetKindRef.current = dragTargetKind;
  }, [dragTargetKind]);

  const getDropTargetKind = useCallback(
    (position: DragDropPosition): BubbleKind | null => {
      const { x, y } = normalizeDragPosition(position);
      const expandedStackX = petPos.x - STACK_GAP - STACK_WIDTH_EXPANDED;
      const collapsedStackX = petPos.x - STACK_GAP - STACK_WIDTH_COLLAPSED;
      const insideExpandedStackX =
        x >= expandedStackX && x <= expandedStackX + STACK_WIDTH_EXPANDED;
      const insideCollapsedStackX =
        x >= collapsedStackX && x <= collapsedStackX + STACK_WIDTH_COLLAPSED;

      for (const [idx, cfg] of BUBBLES.entries()) {
        const top = stackY + idx * (BUBBLE_HEIGHT + BUBBLE_GAP);
        const insideY = y >= top && y <= top + BUBBLE_HEIGHT;
        if (insideY && (insideExpandedStackX || insideCollapsedStackX)) {
          return cfg.kind;
        }
      }

      const insidePet =
        x >= petPos.x &&
        x <= petPos.x + petSize &&
        y >= petPos.y &&
        y <= petPos.y + petSize;
      return insidePet ? "dialog" : null;
    },
    [petPos.x, petPos.y, petSize, stackY],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload as TauriDragDropPayload;

        if (payload.type === "leave") {
          setDragTargetKind(null);
          return;
        }

        const nextKind = getDropTargetKind(payload.position);
        setDragTargetKind(nextKind);
        setHovered(nextKind !== null);

        if (payload.type !== "drop") return;

        const targetKind = nextKind ?? dragTargetKindRef.current;
        if (!targetKind || payload.paths.length === 0) {
          setDragTargetKind(null);
          return;
        }

        setDropRequest({
          id: createLocalId("drop"),
          kind: targetKind,
          paths: payload.paths,
        });
        setDroppedPathsByBubble((prev) => ({
          ...prev,
          [targetKind]: [...prev[targetKind], ...payload.paths],
        }));
        setOpenPopover(targetKind);
        setActiveKind(targetKind);
        setDragTargetKind(null);
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch((e) => {
        console.warn("drag/drop subscription failed:", e);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [getDropTargetKind]);

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
            visible={!activeOnly || activeKind === cfg.kind}
            popoverOpen={openPopover === cfg.kind}
            yOffset={
              activeOnly ? 0 : idx * (BUBBLE_HEIGHT + BUBBLE_GAP)
            }
            onPopoverToggle={(open) => {
              setOpenPopover(open ? cfg.kind : null);
              setActiveKind(open ? cfg.kind : null);
            }}
            onFocusChange={(focused) => {
              if (focused) {
                setOpenPopover(cfg.kind);
                setActiveKind(cfg.kind);
                return;
              }

              setActiveKind((current) => {
                if (openPopover === cfg.kind) return current;
                return current === cfg.kind ? null : current;
              });
            }}
            onWaitingOutputChange={onWaitingOutputChange}
            dropRequest={dropRequest}
            isDragTarget={dragTargetKind === cfg.kind}
            droppedFilePaths={droppedPathsByBubble[cfg.kind]}
            onDroppedFilePathsChange={(paths) => {
              setDroppedPathsByBubble((prev) => ({
                ...prev,
                [cfg.kind]: paths,
              }));
            }}
            // 浮窗位置基准：气泡所在的全局 y
            popoverAnchor={{
              left: activeOnly ? stackX : stackX + stackWidth + 8,
              top: activeOnly
                ? stackY +
                  BUBBLE_HEIGHT +
                  POPOVER_GAP +
                  (droppedPathsByBubble[cfg.kind].length > 0
                    ? FILE_CHIP_STRIP_HEIGHT
                    : 0)
                : stackY + idx * (BUBBLE_HEIGHT + BUBBLE_GAP),
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
  visible: boolean;
  popoverOpen: boolean;
  yOffset: number;
  popoverAnchor: { left: number; top: number };
  onPopoverToggle: (open: boolean) => void;
  onFocusChange: (focused: boolean) => void;
  onWaitingOutputChange?: (kind: BubbleKind, waiting: boolean) => void;
  dropRequest: DropRequest | null;
  isDragTarget: boolean;
  droppedFilePaths: string[];
  onDroppedFilePathsChange: (paths: string[]) => void;
}

function Bubble({
  cfg,
  expanded,
  visible,
  popoverOpen,
  yOffset,
  popoverAnchor,
  onPopoverToggle,
  onFocusChange,
  onWaitingOutputChange,
  dropRequest,
  isDragTarget,
  droppedFilePaths,
  onDroppedFilePathsChange,
}: BubbleProps) {
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<BubbleSession[]>(() => [
    createBubbleSession(1),
  ]);
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id);
  const [generationCollapsed, setGenerationCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverBodyRef = useRef<HTMLDivElement>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const lastDropRequestIdRef = useRef<string | null>(null);

  // 每个气泡一个独立的 task hook
  const task = useHermesTask();

  // running = starting 或 streaming
  const isRunning = task.status === "starting" || task.status === "streaming";
  const isWaitingForOutput = isRunning;
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  // 红点：done / error 时挂红点提示（直到用户打开浮窗看过）
  const hasUnreadResult = sessions.some((session) => session.unread);

  function resetTaskView(opts?: { keepSession?: boolean }) {
    currentAssistantMessageIdRef.current = null;
    runningSessionIdRef.current = null;
    task.reset(opts);
  }

  function handleNewSession() {
    if (isRunning) return;
    const next = createBubbleSession(sessions.length + 1);
    setSessions((prev) => [...prev, next]);
    setActiveSessionId(next.id);
    onDroppedFilePathsChange([]);
    setGenerationCollapsed(false);
    onPopoverToggle(true);
    resetTaskView();
  }

  function handleDeleteSession(sessionId: string) {
    if (isRunning) return;
    setSessions((prev) => {
      if (prev.length === 1) {
        const replacement = createBubbleSession(1);
        setActiveSessionId(replacement.id);
        resetTaskView();
        return [replacement];
      }

      const idx = prev.findIndex((session) => session.id === sessionId);
      const next = prev.filter((session) => session.id !== sessionId);
      if (sessionId === activeSessionId) {
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveSessionId(fallback.id);
        resetTaskView({ keepSession: false });
      }
      return next;
    });
  }

  function handleSelectSession(sessionId: string) {
    if (isRunning) return;
    setActiveSessionId(sessionId);
    setGenerationCollapsed(false);
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, unread: false } : session,
      ),
    );
    onPopoverToggle(true);
    resetTaskView({ keepSession: false });
  }

  // 提交
  function handleSubmit() {
    const text = input.trim();
    const fileText = formatDroppedPaths(droppedFilePaths);
    const submittedText = [text, fileText].filter(Boolean).join("\n");
    if (!submittedText || !activeSession) return;

    const sessionId = activeSession.id;
    runningSessionIdRef.current = sessionId;
    let assistantMessageId: string | null = null;
    if (cfg.multiTurn) {
      assistantMessageId = createLocalId("assistant");
      currentAssistantMessageIdRef.current = assistantMessageId;
    }

    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== sessionId) return session;
        const nextTitle = session.title.startsWith("Session ")
          ? titleFromText(text || fileNameFromPath(droppedFilePaths[0] ?? ""))
          : session.title;
        const nextMessages =
          cfg.multiTurn && assistantMessageId
            ? [
                ...session.messages,
                {
                  id: createLocalId("user"),
                  role: "user" as const,
                  content: submittedText,
                },
                {
                  id: assistantMessageId,
                  role: "assistant" as const,
                  content: "",
                },
              ]
            : session.messages;

        return {
          ...session,
          title: nextTitle,
          messages: nextMessages,
          output: "",
          status: "starting",
          errorMessage: null,
          unread: false,
        };
      }),
    );

    // dialog 多轮：第二轮起带 Hermes sessionId，不再带 systemPrompt
    const submitArgs = cfg.multiTurn && activeSession.sessionId
      ? { text: submittedText, sessionId: activeSession.sessionId }
      : { text: submittedText, systemPrompt: DEFAULT_SYSTEM_PROMPTS[cfg.kind] };

    task.submit(submitArgs);
    setInput("");
    onDroppedFilePathsChange([]);
    setGenerationCollapsed(false);

    // 三个任务提交后都打开浮窗，让用户能直接看到流式输出。
    onPopoverToggle(true);
  }

  // 点击气泡（非展开态时）→ 展开浮窗看历史
  // 点击气泡（展开态时）→ 切换浮窗
  function openBubbleView() {
    const unreadSession = sessions.find((session) => session.unread);
    if (unreadSession) {
      setActiveSessionId(unreadSession.id);
    }
    setGenerationCollapsed(false);
    onPopoverToggle(true);
  }

  function handleBubbleClick() {
    const nextOpen = !popoverOpen;
    if (nextOpen) {
      openBubbleView();
      return;
    }
    onPopoverToggle(nextOpen);
  }

  function handleCollapseGeneration() {
    setGenerationCollapsed(true);
    onPopoverToggle(false);
  }

  function handleExpandGeneration() {
    setGenerationCollapsed(false);
    onPopoverToggle(true);
  }

  // 浮窗 hit region
  useEffect(() => {
    if (!popoverOpen) {
      updateHitRegion(`popover-${cfg.kind}`, null);
      return;
    }
    // 展开 icon 收起态只保留一个很小的 hit region。
    updateHitRegion(`popover-${cfg.kind}`, {
      x: popoverAnchor.left,
      y: popoverAnchor.top,
      width: POPOVER_WIDTH,
      height: generationCollapsed ? 32 : POPOVER_MAX_HEIGHT,
    });
    return () => updateHitRegion(`popover-${cfg.kind}`, null);
  }, [popoverOpen, popoverAnchor.left, popoverAnchor.top, cfg.kind, generationCollapsed]);

  // 浮窗打开后自动聚焦输入框（dialog 体验）
  useEffect(() => {
    if (popoverOpen && cfg.multiTurn) {
      inputRef.current?.focus();
    }
  }, [popoverOpen, cfg.multiTurn]);

  // 将 useHermesTask 的单任务输出同步回当前运行的本地 session tab。
  useEffect(() => {
    const targetSessionId = runningSessionIdRef.current;
    if (!targetSessionId) return;
    const assistantMessageId = currentAssistantMessageIdRef.current;
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== targetSessionId) return session;
        const messages =
          cfg.multiTurn && assistantMessageId
            ? session.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, content: task.output }
                  : message,
              )
            : session.messages;

        return {
          ...session,
          output: task.output,
          messages,
          sessionId: task.sessionId ?? session.sessionId,
          status: task.status,
          errorMessage: task.errorMessage,
        };
      }),
    );
  }, [cfg.multiTurn, task.output, task.sessionId, task.status, task.errorMessage]);

  useEffect(() => {
    const targetSessionId = runningSessionIdRef.current;
    if (!targetSessionId) return;
    if (task.status === "done" || task.status === "error") {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === targetSessionId
            ? { ...session, unread: !popoverOpen || activeSessionId !== targetSessionId }
            : session,
        ),
      );
    }
    if (task.status === "done" || task.status === "error" || task.status === "cancelled") {
      currentAssistantMessageIdRef.current = null;
      runningSessionIdRef.current = null;
    }
  }, [activeSessionId, popoverOpen, task.status]);

  useEffect(() => {
    if (!popoverOpen) return;
    setSessions((prev) =>
      prev.map((session) =>
        session.id === activeSessionId && session.unread
          ? { ...session, unread: false }
          : session,
      ),
    );
  }, [activeSessionId, popoverOpen]);

  useEffect(() => {
    onWaitingOutputChange?.(cfg.kind, isWaitingForOutput);
    return () => onWaitingOutputChange?.(cfg.kind, false);
  }, [cfg.kind, isWaitingForOutput, onWaitingOutputChange]);

  useEffect(() => {
    if (!popoverOpen || !cfg.multiTurn) return;
    const body = popoverBodyRef.current;
    body?.scrollTo({ top: body.scrollHeight });
  }, [popoverOpen, cfg.multiTurn, activeSession?.messages, activeSession?.output]);

  useEffect(() => {
    if (!dropRequest || dropRequest.kind !== cfg.kind || isRunning) return;
    if (lastDropRequestIdRef.current === dropRequest.id) return;
    lastDropRequestIdRef.current = dropRequest.id;

    setGenerationCollapsed(false);
    onFocusChange(true);
    onPopoverToggle(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [cfg.kind, dropRequest, isRunning, onFocusChange, onPopoverToggle]);

  // 状态色（V1 简化：idle 灰 / running 红 / done 绿 / error 红）
  const dotColor = useMemo(() => {
    if (isRunning) return "#E94B4B"; // 红脸
    if (activeSession?.status === "error") return "#E94B4B";
    if (activeSession?.status === "done") return "#4FB477"; // 绿色提示
    return "#9AA0A6";
  }, [activeSession?.status, isRunning]);

  return (
    <>
      {/* 收起态：小圆点 */}
      {visible && !expanded && (
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
      {visible && expanded && (
        <div
          className={`bubble-pill${isRunning ? " is-running" : ""}${isDragTarget ? " is-drag-target" : ""}`}
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
            onFocus={openBubbleView}
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
            <>
              <button
                className="bubble-pill-toggle"
                onClick={
                  generationCollapsed
                    ? handleExpandGeneration
                    : handleCollapseGeneration
                }
                title={generationCollapsed ? "展开生成过程" : "收起生成过程"}
              >
                {generationCollapsed ? "▴" : "▾"}
              </button>
              <button
                className="bubble-pill-cancel"
                onClick={() => task.cancel()}
                title="取消"
              >
                ×
              </button>
            </>
          )}
        </div>
      )}

      {visible && expanded && droppedFilePaths.length > 0 && (
        <div
          className="bubble-file-chips"
          style={{ top: yOffset + BUBBLE_HEIGHT + 6 }}
        >
          {droppedFilePaths.map((path, index) => (
            <button
              key={`${path}-${index}`}
              className="bubble-file-chip"
              onClick={() => {
                onDroppedFilePathsChange(
                  droppedFilePaths.filter((_, idx) => idx !== index),
                );
              }}
              title={path}
              type="button"
              disabled={isRunning}
            >
              <span className="bubble-file-chip-name">
                {fileNameFromPath(path)}
              </span>
              <span className="bubble-file-chip-remove">×</span>
            </button>
          ))}
        </div>
      )}

      {/* 结果浮窗 */}
      {visible && popoverOpen && !generationCollapsed && (
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
              {activeSession?.status === "idle" && "等待输入"}
              {activeSession?.status === "starting" && "启动中…"}
              {activeSession?.status === "streaming" && "运行中…"}
              {activeSession?.status === "done" && "完成"}
              {activeSession?.status === "error" && "出错"}
              {activeSession?.status === "cancelled" && "已取消"}
            </span>
            <button
              className="bubble-popover-close"
              onClick={() => {
                onPopoverToggle(false);
              }}
              title="关闭"
            >
              ×
            </button>
          </div>
          <div className="bubble-session-tabs">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`bubble-session-tab${session.id === activeSessionId ? " is-active" : ""}${session.unread ? " has-unread" : ""}`}
                onClick={() => handleSelectSession(session.id)}
                disabled={isRunning}
                title={session.title}
              >
                <span className="bubble-session-tab-title">
                  {session.title}
                </span>
                <span
                  className="bubble-session-tab-delete"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSession(session.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDeleteSession(session.id);
                    }
                  }}
                  aria-label={`删除 ${session.title}`}
                  aria-disabled={isRunning}
                >
                  ×
                </span>
              </button>
            ))}
            <button
              className="bubble-session-new"
              onClick={handleNewSession}
              disabled={isRunning}
              title="新建 session"
            >
              +
            </button>
          </div>
          <div
            ref={popoverBodyRef}
            className={`bubble-popover-body${cfg.multiTurn ? " is-conversation" : ""}`}
          >
            {cfg.multiTurn ? (
              activeSession?.messages.length ? (
                <div className="conversation-list">
                  {activeSession.messages.map((message) => (
                    <div
                      key={message.id}
                      className={`conversation-row is-${message.role}`}
                    >
                      <div className="conversation-message">
                        {message.content || (
                          <span className="conversation-message-pending">
                            {isRunning && runningSessionIdRef.current === activeSessionId
                              ? "Hermes 正在想…"
                              : "没有收到回复。"}
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
            ) : activeSession?.output || (
              <span className="bubble-popover-empty">
                {activeSession?.status === "idle"
                  ? "在上方输入框里发条消息开始。"
                  : "等待输出…"}
              </span>
            )}
            {activeSession?.errorMessage && (
              <div className="bubble-popover-error">
                {activeSession.errorMessage}
              </div>
            )}
          </div>
          {activeSession?.sessionId && cfg.multiTurn && (
            <div className="bubble-popover-footer">
              session: <code>{activeSession.sessionId.slice(0, 8)}…</code>
            </div>
          )}
        </div>
      )}
    </>
  );
}
