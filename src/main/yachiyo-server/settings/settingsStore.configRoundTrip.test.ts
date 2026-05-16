import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  type BrowserBackedWebSearchSessionConfig,
  type ChatConfig,
  type ExaWebSearchConfig,
  type GeneralConfig,
  type MemoryConfig,
  type SkillsConfig,
  type ToolModelConfig,
  type WebSearchConfig,
  type WorkspaceConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SETTINGS_CONFIG,
  createSettingsStore,
  normalizeSettingsConfig,
  parseSettingsToml,
  stringifySettingsToml,
  toEffectiveProviderSettings,
  toProviderSettings
} from './settingsStore.ts'

const PROVIDER_WORK = {
  id: 'provider-work',
  name: 'work',
  type: 'openai' as const,
  apiKey: 'sk-work',
  baseUrl: 'https://openrouter.example/v1',
  project: '',
  location: '',
  serviceAccountEmail: '',
  serviceAccountPrivateKey: '',
  modelList: { enabled: ['gpt-5', 'gpt-4.1'], disabled: [] }
}

const PROVIDER_BACKUP = {
  id: 'provider-backup',
  name: 'backup',
  type: 'anthropic' as const,
  apiKey: 'sk-ant',
  baseUrl: '',
  project: '',
  location: '',
  serviceAccountEmail: '',
  serviceAccountPrivateKey: '',
  modelList: { enabled: ['claude-opus-4-6'], disabled: [] }
}

function assertKeysPreserved(
  actual: object | undefined,
  sentinel: object,
  configName: string
): void {
  const outputKeys = new Set(Object.keys(actual ?? {}))
  for (const key of Object.keys(sentinel)) {
    assert.ok(
      outputKeys.has(key),
      `${configName} key "${key}" was stripped by normalization — ` +
        `add it to normalize${configName} in the settings normalization layer`
    )
  }
}

test('general shortcut fields round-trip through TOML serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-shortcuts-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    const config: Parameters<typeof store.write>[0] = {
      ...DEFAULT_SETTINGS_CONFIG,
      general: {
        ...DEFAULT_SETTINGS_CONFIG.general,
        translatorShortcut: 'Alt+Shift+T',
        jotdownShortcut: 'Alt+Shift+J'
      }
    }

    store.write(config)

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /translatorShortcut = "Alt\+Shift\+T"/)
    assert.match(toml, /jotdownShortcut = "Alt\+Shift\+J"/)

    const loaded = store.read()
    assert.equal(loaded.general?.translatorShortcut, 'Alt+Shift+T')
    assert.equal(loaded.general?.jotdownShortcut, 'Alt+Shift+J')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('general activity tracking round-trips through parse → normalize → stringify → parse', () => {
  const toml = `[general]
activityTracking = { mode = "full", accessibilityDenied = true }
`

  const config = parseSettingsToml(toml)
  assert.deepEqual(config.general?.activityTracking, {
    mode: 'full',
    accessibilityDenied: true
  })

  const serialized = stringifySettingsToml(config)
  const reloaded = parseSettingsToml(serialized)
  assert.deepEqual(reloaded.general?.activityTracking, {
    mode: 'full',
    accessibilityDenied: true
  })
})

test('general activity tracking defaults to simple when missing from legacy TOML', () => {
  const config = parseSettingsToml(`[general]
notifyRunCompleted = true
`)

  assert.deepEqual(config.general?.activityTracking, { mode: 'simple' })
})

test('general theme preferences round-trip through parse → normalize → stringify → parse', () => {
  const toml = `[general]
themeId = "mizu"
themeAppearance = "dark"
`

  const config = parseSettingsToml(toml)
  assert.equal(config.general?.themeId, 'mizu')
  assert.equal(config.general?.themeAppearance, 'dark')

  const serialized = stringifySettingsToml(config)
  const reloaded = parseSettingsToml(serialized)
  assert.equal(reloaded.general?.themeId, 'mizu')
  assert.equal(reloaded.general?.themeAppearance, 'dark')
})

