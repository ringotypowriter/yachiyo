import type { AvatarPhase } from '../src/components/avatar/avatarTypes.ts'
import type { AppState } from '../src/app/store/useAppStore.ts'
import type { Message, RunRecord, ToolCall } from '../src/app/types.ts'

export type PreviewPhase = Exclude<AvatarPhase, 'success'>
export const PREVIEW_THREAD_ID = 'avatar-layout-study'

const response = `## Start with the decision, not the document

A long proposal is easier to read when you know what decision it is asking you to make. Before reviewing individual paragraphs, write down the problem, the person affected by it, and the change being proposed. These three sentences are your reference point when the document becomes detailed.

This does not mean reducing every design to a slogan. Some decisions really do need a careful explanation. The aim is to distinguish the main argument from the evidence supporting it, so you can return to that argument without rereading the whole page.

### Read once for structure

On the first pass, look at the section headings and the opening sentence of each section. You should be able to follow the argument without studying every example. If you cannot, note where the connection breaks rather than immediately rewriting the prose.

A useful review question is: **what does this section change about the decision?** A section might establish a constraint, compare two approaches, describe a risk, or explain how to verify the result. If several sections do the same job, they may belong together.

> Keep the first pass light. A missing connection is often more important than a sentence that could be shorter.

## Separate the experience from the machinery

A proposal can be technically consistent while still producing an awkward experience. For example, a control can remain visible, fit inside its container, and respond correctly to clicks, yet appear unrelated to the work around it. Those checks establish that the interface functions; they do not establish that its placement makes sense.

Describe what a person sees first, what they are likely to read next, and what action they can take. Only then connect those observations to components or state transitions. This keeps the review grounded in the screen rather than turning it into a discussion of implementation details alone.

| Review question | What to look for |
| --- | --- |
| What is the main content? | A clear reading order that survives a long response. |
| What remains visible? | Persistent elements with a reason to stay present. |
| What changes when work ends? | A calm transition, rather than an unexplained disappearance. |
| What happens in a narrow window? | Content that remains readable without covering controls. |

### Use realistic content

An empty screen is useful for checking alignment, but it is a weak test of a reading interface. Fill the screen with a few normal paragraphs, a short list, a table, and a completed tool result. Include a previous exchange so the view has the density of an actual conversation.

Avoid using one sentence repeated dozens of times. Repetition gives a misleading impression of rhythm and leaves out the changes in line length, heading weight, and paragraph spacing that shape real reading. A good sample should be ordinary enough that it does not distract from the interface.

## Check what happens between states

Do not evaluate loading, working, and completion as unrelated screenshots. Watch one sequence from beginning to end. An element that looks reasonable in each isolated state can still jump, restart, or change its apparent role during the transition.

For a long answer, scroll upward while the response is still active. Then return to the latest content. If a persistent element moves with the text, ask whether that movement is intentional. If it stays still, check that it has not covered a line, a scroll control, or an important action.

The same check applies when the input area grows. Enter several lines and observe which region gives up space. The reading area should become shorter in a predictable way; the interface should not invent a new strip of empty space just to keep a small decoration visible.

### Leave room for quiet moments

Activity does not need to be represented by continuous motion. A small movement followed by a pause is often easier to understand than a constant loop. During a long explanation, most of the screen should let the reader concentrate on the words.

When the work finishes, decide which elements represent the completed task and which represent the continuing conversation. Task-specific details can settle into history. A conversation-level presence can remain, but its idle behavior should be substantially quieter than its active behavior.

## Make the next experiment smaller

After identifying a problem, change the smallest meaningful part of the layout and look at the whole screen again. Moving an element by a few pixels is useful only when its overall relationship to the content is already correct. If that relationship is wrong, adjust the structure before polishing the spacing.

Record the question that the next sample is intended to answer. For this reading layout, the question is whether a quiet character in the page margin feels connected to the answer without becoming a second toolbar or a per-message avatar.

Try the sample at a comfortable reading width and then at a narrow width. Open the input area to several lines. Watch one pointing gesture. Switch to a welcome screen and verify that the original composition is unchanged. These are small checks, but together they expose problems that a close-up animation preview cannot.

### A compact review checklist

- The main argument is still easy to follow after several screens of text.
- Persistent elements have a clear relationship to the content.
- Motion has pauses, and completion does not trigger an unrelated visual reset.
- Text and controls remain clear at the narrowest supported width.
- The input area can grow without adding a new layout band.
- The welcome screen keeps its existing identity and proportions.

The result does not have to be perfect before the next conversation. It does need to make the tradeoff visible. A sample that clearly shows the cost of a placement is more useful than a polished detail that hides that cost.
`

