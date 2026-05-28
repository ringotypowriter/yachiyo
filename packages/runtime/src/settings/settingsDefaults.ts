import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_SIDEBAR_VISIBILITY,
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  DEFAULT_TOOL_MODEL_MODE,
  DEFAULT_WEB_SEARCH_PROVIDER,
  type SettingsConfig
} from '@yachiyo/shared/protocol'
import { DEFAULT_SUBAGENTS_CONFIG } from './namedSubagents.ts'

export const DEFAULT_SETTINGS_CONFIG: SettingsConfig = {
  providers: [],
  general: {
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY,
    sidebarPreview: true,
    workSummary: true,
    themeId: DEFAULT_THEME_ID,
    themeAppearance: DEFAULT_THEME_APPEARANCE,
    demoMode: false,
    notifyRunCompleted: true,
    notifyCodingTaskStarted: true,
    notifyCodingTaskFinished: true,
    translatorShortcut: 'CommandOrControl+Shift+T',
    jotdownShortcut: 'CommandOrControl+Shift+J',
    activityTracking: {
      mode: 'simple',
      ocr: { enabled: false, excludedApps: [] }
    }
  },
  chat: {
    activeRunEnterBehavior: DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
    stripCompact: true,
    stripCompactThresholdTokens: DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
    autoMemoryDistillation: true,
    inputBufferEnabled: false,
    recapEnabled: true
  },
  workspace: {
    savedPaths: []
  },
  skills: {
    enabled: []
  },
  toolModel: {
    mode: DEFAULT_TOOL_MODEL_MODE,
    providerId: '',
    providerName: '',
    model: ''
  },
  memory: {
    enabled: true,
    autoRecall: true
  },
  prompts: [],
  subagentProfiles: [
    {
      id: 'claude-code-default',
      name: 'Claude Code',
      enabled: true,
      description: 'Default Claude Code agent. Best for multi-file refactoring and deep reasoning.',
      command: 'npx',
      args: ['-y', '@zed-industries/claude-agent-acp'],
      env: { ACP_PERMISSION_MODE: 'acceptEdits' }
    }
  ],
  webSearch: {
    defaultProvider: DEFAULT_WEB_SEARCH_PROVIDER,
    browserSession: {
      sourceBrowser: undefined,
      sourceProfileName: '',
      importedAt: '',
      lastImportError: ''
    },
    exa: {
      apiKey: '',
      baseUrl: ''
    }
  },
  subagents: DEFAULT_SUBAGENTS_CONFIG
}
