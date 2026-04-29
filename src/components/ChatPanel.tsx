// 流 B 端到端 demo 用：临时挂在桌宠下方的对话面板。
// 阶段三会被三气泡 UI 取代，但运行时核心（hermes_start_chat / 事件订阅）
// 沿用本组件验证的协议。
//
// 协议契约（与 src-tauri/src/runner.rs 对齐）：
//   invoke('hermes_discover')              -> { ok, path }
//   invoke('hermes_start_chat', {args})    -> { task_id }
//   invoke('hermes_cancel', { taskId })
//   listen('hermes-session', payload)      -> { task_id, session_id }
//   listen('hermes-chunk',   payload)      -> { task_id, line }
//   listen('hermes-done',    payload)      -> { task_id, exit_code }
//   listen('hermes-error',   payload)      -> { task_id, message }
//
// 多轮会话：第一次 invoke 不带 session_id；事件 hermes-session 拿到
// id 后存到 state，下一轮 invoke 自动带上 -r。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { updateHitRegion } from "../hitRegions";
import "./ChatPanel.css";

interface DiscoverResult {
  ok: boolean;
  path: string | null;
}

interface StartChatResult {
  task_id: string;
}

interface ChunkPayload {
  task_id: string;
  line: string;
}

interface SessionPayload {
  task_id: string;
  session_id: string;
}

interface DonePayload {
  task_id: string;
  exit_code: number;
}

interface ErrorPayload {
  task_id: string;
  message: string;
}

type MsgRole = "user" | "assistant" | "system" | "error";
interface Msg {
  id: string;
  role: MsgRole;
  text: string;
  pending?: boolean;
}

// 调试用：当前正在跑的任务的实时进度
interface BusyDebug {
  taskId: string;
  startedAt: number; // performance.now()
  sessionAt: number | null;
  firstChunkAt: number | null;
  chunkCount: number;
  lastEvent: string;
}

