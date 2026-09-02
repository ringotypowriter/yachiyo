export type AppLanguage = 'auto' | 'en' | 'zh-CN'
export type ToolCallDisplayMode = 'work-summary' | 'tool-deck'
export type UpdateChannel = 'stable' | 'beta'

export const DEFAULT_TOOL_CALL_DISPLAY_MODE: ToolCallDisplayMode = 'work-summary'

export function normalizeToolCallDisplayMode(value: unknown): ToolCallDisplayMode {
  return value === 'tool-deck' ? 'tool-deck' : DEFAULT_TOOL_CALL_DISPLAY_MODE
}
