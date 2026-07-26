import { HARNESS_TASK_REMINDER } from '../../../../runtime/context/prompt.ts'

/**
 * Hidden instruction that drives a recap run.
 *
 * It is appended to the thread as an unpersisted user message, so the run's
 * context builder must resolve it through `loadThreadMessages` rather than
 * storage. The negative constraints sit at the tail because the harness appends
 * a `<reminder>` block after this text and chat models weigh the end of the
 * user turn most.
 */
export const RECAP_PROMPT = `${HARNESS_TASK_REMINDER} Nobody is waiting for a reply — this is a background summarization task.

Write a recap of the conversation above for the user, who stepped away and is coming back. Under 40 words, 1-2 plain sentences, no markdown, in the language used in the conversation. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.

Output the recap text only: no greeting, no question, no reply in character.`
