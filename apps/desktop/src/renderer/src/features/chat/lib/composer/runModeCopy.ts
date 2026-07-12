import { t } from '@yachiyo/i18n/index'
import type { SelectableRunModeId } from '@yachiyo/shared/protocol'

export interface RunModeCopy {
  label: string
  shortLabel: string
  description: string
}

export function getRunModeCopy(modeId: SelectableRunModeId): RunModeCopy {
  return {
    label: t(`chat.modes.${modeId}.label`),
    shortLabel: t(`chat.modes.${modeId}.shortLabel`),
    description: t(`chat.modes.${modeId}.description`)
  }
}