test('toProviderSettings uses explicit defaultModel when provider exists', () => {
  const snapshot = toProviderSettings({
    providers: [PROVIDER_WORK, PROVIDER_BACKUP],
    defaultModel: { providerName: 'backup', model: 'claude-opus-4-6' }
  })

  assert.equal(snapshot.providerName, 'backup')
  assert.equal(snapshot.provider, 'anthropic')
  assert.equal(snapshot.model, 'claude-opus-4-6')
})

test('toProviderSettings falls back to first-provider auto-detection when defaultModel provider is missing', () => {
  const snapshot = toProviderSettings({
    providers: [PROVIDER_WORK, PROVIDER_BACKUP],
    defaultModel: { providerName: 'nonexistent', model: 'some-model' }
  })

  assert.equal(snapshot.providerName, 'work')
  assert.equal(snapshot.model, 'gpt-5')
})

test('toProviderSettings falls back to first-provider auto-detection when defaultModel is absent', () => {
  const snapshot = toProviderSettings({
    providers: [PROVIDER_WORK, PROVIDER_BACKUP]
  })

  assert.equal(snapshot.providerName, 'work')
  assert.equal(snapshot.model, 'gpt-5')
})

test('toEffectiveProviderSettings uses thread override when present', () => {
  const snapshot = toEffectiveProviderSettings(
    {
      providers: [PROVIDER_WORK, PROVIDER_BACKUP],
      defaultModel: { providerName: 'backup', model: 'claude-opus-4-6' }
    },
    { providerName: 'work', model: 'gpt-4.1' }
  )

  assert.equal(snapshot.providerName, 'work')
  assert.equal(snapshot.model, 'gpt-4.1')
})

test('toEffectiveProviderSettings falls back to defaultModel when no thread override', () => {
  const snapshot = toEffectiveProviderSettings({
    providers: [PROVIDER_WORK, PROVIDER_BACKUP],
    defaultModel: { providerName: 'backup', model: 'claude-opus-4-6' }
  })

  assert.equal(snapshot.providerName, 'backup')
  assert.equal(snapshot.model, 'claude-opus-4-6')
})

test('toEffectiveProviderSettings falls back to first-provider auto-detection when thread override provider is missing', () => {
  const snapshot = toEffectiveProviderSettings(
    {
      providers: [PROVIDER_WORK, PROVIDER_BACKUP],
      defaultModel: { providerName: 'backup', model: 'claude-opus-4-6' }
    },
    { providerName: 'nonexistent', model: 'ghost-model' }
  )

  assert.equal(snapshot.providerName, 'backup')
  assert.equal(snapshot.model, 'claude-opus-4-6')
})

test('defaultModel round-trips through TOML serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-defaultmodel-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    store.write({
      providers: [PROVIDER_WORK],
      defaultModel: { providerName: 'work', model: 'gpt-4.1' }
    })

    const loaded = store.read()
    assert.deepEqual(loaded.defaultModel, { providerName: 'work', model: 'gpt-4.1' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultModel is absent from normalized config when strings are empty', () => {
  const config = normalizeSettingsConfig({
    providers: [],
    defaultModel: { providerName: '', model: '' }
  })

  assert.equal(config.defaultModel, undefined)
})

test('old TOML without [defaultModel] section loads without defaultModel', () => {
  const toml = `enabledTools = ["read","bash"]

[general]
sidebarVisibility = "expanded"
notifyRunCompleted = true
notifyCodingTaskStarted = true
notifyCodingTaskFinished = true

[chat]
activeRunEnterBehavior = "enter-steers"

[workspace]
savedPaths = []

[skills]
enabled = []

[toolModel]
mode = "disabled"
providerId = ""
providerName = ""
model = ""

[memory]
enabled = true
provider = "builtin-memory"
baseUrl = "http://127.0.0.1:14242"

[webSearch]
defaultProvider = "google-browser"

[webSearch.browserSession]
sourceBrowser = ""
sourceProfileName = ""
importedAt = ""
lastImportError = ""

[webSearch.exa]
apiKey = ""
baseUrl = ""
`

  const config = parseSettingsToml(toml)
  assert.equal(config.defaultModel, undefined)
})

