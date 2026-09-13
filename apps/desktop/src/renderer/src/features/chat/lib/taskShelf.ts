export function isTaskRunning(state: string): boolean {
  return state === 'running' || state === 'starting'
}

export function summarizeTasks(tasks: readonly { state: string }[]): string {
  const running = tasks.filter((task) => isTaskRunning(task.state)).length
  const idle = tasks.filter((task) => task.state === 'idle').length
  if (running || idle)
    return [running ? `${running} running` : '', idle ? `${idle} idle` : '']
      .filter(Boolean)
      .join(' · ')
  return tasks.length ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` : ''
}

export function sortTasks<T extends { state: string; time: string }>(tasks: readonly T[]): T[] {
  const rank = (state: string): number => (isTaskRunning(state) ? 0 : state === 'idle' ? 1 : 2)
  return [...tasks].sort(
    (a, b) =>
      rank(a.state) - rank(b.state) ||
      (isTaskRunning(a.state) ? a.time.localeCompare(b.time) : b.time.localeCompare(a.time))
  )
}
