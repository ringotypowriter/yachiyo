import type { TodoItemRecord } from '../../../../../../shared/yachiyo/protocol.ts'

export const TODO_REMINDER_STEP_INTERVAL = 25

export interface TodoProgressState {
  items: TodoItemRecord[]
  lastUpdatedStep: number
  lastReminderStep?: number
}

export function createTodoProgressState(input: {
  items: TodoItemRecord[]
  step: number
}): TodoProgressState {
  return {
    items: cloneTodoItems(input.items),
    lastUpdatedStep: Math.max(0, input.step - 1)
  }
}

export function markTodoReminderInjected(
  state: TodoProgressState,
  step: number
): TodoProgressState {
  return {
    ...state,
    items: cloneTodoItems(state.items),
    lastReminderStep: step
  }
}

export function shouldInjectTodoReminder(
  state: TodoProgressState | undefined,
  currentStep: number
): boolean {
  if (!state || !hasIncompleteTodoItems(state.items)) {
    return false
  }

  const referenceStep = Math.max(state.lastUpdatedStep, state.lastReminderStep ?? 0)
  return currentStep - referenceStep >= TODO_REMINDER_STEP_INTERVAL
}

export function buildTodoReminderSteer(items: readonly TodoItemRecord[]): string {
  return [
    'System reminder: continue maintaining the current todo list with updateTodoList.',
    'Current todo list:',
    ...items.map((item) => `- [${item.status}] ${item.content}`),
    'Before starting or finishing a step, call updateTodoList with the full current list.'
  ].join('\n')
}

function hasIncompleteTodoItems(items: readonly TodoItemRecord[]): boolean {
  return items.length > 0 && items.some((item) => item.status !== 'completed')
}

function cloneTodoItems(items: readonly TodoItemRecord[]): TodoItemRecord[] {
  return items.map((item) => ({ ...item }))
}
