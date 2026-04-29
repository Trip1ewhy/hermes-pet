// Hermes Runner —— 流 B 核心：spawn 本地 Hermes Agent CLI 子进程，
// 把 stdout 实时（按行）转成 Tauri event，前端订阅。
//
// 设计要点（已在实测中确认，详见 docs/tech.md §10 风险 2/3）：
//   1. CLI 入口固定：`hermes chat -Q --accept-hooks -q "<text>"`
//      续接时再加 `-r <session_id>`。
//      —— 注：原计划带 `--source tool`，2026-04-29 实测发现
//      `-Q` 与 `--source tool` 组合会让一次 `hi` 耗时从 10s 飙到 44s，
//      去掉 `--source tool` 后回归正常，故 V1 不带。
//   2. stdout 是行流式：tokio 的 BufReader::lines 即可。
//   3. 首条对话首行 `session_id: <id>` 必出；续接调用首行可能是
//      `↻ Resumed session ...`，第二行才是 `session_id: <id>`。
//      —— 实测补丁（2026-04-29）：`session_id:` 行实际写到 **stderr**
//      而非 stdout（hermes 把它当 meta 信息了）。所以两边都要扫。
//      并且 stderr 必须 **实时按行读**，否则 pipe buffer 一满会
//      让子进程 write() 阻塞，stdout 那头跟着卡住，表现就是
//      "10s 的事情拖到 30s+"。这条踩坑代价很大，别再回头。
//   4. 退出码 0 表示正常；非 0 走 error event。
//
// 对外 Tauri commands：
//   - hermes_discover() -> { ok, path } : 探测 hermes 二进制位置
//   - hermes_start_chat({ text, session_id?, system_prompt? }) -> task_id
//   - hermes_cancel(task_id)
//
// emit 的事件（payload 见各 Payload struct）：
//   - hermes-chunk        正文增量行
//   - hermes-session      首次拿到 session_id
//   - hermes-done         任务完成（含退出码）
//   - hermes-error        spawn 失败 / 进程异常
//   —— 注：原本用 `hermes://chunk` 这种 URL 风格，2026-04-29 实测前端
//      `listen()` 收不到事件（后端 emit 成功，前端死活不触发回调）。
//      Tauri 2 的 event name 不允许 `//`，必须 kebab-case。
//
// 并发：每次提交都 spawn 独立子进程，task_id (uuid v4) 隔离。
// kill 时通过 task_id 在 RUNNING 表里查 Child handle 调 .kill()。

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

// ====== 事件名 ======
const EV_CHUNK: &str = "hermes-chunk";
const EV_SESSION: &str = "hermes-session";
const EV_DONE: &str = "hermes-done";
const EV_ERROR: &str = "hermes-error";
const PET_WINDOW_LABEL: &str = "pet";

// ====== 全局状态：跑着的子进程 task_id -> Child ======
static RUNNING: Lazy<Arc<Mutex<HashMap<String, Child>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

// ====== session_id 解析正则：第一组 = id ======
static SESSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^session_id:\s*(\S+)\s*$").expect("session_id regex"));

