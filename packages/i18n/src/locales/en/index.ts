import { chat } from './chat.ts'
import { common } from './common.ts'
import { essentials } from './essentials.ts'
import { jotdown } from './jotdown.ts'
import { layout } from './layout.ts'
import { main } from './main.ts'
import { notifications } from './notifications.ts'
import { onboarding } from './onboarding.ts'
import { runs } from './runs.ts'
import { search } from './search.ts'
import { settings } from './settings/index.ts'
import { shell } from './shell.ts'
import { things } from './things.ts'
import { threads } from './threads.ts'
import { translator } from './translator.ts'

export const en = {
  common,
  settings,
  chat,
  layout,
  threads,
  things,
  runs,
  search,
  notifications,
  onboarding,
  essentials,
  shell,
  main,
  translator,
  jotdown
} as const
