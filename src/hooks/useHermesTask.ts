// useHermesTask —— 三气泡共用的 Hermes 任务调度 hook。
//
// 历史背景：流 B 阶段做 ChatPanel 时，事件订阅 / 流式累积 / session_id 抓取
// 这套逻辑写在了组件里。三气泡上线后，三个气泡都要复用同一份协议，
// 所以提炼成 hook，组件层只关心 UI 状态。
//
// 协议依赖（详见 src-tauri/src/runner.rs 顶部注释）：
//   - invoke("hermes_start_chat", { args }) -> { task_id }
//   - invoke("hermes_cancel", { task_id })
//   - event "hermes-session" { task_id, session_id }
//   - event "hermes-chunk"   { task_id, line }
//   - event "hermes-done"    { task_id, exit_code }
//   - event "hermes-error"   { task_id, message }
//
// 关键约定：
//   1. system_prompt 由后端 runner 拼到用户输入前，前端直接传字段即可
//      （不要在前端用 composeQuery 再拼一遍，会重复）
//   2. 多轮续接时只在首次提交带 system_prompt；带了 session_id 后就不要再传，
//      避免污染 hermes 那边已经记住的上下文
//   3. 一次只跟踪「当前一个 task」—— 用户提交新一轮时，旧任务若仍在跑要先 cancel
//
// 不在这层做的事：
//   - Markdown 渲染（留给浮窗组件）
//   - 持久化（V1 完全靠 hermes session，桌宠端只内存存 session_id）
//   - 拖入文件（流 C）

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TaskStatus =
  | "idle" //  从未提交过 / 已经清空
  | "starting" //  invoke 已发出，未拿到 task_id
  | "streaming" //  正在收 chunk
  | "done" //  正常退出
  | "error" //  spawn 失败 / 进程异常退出
  | "cancelled"; //  用户主动 cancel

export interface SubmitArgs {
  /** 用户在气泡里输入的文本（不含 system prompt） */
  text: string;
  /** 仅在「首次提交」时传；续接（带 session_id）时不要传 */
  systemPrompt?: string;
  /** 多轮续接时传上一轮拿到的 session_id */
  sessionId?: string;
}

interface StartChatBackendArgs {
  text: string;
  task_id?: string;
  session_id?: string;
  system_prompt?: string;
}

interface StartChatResult {
  task_id: string;
}

interface SessionEventPayload {
  task_id: string;
  session_id: string;
}

interface ChunkEventPayload {
  task_id: string;
  line: string;
}

interface DoneEventPayload {
  task_id: string;
  exit_code: number | null;
}

interface ErrorEventPayload {
  task_id: string;
  message: string;
}

export interface UseHermesTaskState {
  status: TaskStatus;
  /** 当前 task 累积的所有 stdout 行（按到达顺序拼接，含换行） */
  output: string;
  /** 当前 task 的 session_id（首次到达后保存，供续接用） */
  sessionId: string | null;
  /** 当前 task_id（用于 cancel） */
  taskId: string | null;
  /** 错误信息 / 非 0 退出码描述 */
  errorMessage: string | null;
}

export interface UseHermesTaskApi extends UseHermesTaskState {
  /** 提交一轮新任务；若已有任务在跑会先 cancel */
  submit: (args: SubmitArgs) => Promise<void>;
  /** 主动取消当前任务 */
  cancel: () => Promise<void>;
  /** 重置到 idle 态（清空 output / status / 错误，但保留 sessionId 以便续接） */
  reset: (opts?: { keepSession?: boolean }) => void;
}

/**
 * useHermesTask —— 单任务生命周期管理。
 *
 * 一个 hook 实例 = 一个气泡的"当前任务槽"。三个气泡各自调一次 hook。
 */
