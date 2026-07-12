import { behavior, chat, nav, shared, ui } from './panesShell.ts'
import { codingAgents, essentials, prompts, providers } from './panesModels.ts'
import { memory, search, skills, sync, workspace } from './panesData.ts'
import { about, activity, channels, schedule, usage } from './panesSystem.ts'

export const settings = {
  nav,
  shared,
  ui,
  behavior,
  chat,
  providers,
  codingAgents,
  prompts,
  essentials,
  memory,
  workspace,
  skills,
  search,
  sync,
  channels,
  schedule,
  usage,
  about,
  activity
} as const
