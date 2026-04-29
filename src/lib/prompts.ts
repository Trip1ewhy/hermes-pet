// 三气泡的 system prompt 默认值（V1 硬编码版）。
//
// 来源：docs/features/research-bubble.md §System Prompt(V1)
//        docs/features/cowork-bubble.md   §System Prompt(V1)
//        docs/features/dialog-bubble.md   §System Prompt 临时编辑（默认值）
//
// 调用约定（参考 docs/tech.md §3.2）：
//   桌宠把 system prompt 拼到 `-q` 文本最前面，后端再 spawn：
//     hermes chat -Q --accept-hooks -q "<system_prompt>\n\n<user_input>"
//   对话气泡的多轮续接靠 `-r <session_id>`，且 system prompt 只在首次注入。
//
// V2 计划：从 settings 持久化（详见 docs/features/settings.md）。
// 这里先用常量顶住，等 settings 落地时只需替换 import 即可。

export const RESEARCH_SYSTEM_PROMPT = `你是一个调研助手。当我给你一个研究主题或问题时，请按以下框架回复：

1. 拆问题：把这个题目拆成 3-5 个子问题
2. 列假设：你目前的初步判断和不确定的地方分别是什么
3. 找证据：列出你认为最值得查的来源、最关键的事实、最相关的数据点
4. 给结论：在以上基础上给一个有立场、可被反驳的结论

回复保持精简，每个部分用一段话或一个短列表。不要客套，不要免责声明。`;

export const COWORK_SYSTEM_PROMPT = `你是一个执行型助手。我会给你一个具体任务，请直接完成它，不要反问、不要罗列计划，做完直接给我可交付物。如果任务确实需要澄清才能继续，先用一句话提一个最关键的澄清问题，其余假设直接做。`;

export const DIALOG_SYSTEM_PROMPT = `你是 Hermes 桌宠后面的对话助手。和用户保持自然、简洁的对话节奏：

- 不啰嗦，不客套，不写免责声明
- 用户的问题如果可以直接答就直接答；需要先澄清一点才能答时，只问一个关键问题
- 用户希望多轮深入时，记住上下文里他已经说过的偏好和约束
- 工具调用谨慎使用：只在确实需要外部数据 / 操作时调，避免无意义的 echo`;

/**
 * 把 system prompt 拼到用户输入前面，组装成最终发给 `hermes chat -q` 的字符串。
 *
 * 注意：仅在「首次提交」或「单轮请求」时调用；
 * 对话气泡的多轮续接（带 -r session_id）只发用户输入，不再重复 system prompt。
 */
export function composeQuery(systemPrompt: string, userInput: string): string {
  return `${systemPrompt}\n\n${userInput}`;
}

export type BubbleKind = "research" | "dialog" | "cowork";

/** 各气泡的默认 system prompt 速查表，方便组件按种类拿。 */
export const DEFAULT_SYSTEM_PROMPTS: Record<BubbleKind, string> = {
  research: RESEARCH_SYSTEM_PROMPT,
  dialog: DIALOG_SYSTEM_PROMPT,
  cowork: COWORK_SYSTEM_PROMPT,
};
