import type { TodoItemRecord } from '../../../app/types.ts'

export interface TodoProgressCount {
  completed: number
  total: number
}

export function getTodoProgressCount(items: readonly TodoItemRecord[]): TodoProgressCount {
  return {
    completed: items.filter((item) => item.status === 'completed').length,
    total: items.length
  }
}
