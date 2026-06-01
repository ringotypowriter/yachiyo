import type { TodoItemRecord } from '@renderer/app/types'

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