export default function ChatPanel() {
  const [hermesPath, setHermesPath] = useState<string | null>(null);
  const [hermesOk, setHermesOk] = useState<boolean | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [busyDebug, setBusyDebug] = useState<BusyDebug | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // 强制每秒重渲染跑表

  const panelRef = useRef<HTMLDivElement | null>(null);

  // 当前正在累积的 assistant message id（用于流式追加 chunk）
  const currentMsgIdRef = useRef<string | null>(null);
  const busyTaskIdRef = useRef<string | null>(null);
  const busyDebugRef = useRef<BusyDebug | null>(null);
  busyTaskIdRef.current = busyTaskId;
  busyDebugRef.current = busyDebug;

  // 跑表：busy 时每 250ms 重渲染
  useEffect(() => {
    if (!busyTaskId) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, [busyTaskId]);

  useEffect(() => {
    const syncPanelRegion = () => {
      const el = panelRef.current;
      if (!el) {
        updateHitRegion("chat-panel", null);
        return;
      }

      const rect = el.getBoundingClientRect();
      updateHitRegion("chat-panel", {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };

    syncPanelRegion();
    window.addEventListener("resize", syncPanelRegion);

    const resizeObserver = new ResizeObserver(syncPanelRegion);
    if (panelRef.current) {
      resizeObserver.observe(panelRef.current);
    }

    return () => {
      window.removeEventListener("resize", syncPanelRegion);
      resizeObserver.disconnect();
      updateHitRegion("chat-panel", null);
    };
  }, []);

  // 输出区滚动到底
  const outputRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [msgs]);

  // 启动时探测 hermes
  useEffect(() => {
    invoke<DiscoverResult>("hermes_discover")
      .then((r) => {
        setHermesOk(r.ok);
        setHermesPath(r.path);
      })
      .catch((e) => {
        setHermesOk(false);
        setMsgs((m) => [
          ...m,
          { id: rid(), role: "error", text: `discover 失败: ${e}` },
        ]);
      });
  }, []);

  // 全局事件订阅
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      let u1: UnlistenFn;
      let u2: UnlistenFn;
      let u3: UnlistenFn;
      let u4: UnlistenFn;

      try {
        u1 = await listen<SessionPayload>("hermes-session", (e) => {
          console.log("[chat] session", e.payload);
          if (e.payload.task_id !== busyTaskIdRef.current) return;
          setSessionId(e.payload.session_id);
          if (busyDebugRef.current) {
            setBusyDebug({
              ...busyDebugRef.current,
              sessionAt: performance.now(),
              lastEvent: "session",
            });
          }
        });
        u2 = await listen<ChunkPayload>("hermes-chunk", (e) => {
          console.log("[chat] chunk", e.payload);
          if (e.payload.task_id !== busyTaskIdRef.current) return;
          appendChunk(e.payload.line);
          if (busyDebugRef.current) {
            setBusyDebug({
              ...busyDebugRef.current,
              firstChunkAt:
                busyDebugRef.current.firstChunkAt ?? performance.now(),
              chunkCount: busyDebugRef.current.chunkCount + 1,
              lastEvent: "chunk",
            });
          }
        });
        u3 = await listen<DonePayload>("hermes-done", (e) => {
          console.log("[chat] done", e.payload);
          if (e.payload.task_id !== busyTaskIdRef.current) return;
          finishCurrentMsg(e.payload.exit_code);
          setBusyTaskId(null);
          setBusyDebug(null);
        });
        u4 = await listen<ErrorPayload>("hermes-error", (e) => {
          console.log("[chat] error", e.payload);
          if (e.payload.task_id !== busyTaskIdRef.current) return;
          setMsgs((m) => [
            ...m,
            { id: rid(), role: "error", text: e.payload.message },
          ]);
          if (busyDebugRef.current) {
            setBusyDebug({
              ...busyDebugRef.current,
              lastEvent: "error",
            });
          }
        });
      } catch (e) {
        console.warn("[chat] listener setup failed", e);
        setListenerError(String(e));
        return;
      }

      // 如果 effect 已经被 cleanup（StrictMode dev 双跑），立刻反注册避免泄漏
      if (cancelled) {
        u1();
        u2();
        u3();
        u4();
        return;
      }
      unlisteners.push(u1, u2, u3, u4);
      setListenerError(null);
      setListenersReady(true);
      console.log("[chat] all 4 listeners registered");
    };
    setup();

    return () => {
      cancelled = true;
      setListenersReady(false);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  function appendChunk(line: string) {
    setMsgs((m) => {
      const next = [...m];
      // 找到当前 pending 的 assistant 消息追加
      const idx = next.findIndex(
        (x) => x.id === currentMsgIdRef.current && x.role === "assistant"
      );
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          text: next[idx].text ? next[idx].text + "\n" + line : line,
        };
      }
      return next;
    });
  }

  function finishCurrentMsg(exitCode: number) {
    setMsgs((m) =>
      m.map((x) =>
        x.id === currentMsgIdRef.current ? { ...x, pending: false } : x
      )
    );
    if (exitCode !== 0) {
      setMsgs((m) => [
        ...m,
        {
          id: rid(),
          role: "system",
          text: `（hermes 退出码 ${exitCode}）`,
        },
      ]);
    }
    currentMsgIdRef.current = null;
  }

  async function send() {
    const text = input.trim();
    if (!text || busyTaskId) return;
    if (!hermesOk) {
      setMsgs((m) => [
        ...m,
        { id: rid(), role: "error", text: "hermes 二进制未找到，无法发送。" },
      ]);
      return;
    }
    if (!listenersReady) {
      setMsgs((m) => [
        ...m,
        {
          id: rid(),
          role: "error",
          text: listenerError
            ? `事件监听启动失败: ${listenerError}`
            : "事件监听尚未就绪，请稍后再试。",
        },
      ]);
      return;
    }
    setInput("");

    // 用户气泡 + 等待中的 assistant 占位
    const userMsg: Msg = { id: rid(), role: "user", text };
    const asstMsg: Msg = { id: rid(), role: "assistant", text: "", pending: true };
    const taskId = rid();
    const debug: BusyDebug = {
      taskId,
      startedAt: performance.now(),
      sessionAt: null,
      firstChunkAt: null,
      chunkCount: 0,
      lastEvent: "starting",
    };
    currentMsgIdRef.current = asstMsg.id;
    busyTaskIdRef.current = taskId;
    busyDebugRef.current = debug;
    setMsgs((m) => [...m, userMsg, asstMsg]);
    setBusyTaskId(taskId);
    setBusyDebug(debug);

    try {
      const r = await invoke<StartChatResult>("hermes_start_chat", {
        args: {
          text,
          task_id: taskId,
          session_id: sessionId,
          system_prompt: null,
        },
      });
      console.log("[chat] start_chat ok", r);
      setBusyDebug((d) =>
        d && d.taskId === r.task_id ? { ...d, lastEvent: "started" } : d
      );
    } catch (e) {
      console.warn("[chat] start_chat failed", e);
      setMsgs((m) => [
        ...m,
        { id: rid(), role: "error", text: `start_chat 失败: ${e}` },
      ]);
      busyTaskIdRef.current = null;
      busyDebugRef.current = null;
      setBusyTaskId(null);
      setBusyDebug(null);
      currentMsgIdRef.current = null;
    }
  }

  async function cancel() {
    if (!busyTaskId) return;
    try {
      await invoke("hermes_cancel", { taskId: busyTaskId });
    } catch (e) {
      console.warn("cancel failed:", e);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  }

  function onClear() {
    setMsgs([]);
    setSessionId(null); // 开新 session
    currentMsgIdRef.current = null;
  }

  return (
    <div className="chat-panel" ref={panelRef}>
      <div className="chat-header">
        <span className="chat-title">Hermes 对话（流 B 临时面板）</span>
        <span
          className={
            "chat-badge " +
            (hermesOk === null ? "neutral" : hermesOk ? "ok" : "bad")
          }
          title={hermesPath ?? ""}
        >
          {hermesOk === null
            ? "探测中…"
            : hermesOk
            ? `已就绪 · ${shortPath(hermesPath)}`
            : "未找到 hermes"}
        </span>
        <span className="chat-session" title={sessionId ?? ""}>
          {sessionId ? `session: ${sessionId.slice(-8)}` : "新会话"}
        </span>
        <span className="chat-session">
          {listenerError
            ? "events: error"
            : listenersReady
            ? "events: ok"
            : "events: ..."}
        </span>
        <button className="chat-clear" onClick={onClear} disabled={!!busyTaskId}>
          清空
        </button>
      </div>
      <div className="chat-output" ref={outputRef}>
        {msgs.length === 0 && (
          <div className="chat-empty">输入问题，回车发送。Shift+Enter 换行。</div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={"chat-msg role-" + m.role}>
            <div className="chat-msg-role">
              {labelOf(m.role)}
              {m.pending && <span className="chat-dots"> ●●●</span>}
            </div>
            <div className="chat-msg-text">{m.text || (m.pending ? "…" : "")}</div>
            {m.pending && busyDebug && m.id === currentMsgIdRef.current && (
              <div className="chat-debug">
                {renderBusyDebug(busyDebug, tick)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            busyTaskId
              ? "正在等待回复…"
              : "输入问题（回车发送，Shift+Enter 换行）"
          }
          rows={2}
        />
        {busyTaskId ? (
          <button className="chat-btn cancel" onClick={cancel}>
            停止
          </button>
        ) : (
          <button
            className="chat-btn send"
            onClick={send}
            disabled={!input.trim() || hermesOk === false || !listenersReady}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

function labelOf(role: MsgRole): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "Hermes";
    case "system":
      return "系统";
    case "error":
      return "错误";
  }
}

function shortPath(p: string | null): string {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) return "~" + rest.slice(slash);
  }
  return p;
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function renderBusyDebug(d: BusyDebug, _tick: number): string {
  // _tick 仅用于触发父组件重渲染，函数内不直接用
  void _tick;
  const now = performance.now();
  const elapsed = ((now - d.startedAt) / 1000).toFixed(1);
  const sessionPart =
    d.sessionAt != null
      ? `session ${((d.sessionAt - d.startedAt) / 1000).toFixed(1)}s`
      : "session ?";
  const firstChunkPart =
    d.firstChunkAt != null
      ? `首块 ${((d.firstChunkAt - d.startedAt) / 1000).toFixed(1)}s`
      : "首块未到";
  return `已等待 ${elapsed}s · ${sessionPart} · ${firstChunkPart} · 收到 ${d.chunkCount} 行 · last=${d.lastEvent}`;
}