// ====== payload 类型 ======
#[derive(Debug, Clone, Serialize)]
pub struct ChunkPayload {
    pub task_id: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionPayload {
    pub task_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DonePayload {
    pub task_id: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    pub task_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoverResult {
    pub ok: bool,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartChatArgs {
    pub text: String,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartChatResult {
    pub task_id: String,
}

// ====== 二进制发现 ======
//
// 顺序按 docs/tech.md §6 拍板：PATH → ~/.local/bin/hermes → 常见 Homebrew 路径。
// 找到第一个存在且可执行的就返回。
fn discover_hermes_path() -> Option<PathBuf> {
    // 1. PATH 上的 hermes
    if let Ok(path) = which_in_path("hermes") {
        return Some(path);
    }
    // 2. ~/.local/bin/hermes
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".local").join("bin").join("hermes");
        if is_executable(&p) {
            return Some(p);
        }
    }
    // 3. Homebrew 常见路径
    for cand in [
        "/opt/homebrew/bin/hermes",
        "/usr/local/bin/hermes",
        "/opt/local/bin/hermes",
    ] {
        let p = PathBuf::from(cand);
        if is_executable(&p) {
            return Some(p);
        }
    }
    None
}

fn which_in_path(name: &str) -> Result<PathBuf, ()> {
    let path_env = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(())
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn hermes_discover() -> DiscoverResult {
    match discover_hermes_path() {
        Some(p) => DiscoverResult {
            ok: true,
            path: Some(p.to_string_lossy().to_string()),
        },
        None => DiscoverResult {
            ok: false,
            path: None,
        },
    }
}

// ====== 启动一次对话 ======
//
// 参数组装顺序（必带的全局开关）：
//   chat -Q --accept-hooks
// 然后按需加 -r <session_id>，最后 -q "<full_text>"。
//
// system_prompt（research/cowork 气泡用）暂时直接前置拼到 text 里，
// 简单稳妥；后续若 Hermes 提供 -s/--system 参数可改为开关注入。
#[tauri::command]
pub async fn hermes_start_chat(
    app: AppHandle,
    args: StartChatArgs,
) -> Result<StartChatResult, String> {
    let bin = discover_hermes_path()
        .ok_or_else(|| "未找到 hermes 二进制（请先安装 Hermes Agent）".to_string())?;

    let task_id = args
        .task_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // 拼最终 -q 文本：system prompt 在前，用户文本在后
    let full_text = match args.system_prompt.as_deref() {
        Some(sp) if !sp.trim().is_empty() => format!("{sp}\n\n---\n\n{}", args.text),
        _ => args.text.clone(),
    };

    // 拼参数
    let mut cmd_args: Vec<String> = vec!["chat".into(), "-Q".into(), "--accept-hooks".into()];
    if let Some(sid) = args.session_id.as_deref() {
        if !sid.is_empty() {
            cmd_args.push("-r".into());
            cmd_args.push(sid.into());
        }
    }
    cmd_args.push("-q".into());
    cmd_args.push(full_text);

    // 调试日志：把这次要 spawn 的命令完整打出来（除了正文长度避免刷屏）
    let preview_args: Vec<String> = cmd_args
        .iter()
        .enumerate()
        .map(|(i, a)| {
            // 最后一个是正文，截断
            if i == cmd_args.len() - 1 && a.len() > 60 {
                format!("\"{}…[{}chars]\"", &a[..60].replace('\n', "\\n"), a.len())
            } else if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect();
    eprintln!(
        "[hermes-runner] task={} spawn: {} {}",
        task_id,
        bin.display(),
        preview_args.join(" ")
    );

    // spawn
    let spawn_started = std::time::Instant::now();
    let mut child = match Command::new(&bin)
        .args(&cmd_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => {
            eprintln!(
                "[hermes-runner] task={} spawned, child pid={:?}",
                task_id,
                c.id()
            );
            c
        }
        Err(e) => {
            eprintln!("[hermes-runner] task={} spawn FAILED: {e}", task_id);
            return Err(format!("spawn hermes 失败: {e}"));
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout 取不到".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child stderr 取不到".to_string())?;

    // 注册到 RUNNING（取走 child 之前先放 reader 拿走 pipe；child 本体留着 wait）
    {
        let mut map = RUNNING.lock().await;
        map.insert(task_id.clone(), child);
    }

    // session_emitted 由 stdout/stderr 两个 reader 共享 —— 谁先看到 session_id 就 emit
    let session_emitted = Arc::new(Mutex::new(false));
    // stderr 累积的真错误（非 session_id 行），exit 非 0 时上报
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    // ====== stdout 行流读取任务 ======
    let app_stdout = app.clone();
    let tid_stdout = task_id.clone();
    let started = spawn_started;
    let session_emitted_stdout = session_emitted.clone();
    let stdout_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut line_count: u64 = 0;
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    line_count += 1;
                    let elapsed_ms = started.elapsed().as_millis();
                    let preview: String = if line.chars().count() > 120 {
                        let head: String = line.chars().take(120).collect();
                        format!("{head}…")
                    } else {
                        line.clone()
                    };
                    eprintln!(
                        "[hermes-runner] task={} stdout#{} (+{}ms): {}",
                        tid_stdout, line_count, elapsed_ms, preview
                    );
                    // 跳过续接提示行
                    if line.starts_with("↻ Resumed session") {
                        continue;
                    }
                    // 检测 session_id（一次有效）
                    if try_emit_session(
                        &app_stdout,
                        &tid_stdout,
                        &line,
                        &session_emitted_stdout,
                        "stdout",
                    )
                    .await
                    {
                        continue;
                    }
                    // 其余作 chunk 输出
                    let r = app_stdout.emit_to(
                        PET_WINDOW_LABEL,
                        EV_CHUNK,
                        ChunkPayload {
                            task_id: tid_stdout.clone(),
                            line: line.clone(),
                        },
                    );
                    eprintln!(
                        "[hermes-runner] task={} EMIT chunk ({} chars) -> {:?}",
                        tid_stdout,
                        line.len(),
                        r.as_ref().map(|_| "ok").map_err(|e| e.to_string())
                    );
                }
                Ok(None) => {
                    eprintln!(
                        "[hermes-runner] task={} stdout EOF, total lines={}, elapsed={}ms",
                        tid_stdout,
                        line_count,
                        started.elapsed().as_millis()
                    );
                    break;
                }
                Err(e) => {
                    eprintln!("[hermes-runner] task={} stdout read err: {e}", tid_stdout);
                    let _ = app_stdout.emit_to(
                        PET_WINDOW_LABEL,
                        EV_ERROR,
                        ErrorPayload {
                            task_id: tid_stdout.clone(),
                            message: format!("读 stdout 出错: {e}"),
                        },
                    );
                    break;
                }
            }
        }
    });

    // ====== stderr 行流读取任务（必须实时读避免 pipe 阻塞）======
    // 行内若是 `session_id: ...` 就 emit session；其余行累积到 stderr_buf。
    let app_stderr = app.clone();
    let tid_stderr = task_id.clone();
    let session_emitted_stderr = session_emitted.clone();
    let stderr_buf_clone = stderr_buf.clone();
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut line_count: u64 = 0;
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    line_count += 1;
                    let elapsed_ms = started.elapsed().as_millis();
                    let preview: String = if line.chars().count() > 120 {
                        let head: String = line.chars().take(120).collect();
                        format!("{head}…")
                    } else {
                        line.clone()
                    };
                    eprintln!(
                        "[hermes-runner] task={} stderr#{} (+{}ms): {}",
                        tid_stderr, line_count, elapsed_ms, preview
                    );
                    // 检测 session_id（与 stdout 共享一次性标志）
                    if try_emit_session(
                        &app_stderr,
                        &tid_stderr,
                        &line,
                        &session_emitted_stderr,
                        "stderr",
                    )
                    .await
                    {
                        continue;
                    }
                    // 其余 stderr 行累积，等子进程退出码非 0 再上报
                    let mut buf = stderr_buf_clone.lock().await;
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&line);
                }
                Ok(None) => {
                    eprintln!(
                        "[hermes-runner] task={} stderr EOF, total lines={}",
                        tid_stderr, line_count
                    );
                    break;
                }
                Err(e) => {
                    eprintln!("[hermes-runner] task={} stderr read err: {e}", tid_stderr);
                    break;
                }
            }
        }
    });

    // ====== 等两个 reader 都收完，再 wait child 拿退出码 ======
    let app_done = app.clone();
    let tid_done = task_id.clone();
    let stderr_buf_done = stderr_buf.clone();
    tokio::spawn(async move {
        // 等 stdout/stderr reader 收完
        let _ = stdout_handle.await;
        let _ = stderr_handle.await;

        // wait child + 摘出 RUNNING
        let mut map = RUNNING.lock().await;
        if let Some(mut child) = map.remove(&tid_done) {
            let exit_code = match child.wait().await {
                Ok(status) => status.code().unwrap_or(-1),
                Err(_) => -1,
            };
            eprintln!(
                "[hermes-runner] task={} done, exit={}, total elapsed={}ms",
                tid_done,
                exit_code,
                started.elapsed().as_millis()
            );

            // 退出码非 0 → 把累积的 stderr 上报为 error
            if exit_code != 0 {
                let buf = stderr_buf_done.lock().await;
                if !buf.is_empty() {
                    let _ = app_done.emit_to(
                        PET_WINDOW_LABEL,
                        EV_ERROR,
                        ErrorPayload {
                            task_id: tid_done.clone(),
                            message: buf.clone(),
                        },
                    );
                }
            }

            let r = app_done.emit_to(
                PET_WINDOW_LABEL,
                EV_DONE,
                DonePayload {
                    task_id: tid_done.clone(),
                    exit_code,
                },
            );
            eprintln!(
                "[hermes-runner] task={} EMIT done -> {:?}",
                tid_done,
                r.as_ref().map(|_| "ok").map_err(|e| e.to_string())
            );
        }
    });

    Ok(StartChatResult { task_id })
}