export function buildLayoutPreviewState(
  phase: PreviewPhase,
  welcome: boolean,
  now: string
): Partial<AppState> {
  const active = !welcome && phase !== 'idle'
  const threadId = PREVIEW_THREAD_ID
  const prior = new Date(Date.parse(now) - 600000).toISOString()
  const user: Message = {
    id: 'layout-question',
    threadId,
    role: 'user',
    content:
      'Could you write a practical guide to reviewing a long design proposal? Include a table and a short checklist.',
    status: 'completed',
    createdAt: now
  }
  const assistant: Message = {
    id: 'layout-answer',
    threadId,
    parentMessageId: user.id,
    role: 'assistant',
    content: response,
    status: active ? 'streaming' : 'completed',
    createdAt: now,
    ...(phase === 'thinking'
      ? {
          reasoning:
            'Separate the reading experience from the implementation. Keep the examples concrete and check the transitions between states.'
        }
      : {})
  }
  const run: RunRecord = {
    id: 'layout-run',
    threadId,
    requestMessageId: user.id,
    status: active ? 'running' : 'completed',
    createdAt: now
  }
  const tool: ToolCall = {
    id: 'layout-tool',
    runId: run.id,
    threadId,
    requestMessageId: user.id,
    assistantMessageId: assistant.id,
    toolName: phase === 'waiting' ? 'askUser' : 'read',
    status:
      phase === 'working' ? 'running' : phase === 'waiting' ? 'waiting-for-user' : 'completed',
    inputSummary:
      phase === 'waiting' ? 'Would you like the short version?' : 'Review the reading-layout notes',
    startedAt: now,
    ...(phase === 'waiting'
      ? {
          details: {
            question: 'Would you like the short version?',
            choices: ['Keep the details', 'Make it shorter']
          }
        }
      : {})
  }
  return {
    activeThreadId: welcome ? null : threadId,
    threads: [{ id: threadId, title: 'A calmer place to read', updatedAt: now }],
    messages: {
      [threadId]: [
        {
          id: 'layout-prior-question',
          threadId,
          role: 'user',
          content:
            'I prefer a calm workspace. I do not want every small detail asking for attention.',
          status: 'completed',
          createdAt: prior
        },
        {
          id: 'layout-prior-answer',
          threadId,
          parentMessageId: 'layout-prior-question',
          role: 'assistant',
          content:
            'Then the layout should do most of the work. Keep the reading order clear, let secondary elements stay quiet, and use motion only when it has something to express.',
          status: 'completed',
          createdAt: prior
        },
        user,
        assistant
      ]
    },
    toolCalls: { [threadId]: [tool] },
    runsByThread: { [threadId]: [run] },
    latestRunsByThread: { [threadId]: run },
    activeRunIdsByThread: active ? { [threadId]: run.id } : {},
    activeRequestMessageIdsByThread: active ? { [threadId]: user.id } : {},
    runPhasesByThread: { [threadId]: active ? 'streaming' : 'idle' },
    receivingModelOutputByThread: { [threadId]: phase === 'thinking' || phase === 'speaking' },
    pendingAssistantMessages: active
      ? {
          [run.id]: {
            threadId,
            messageId: assistant.id,
            parentMessageId: user.id,
            shouldStartNewTextBlock: phase === 'thinking'
          }
        }
      : {}
  }
}
