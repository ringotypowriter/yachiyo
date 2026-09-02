import type React from 'react'
import type { SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import { useT } from '@yachiyo/i18n/react'
import { buildSubagentFinishedToolCall } from '../lib/tool-calls/subagentFinishedToolCall.ts'
import { ToolCallRow } from './ToolCallRow'

export function SubagentFinishedToolCallRow({
  result
}: {
  result: SubagentFinishedResult
}): React.JSX.Element {
  const t = useT()
  const toolCall = buildSubagentFinishedToolCall(result, t)

  return <ToolCallRow toolCall={toolCall} />
}
