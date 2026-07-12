import { t } from '@yachiyo/i18n/index'
import type { ComposerReasoningSelection } from '@renderer/app/types'

export interface ReasoningSelectionCopy {
  label: string
  description: string
}

export function getReasoningSelectionCopy(
  selection: ComposerReasoningSelection
): ReasoningSelectionCopy {
  return {
    label: t(`chat.reasoning.${selection}.label`),
    description: t(`chat.reasoning.${selection}.description`)
  }
}

export function formatReasoningSelection(selection: ComposerReasoningSelection): string {
  return getReasoningSelectionCopy(selection).label
}