// 尝试从一行里识别 session_id 并 emit。返回 true 表示这行是 session 行（已消费）。
// from 仅用于日志区分来源（"stdout" / "stderr"）。
async fn try_emit_session(
    app: &AppHandle,
    task_id: &str,
    line: &str,
    flag: &Arc<Mutex<bool>>,
    from: &str,
) -> bool {
    let cap = match SESSION_RE.captures(line) {
        Some(c) => c,
        None => return false,
    };
    let mut emitted = flag.lock().await;
    if *emitted {
        // 已经发过了，但这行确实是 session_id 行，不要再当 chunk 发出去
        return true;
    }
    *emitted = true;
    let sid = cap.get(1).unwrap().as_str().to_string();
    eprintln!(
        "[hermes-runner] task={} session detected from {}: {}",
        task_id, from, sid
    );
    let r = app.emit_to(
        PET_WINDOW_LABEL,
        EV_SESSION,
        SessionPayload {
            task_id: task_id.to_string(),
            session_id: sid,
        },
    );
    eprintln!(
        "[hermes-runner] task={} EMIT session -> {:?}",
        task_id,
        r.as_ref().map(|_| "ok").map_err(|e| e.to_string())
    );
    true
}

// ====== 取消跑着的对话 ======
#[tauri::command]
pub async fn hermes_cancel(task_id: String) -> Result<(), String> {
    eprintln!("[hermes-runner] cancel requested: task={}", task_id);
    let mut map = RUNNING.lock().await;
    if let Some(child) = map.get_mut(&task_id) {
        // tokio Child::start_kill 是非阻塞 SIGKILL
        if let Err(e) = child.start_kill() {
            eprintln!("[hermes-runner] cancel kill FAILED: {e}");
            return Err(format!("kill 失败: {e}"));
        }
        eprintln!(
            "[hermes-runner] cancel kill signal sent for task={}",
            task_id
        );
    } else {
        eprintln!(
            "[hermes-runner] cancel: task={} not in RUNNING (already done?)",
            task_id
        );
    }
    Ok(())
}