test('legacy JSON env with braces in values round-trips through parseSettingsToml', () => {
  const toml = `enabledTools = [ "read", "bash" ]

[general]
sidebarVisibility = "expanded"
notifyRunCompleted = true
notifyCodingTaskStarted = true
notifyCodingTaskFinished = true

[chat]
activeRunEnterBehavior = "enter-steers"

[workspace]
savedPaths = []
editorApp = ""
terminalApp = ""

[skills]
enabled = []

[toolModel]
mode = "disabled"
providerId = ""
providerName = ""
model = ""

[defaultModel]
providerName = ""
model = ""

[memory]
enabled = true
provider = "builtin-memory"
baseUrl = "http://127.0.0.1:14242"

[webSearch]
defaultProvider = "google-browser"

[webSearch.browserSession]
sourceBrowser = ""
sourceProfileName = ""
importedAt = ""
lastImportError = ""

[webSearch.exa]
apiKey = ""
baseUrl = ""

[[subagentProfiles]]
id = "agent-tpl"
name = "Template Agent"
enabled = true
description = "agent with braces in env"
command = "node"
args = [ "index.js" ]
env = {"PROMPT":"Hello {name}, welcome to {place}","EXTRA":"val}ue"}
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'agent-tpl')
  assert.ok(profile)
  assert.equal(profile.env['PROMPT'], 'Hello {name}, welcome to {place}')
  assert.equal(profile.env['EXTRA'], 'val}ue')
})

test('legacy JSON env with dotted keys preserves literal key names', () => {
  const toml = `[[subagentProfiles]]
id = "dotted"
name = "Dotted"
enabled = true
description = ""
command = "node"
args = []
env = {"app.config.key":"val","NORMAL":"ok"}
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'dotted')
  assert.ok(profile)
  assert.equal(profile.env['app.config.key'], 'val')
  assert.equal(profile.env['NORMAL'], 'ok')
})

test('legacy JSON env with trailing TOML comment is parsed correctly', () => {
  const toml = `[[subagentProfiles]]
id = "commented"
name = "Commented"
enabled = true
description = ""
command = "node"
args = []
env = {"KEY":"value"} # deployment note
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'commented')
  assert.ok(profile)
  assert.equal(profile.env['KEY'], 'value')
})

test('legacy JSON env on indented lines is parsed correctly', () => {
  const toml = `[[subagentProfiles]]
  id = "indented"
  name = "Indented"
  enabled = true
  description = ""
  command = "node"
  args = []
  env = {"FOO":"bar"}
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'indented')
  assert.ok(profile)
  assert.equal(profile.env['FOO'], 'bar')
})