export function useHermesTask(): UseHermesTaskApi {
  const [state, setState] = useState<UseHermesTaskState>({
    status: "idle",
    output: "",
    sessionId: null,
    taskId: null,
    errorMessage: null,
  });

  // 用 ref 持有当前 task_id，事件回调里靠它过滤"自己的事件"
  // （多个气泡同时跑时，所有气泡的事件都会走到所有 hook 实例）
  const currentTaskIdRef = useRef<string | null>(null);

  // ---- 事件订阅：组件挂载时建一次，卸载时清理 ----
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    async function subscribe() {
      const unSession = await listen<SessionEventPayload>(
        "hermes-session",
        (e) => {
          if (e.payload.task_id !== currentTaskIdRef.current) return;
          setState((s) => ({ ...s, sessionId: e.payload.session_id }));
        },
      );

      const unChunk = await listen<ChunkEventPayload>("hermes-chunk", (e) => {
        if (e.payload.task_id !== currentTaskIdRef.current) return;
        setState((s) => ({
          ...s,
          status: s.status === "starting" ? "streaming" : s.status,
          output: s.output + e.payload.line + "\n",
        }));
      });

      const unDone = await listen<DoneEventPayload>("hermes-done", (e) => {
        if (e.payload.task_id !== currentTaskIdRef.current) return;
        const code = e.payload.exit_code;
        const isOk = code === 0 || code === null;
        setState((s) => ({
          ...s,
          status: isOk ? "done" : "error",
          errorMessage: isOk ? null : `进程退出码 ${code}`,
        }));
        currentTaskIdRef.current = null;
      });

      const unError = await listen<ErrorEventPayload>("hermes-error", (e) => {
        if (e.payload.task_id !== currentTaskIdRef.current) return;
        setState((s) => ({
          ...s,
          status: "error",
          errorMessage: e.payload.message,
        }));
        currentTaskIdRef.current = null;
      });

      if (disposed) {
        // 组件已卸载，立刻取消
        unSession();
        unChunk();
        unDone();
        unError();
        return;
      }

      unlisteners.push(unSession, unChunk, unDone, unError);
    }

    subscribe().catch((e) => {
      console.error("useHermesTask subscribe failed:", e);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  // ---- submit：提交一轮新任务 ----
  const submit = useCallback(async (args: SubmitArgs) => {
    const text = args.text.trim();
    if (!text) return;

    // 若上一轮还在跑，先 cancel（避免事件错乱）
    const prev = currentTaskIdRef.current;
    if (prev) {
      try {
        await invoke("hermes_cancel", { taskId: prev });
      } catch (e) {
        console.warn("hermes_cancel(previous) failed:", e);
      }
    }

    // 进入 starting 态，清空上一轮 output
    setState((s) => ({
      status: "starting",
      output: "",
      sessionId: args.sessionId ?? s.sessionId, // 续接时保留旧 session
      taskId: null,
      errorMessage: null,
    }));

    const backendArgs: StartChatBackendArgs = {
      text,
    };
    if (args.sessionId) {
      backendArgs.session_id = args.sessionId;
      // 续接时不要再传 system_prompt（会污染上下文）
    } else if (args.systemPrompt) {
      backendArgs.system_prompt = args.systemPrompt;
    }

    try {
      const result = await invoke<StartChatResult>("hermes_start_chat", {
        args: backendArgs,
      });
      currentTaskIdRef.current = result.task_id;
      setState((s) => ({ ...s, taskId: result.task_id }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      currentTaskIdRef.current = null;
      setState((s) => ({
        ...s,
        status: "error",
        errorMessage: `启动失败：${msg}`,
      }));
    }
  }, []);

  // ---- cancel：主动取消当前任务 ----
  const cancel = useCallback(async () => {
    const id = currentTaskIdRef.current;
    if (!id) return;

    try {
      await invoke("hermes_cancel", { taskId: id });
    } catch (e) {
      console.warn("hermes_cancel failed:", e);
    }
    currentTaskIdRef.current = null;
    setState((s) => ({ ...s, status: "cancelled" }));
  }, []);

  // ---- reset：清空状态 ----
  const reset = useCallback((opts?: { keepSession?: boolean }) => {
    const keep = opts?.keepSession ?? false;
    currentTaskIdRef.current = null;
    setState((s) => ({
      status: "idle",
      output: "",
      sessionId: keep ? s.sessionId : null,
      taskId: null,
      errorMessage: null,
    }));
  }, []);

  return {
    ...state,
    submit,
    cancel,
    reset,
  };
}