test('subagent ACP flags round-trip through parse → normalize → stringify → parse', () => {
  const toml = `[[subagentProfiles]]
id = "chat-agent"
name = "Chat Agent"
enabled = true
description = "direct chat capable"
command = "acp-agent"
args = []
env = {}
showInChatPicker = true
allowDirectChat = true
allowDelegation = false
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'chat-agent')
  assert.ok(profile, 'profile should be parsed')
  assert.equal(profile.showInChatPicker, true)
  assert.equal(profile.allowDirectChat, true)
  assert.equal(profile.allowDelegation, false)

  const serialized = stringifySettingsToml(config)
  const reloaded = parseSettingsToml(serialized)
  const reloadedProfile = reloaded.subagentProfiles?.find((p) => p.id === 'chat-agent')
  assert.ok(reloadedProfile, 'profile should survive round-trip')
  assert.equal(reloadedProfile.showInChatPicker, true, 'showInChatPicker preserved')
  assert.equal(reloadedProfile.allowDirectChat, true, 'allowDirectChat preserved')
  assert.equal(reloadedProfile.allowDelegation, false, 'allowDelegation preserved')
})

test('subagent ACP flags default to absent when not specified in TOML', () => {
  const toml = `[[subagentProfiles]]
id = "basic-agent"
name = "Basic Agent"
enabled = true
description = ""
command = "acp-agent"
args = []
env = {}
`

  const config = parseSettingsToml(toml)
  const profile = config.subagentProfiles?.find((p) => p.id === 'basic-agent')
  assert.ok(profile, 'profile should be parsed')
  assert.equal(profile.showInChatPicker, undefined, 'showInChatPicker absent when not specified')
  assert.equal(profile.allowDirectChat, undefined, 'allowDirectChat absent when not specified')
  assert.equal(profile.allowDelegation, undefined, 'allowDelegation absent when not specified')
})

test('normalization preserves every GeneralConfig key', () => {
  const sentinel: Required<GeneralConfig> = {
    sidebarVisibility: 'collapsed',
    sidebarPreview: false,
    uiFontSize: 16,
    chatFontSize: 18,
    updateChannel: 'beta',
    demoMode: true,
    notifyRunCompleted: false,
    notifyCodingTaskStarted: false,
    notifyCodingTaskFinished: false,
    translatorShortcut: 'Alt+T',
    jotdownShortcut: 'Alt+J',
    activityTracking: { mode: 'full', accessibilityDenied: true },
    themeId: 'mizu',
    themeAppearance: 'dark'
  }
  const result = normalizeSettingsConfig({ providers: [], general: sentinel })
  assertKeysPreserved(result.general, sentinel, 'GeneralConfig')
})

test('normalization preserves every ChatConfig key', () => {
  const sentinel: Required<ChatConfig> = {
    activeRunEnterBehavior: 'enter-queues-follow-up',
    stripCompact: false,
    stripCompactThresholdTokens: 120_000,
    autoMemoryDistillation: false,
    inputBufferEnabled: true,
    recapEnabled: true,
    imageToTextModel: { providerName: 'openai', model: 'gpt-4o' }
  }
  const result = normalizeSettingsConfig({ providers: [], chat: sentinel })
  assertKeysPreserved(result.chat, sentinel, 'ChatConfig')
})

test('normalization preserves every WorkspaceConfig key', () => {
  const sentinel: Required<WorkspaceConfig> = {
    savedPaths: ['/tmp/test'],
    pathLabels: { '/tmp/test': 'Test' },
    editorApp: 'zed',
    terminalApp: 'wezterm',
    markdownApp: 'obsidian'
  }
  const result = normalizeSettingsConfig({ providers: [], workspace: sentinel })
  assertKeysPreserved(result.workspace, sentinel, 'WorkspaceConfig')
})

test('normalization preserves every SkillsConfig key', () => {
  const sentinel: Required<SkillsConfig> = {
    enabled: ['skill-a'],
    disabled: ['skill-b']
  }
  const result = normalizeSettingsConfig({ providers: [], skills: sentinel })
  assertKeysPreserved(result.skills, sentinel, 'SkillsConfig')
})

test('normalization preserves every MemoryConfig key', () => {
  const sentinel: Required<MemoryConfig> = {
    enabled: true,
    provider: 'builtin-memory',
    baseUrl: 'http://localhost:9999',
    autoRecall: false
  }
  const result = normalizeSettingsConfig({ providers: [], memory: sentinel })
  assertKeysPreserved(result.memory, sentinel, 'MemoryConfig')
})

test('normalization preserves every ToolModelConfig key', () => {
  const sentinel: Required<ToolModelConfig> = {
    mode: 'custom',
    providerId: 'p1',
    providerName: 'Provider',
    model: 'gpt-5'
  }
  const result = normalizeSettingsConfig({ providers: [], toolModel: sentinel })
  assertKeysPreserved(result.toolModel, sentinel, 'ToolModelConfig')
})

test('normalization preserves every WebSearchConfig key', () => {
  const sentinel: Required<WebSearchConfig> = {
    defaultProvider: 'exa',
    browserSession: { sourceBrowser: 'google-chrome' },
    exa: { apiKey: 'key' }
  }
  const result = normalizeSettingsConfig({ providers: [], webSearch: sentinel })
  assertKeysPreserved(result.webSearch, sentinel, 'WebSearchConfig')
})

test('normalization preserves every BrowserBackedWebSearchSessionConfig key', () => {
  const sentinel: Required<BrowserBackedWebSearchSessionConfig> = {
    sourceBrowser: 'google-chrome',
    sourceProfileName: 'Default',
    importedAt: '2025-01-01',
    lastImportError: 'none'
  }
  const result = normalizeSettingsConfig({
    providers: [],
    webSearch: { browserSession: sentinel }
  })
  assertKeysPreserved(
    result.webSearch?.browserSession,
    sentinel,
    'BrowserBackedWebSearchSessionConfig'
  )
})

test('normalization preserves every ExaWebSearchConfig key', () => {
  const sentinel: Required<ExaWebSearchConfig> = {
    apiKey: 'test-key',
    baseUrl: 'https://exa.test'
  }
  const result = normalizeSettingsConfig({
    providers: [],
    webSearch: { exa: sentinel }
  })
  assertKeysPreserved(result.webSearch?.exa, sentinel, 'ExaWebSearchConfig')
})

test('chat.imageToTextModel round-trips through TOML serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-i2t-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    store.write({
      providers: [PROVIDER_WORK],
      chat: {
        imageToTextModel: { providerName: 'work', model: 'gpt-5' }
      }
    })

    const loaded = store.read()
    assert.deepEqual(loaded.chat?.imageToTextModel, { providerName: 'work', model: 'gpt-5' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store migrates legacy channels image-to-text model into chat config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-i2t-legacy-'))
  const settingsPath = join(root, 'config.toml')
  const channelsPath = join(root, 'channels.toml')

  try {
    await writeFile(
      settingsPath,
      stringifySettingsToml({
        providers: [PROVIDER_WORK],
        chat: {
          inputBufferEnabled: true
        }
      }),
      'utf8'
    )
    await writeFile(
      channelsPath,
      [
        '[image_to_text]',
        'enabled = true',
        'model_provider = "work"',
        'model_name = "gpt-4.1"',
        ''
      ].join('\n'),
      'utf8'
    )

    const store = createSettingsStore(settingsPath)
    const loaded = store.read()
    const saved = await readFile(settingsPath, 'utf8')

    assert.deepEqual(loaded.chat?.imageToTextModel, {
      providerName: 'work',
      model: 'gpt-4.1'
    })
    assert.match(saved, /\[chat.imageToTextModel\]/)
    assert.match(saved, /providerName = "work"/)
    assert.match(saved, /model = "gpt-4.1"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider imageIncapable list round-trips through TOML serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-imgcap-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    store.write({
      providers: [
        {
          ...PROVIDER_WORK,
          modelList: { enabled: ['gpt-5', 'gpt-4.1'], disabled: [], imageIncapable: ['gpt-4.1'] }
        }
      ]
    })

    const loaded = store.read()
    assert.deepEqual(loaded.providers[0].modelList.imageIncapable, ['gpt-4.1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit empty imageIncapable list survives round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-imgcap-empty-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    store.write({
      providers: [
        {
          ...PROVIDER_WORK,
          modelList: { enabled: ['deepseek-v4-pro'], disabled: [], imageIncapable: [] }
        }
      ]
    })

    const loaded = store.read()
    assert.deepEqual(loaded.providers[0].modelList.imageIncapable, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
