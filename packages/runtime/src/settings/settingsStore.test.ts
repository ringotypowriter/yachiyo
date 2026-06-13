import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_TOOL_MODEL_MODE,
  DEFAULT_SIDEBAR_VISIBILITY,
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  normalizeUserPrompts
} from '@yachiyo/shared/protocol'
import {
  DEFAULT_SETTINGS_CONFIG,
  createSettingsStore,
  normalizeSettingsConfig,
  parseSettingsToml,
  stringifySettingsToml,
  toProviderSettings,
  toToolModelSettings
} from './settingsStore.ts'

test('settings store persists multi-provider config as TOML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-store-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    const config: Parameters<typeof store.write>[0] = {
      enabledTools: ['read', 'bash'],
      runMode: 'custom',
      general: {
        sidebarVisibility: 'collapsed',
        sidebarPreview: true,
        workSummary: true,
        themeId: DEFAULT_THEME_ID,
        themeAppearance: DEFAULT_THEME_APPEARANCE,
        demoMode: true,
        notifyRunCompleted: true,
        notifyCodingTaskStarted: true,
        notifyCodingTaskFinished: true,
        translatorShortcut: 'CommandOrControl+Shift+T',
        jotdownShortcut: 'CommandOrControl+Shift+J',
        activityTracking: { mode: 'simple', ocr: { enabled: false, excludedApps: [] } }
      },
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up',
        stripCompact: true,
        stripCompactThresholdTokens: 250_000,
        autoMemoryDistillation: true,
        inputBufferEnabled: true,
        recapEnabled: true
      },
      workspace: {
        savedPaths: ['/Users/ringo/projects/yachiyo', '/Users/ringo/projects/handshake']
      },
      skills: {
        enabled: ['workspace-refactor', 'release-checklist']
      },
      toolModel: {
        mode: 'custom',
        providerId: 'provider-backup',
        providerName: 'backup',
        model: 'claude-opus-4-6'
      },
      memory: {
        enabled: true,
        autoRecall: false
      },
      webSearch: {
        defaultProvider: 'google-browser',
        browserSession: {
          sourceBrowser: 'google-chrome',
          sourceProfileName: 'Default',
          importedAt: '2026-03-21T12:00:00.000Z',
          lastImportError: ''
        },
        exa: {
          apiKey: 'exa-key',
          baseUrl: 'https://api.exa.ai'
        }
      },
      prompts: [],
      subagentProfiles: [],
      providers: [
        {
          id: 'provider-work',
          name: 'work',
          type: 'openai' as const,
          thinkingEnabled: true,
          apiKey: 'sk-work',
          baseUrl: 'https://openrouter.example/v1',
          project: '',
          location: '',
          serviceAccountEmail: '',
          serviceAccountPrivateKey: '',
          modelList: {
            enabled: ['gpt-5', 'gpt-4.1'],
            disabled: ['o3-mini']
          }
        },
        {
          id: 'provider-backup',
          name: 'backup',
          type: 'anthropic' as const,
          thinkingEnabled: false,
          apiKey: 'sk-ant',
          baseUrl: '',
          project: '',
          location: '',
          serviceAccountEmail: '',
          serviceAccountPrivateKey: '',
          modelList: {
            enabled: ['claude-opus-4-6'],
            disabled: []
          }
        }
      ]
    }

    store.write(config)

    assert.deepEqual(store.read(), normalizeSettingsConfig(config))

    const toml = await readFile(settingsPath, 'utf8')
    assert.doesNotMatch(toml, /enabledTools = /)
    assert.doesNotMatch(toml, /runMode = /)
    assert.match(toml, /\[general\]/)
    assert.match(toml, /sidebarVisibility = "collapsed"/)
    assert.match(toml, /workSummary = true/)
    assert.match(toml, /themeId = "mizu"/)
    assert.match(toml, /themeAppearance = "system"/)
    assert.match(toml, /demoMode = true/)
    assert.match(toml, /activeRunEnterBehavior = "enter-queues-follow-up"/)
    assert.match(toml, /stripCompactThresholdTokens = 250000/)
    assert.match(toml, /\[workspace\]/)
    assert.match(
      toml,
      /savedPaths = \[.*"\/Users\/ringo\/projects\/yachiyo".*"\/Users\/ringo\/projects\/handshake".*\]/
    )
    assert.match(toml, /\[skills\]/)
    assert.match(toml, /enabled = \[.*"workspace-refactor".*"release-checklist".*\]/)
    assert.match(toml, /\[toolModel\]/)
    assert.match(toml, /mode = "custom"/)
    assert.match(toml, /providerId = "provider-backup"/)
    assert.match(toml, /providerName = "backup"/)
    assert.match(toml, /model = "claude-opus-4-6"/)
    assert.match(toml, /\[webSearch\]/)
    assert.match(toml, /\[memory\]/)
    assert.match(toml, /enabled = true/)
    assert.match(toml, /autoRecall = false/)
    assert.match(toml, /defaultProvider = "google-browser"/)
    assert.match(toml, /\[webSearch\.browserSession\]/)
    assert.match(toml, /sourceProfileName = "Default"/)
    assert.match(toml, /\[webSearch\.exa\]/)
    assert.match(toml, /apiKey = "exa-key"/)
    assert.match(toml, /\[\[providers\]\]/)
    assert.match(toml, /id = "provider-work"/)
    assert.match(toml, /thinkingEnabled = true/)
    assert.match(toml, /thinkingEnabled = false/)
    assert.match(toml, /\[providers\.modelList\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizeSettingsConfig preserves demoMode in general settings', () => {
  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      general: { demoMode: true }
    }).general?.demoMode,
    true
  )

  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      general: { demoMode: false }
    }).general?.demoMode,
    false
  )
})

test('settings store preserves preventSystemSleep in general settings', () => {
  const config = normalizeSettingsConfig({
    providers: [],
    general: { preventSystemSleep: true }
  })

  assert.equal(config.general?.preventSystemSleep, true)

  const toml = stringifySettingsToml(config)
  assert.match(toml, /preventSystemSleep = true/)

  const reloaded = parseSettingsToml(toml)
  assert.equal(reloaded.general?.preventSystemSleep, true)
})

test('settings store returns the default config when the file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-default-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    assert.deepEqual(store.read(), DEFAULT_SETTINGS_CONFIG)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store seeds preset providers on first launch when opted in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-seed-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath, { seedPresetProviders: true })

  try {
    const config = store.read()
    assert.ok(config.providers.length > 0, 'preset providers should be seeded')
    assert.deepEqual({ ...config, providers: [] }, { ...DEFAULT_SETTINGS_CONFIG, providers: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store preserves essential privacy mode', () => {
  const config = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ],
    essentials: [
      {
        id: 'essential-private',
        icon: '🔒',
        iconType: 'emoji',
        label: 'Private',
        privacyMode: true,
        order: 0
      }
    ]
  })

  const toml = stringifySettingsToml(config)
  const parsed = parseSettingsToml(toml)

  assert.match(toml, /privacyMode = true/)
  assert.equal(parsed.essentials?.[0]?.privacyMode, true)
})

test('toProviderSettings resolves the active provider snapshot', () => {
  const snapshot = toProviderSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    chat: {
      activeRunEnterBehavior: 'enter-steers'
    },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: [],
          disabled: []
        }
      },
      {
        id: 'provider-backup',
        name: 'backup',
        type: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: ['claude-opus-4-6'],
          disabled: ['claude-sonnet-4-5']
        }
      }
    ]
  })

  assert.equal(snapshot.providerName, 'backup')
  assert.equal(snapshot.provider, 'anthropic')
  assert.equal(snapshot.model, 'claude-opus-4-6')
  assert.equal(snapshot.apiKey, 'sk-ant')
})

test('normalizeSettingsConfig keeps vercel-gateway providers', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-gateway',
        name: 'vercel-gateway-work',
        type: 'vercel-gateway',
        apiKey: 'vgw_test',
        baseUrl: 'https://ai-gateway.vercel.sh/v3/ai',
        modelList: {
          enabled: ['google/gemini-3-flash'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(normalized.providers[0]?.type, 'vercel-gateway')
})

test('Codex session path round-trips through parse → normalize → stringify → parse', () => {
  const toml = `[[providers]]
id = "provider-codex"
name = "Codex"
type = "openai-codex"
thinkingEnabled = true
apiKey = ""
baseUrl = "https://chatgpt.com/backend-api/codex"
codexSessionPath = "~/.codex/auth.json"

[providers.modelList]
enabled = ["gpt-5.1-codex-max"]
disabled = []
`

  const config = parseSettingsToml(toml)
  const provider = config.providers[0]
  assert.equal(provider?.type, 'openai-codex')
  assert.equal(provider?.codexSessionPath, '~/.codex/auth.json')

  const serialized = stringifySettingsToml(config)
  assert.match(serialized, /codexSessionPath = "~\/\.codex\/auth\.json"/)

  const reloaded = parseSettingsToml(serialized)
  const snapshot = toProviderSettings(reloaded)
  assert.equal(reloaded.providers[0]?.codexSessionPath, '~/.codex/auth.json')
  assert.equal(snapshot.provider, 'openai-codex')
  assert.equal(snapshot.model, 'gpt-5.1-codex-max')
  assert.equal(snapshot.codexSessionPath, '~/.codex/auth.json')
})

test('normalizeSettingsConfig defaults provider thinking to enabled', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(normalized.providers[0]?.thinkingEnabled, true)
})

test('provider reasoning config round-trips through parse → normalize → stringify → parse', () => {
  const toml = `[[providers]]
id = "provider-work"
name = "work"
type = "openai"
thinkingEnabled = true
apiKey = "sk-openai"
baseUrl = "https://api.openai.com/v1"

[providers.modelList]
enabled = ["gpt-5"]
disabled = []

[providers.reasoning]
defaultEffort = "medium"

[[providers.reasoning.models]]
model = "gpt-5"
enabledEfforts = ["low", "medium", "high"]
defaultEffort = "high"
allowOff = true
`

  const config = parseSettingsToml(toml)
  assert.deepEqual(config.providers[0]?.reasoning, {
    defaultEffort: 'medium',
    models: [
      {
        model: 'gpt-5',
        enabledEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        allowOff: true
      }
    ]
  })

  const serialized = stringifySettingsToml(config)
  assert.match(serialized, /\[providers\.reasoning\]/)
  assert.match(serialized, /\[\[providers\.reasoning\.models\]\]/)
  assert.match(serialized, /enabledEfforts = \[\s*"low",\s*"medium",\s*"high"\s*\]/)

  const reloaded = parseSettingsToml(serialized)
  assert.deepEqual(reloaded.providers[0]?.reasoning, config.providers[0]?.reasoning)
})

test('toProviderSettings carries provider thinking preference into the runtime snapshot', () => {
  const snapshot = toProviderSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    chat: {
      activeRunEnterBehavior: 'enter-steers'
    },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        thinkingEnabled: false,
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(snapshot.thinkingEnabled, false)
})

test('normalizeSettingsConfig keeps vertex (true Vertex AI) providers', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-vertex',
        name: 'vertex-work',
        type: 'vertex',
        apiKey: '',
        baseUrl: '',
        project: 'my-project',
        location: 'us-central1',
        modelList: {
          enabled: ['gemini-2.5-flash-001'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(normalized.providers[0]?.type, 'vertex')
})

test('normalizeSettingsConfig migrates legacy vertex gateway providers', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-vertex-legacy',
        name: 'legacy-gateway',
        type: 'vertex',
        apiKey: 'vgw_test',
        baseUrl: 'https://ai-gateway.vercel.sh/v3/ai',
        modelList: {
          enabled: ['google/gemini-3-flash'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(normalized.providers[0]?.type, 'vercel-gateway')
})

test('normalizeSettingsConfig normalizes skill name lists', () => {
  const normalized = normalizeSettingsConfig({
    skills: {
      enabled: ['  workspace-refactor  ', 'release-checklist', 'workspace-refactor', '']
    },
    providers: []
  })

  assert.deepEqual(normalized.skills?.enabled, ['workspace-refactor', 'release-checklist'])
})

test('normalizeSettingsConfig ignores deprecated global tool preferences', () => {
  const normalized = normalizeSettingsConfig({
    enabledTools: ['read', 'skillsRead', 'bash'],
    runMode: 'custom',
    providers: []
  })

  assert.equal(normalized.enabledTools, undefined)
  assert.equal(normalized.runMode, undefined)
})

test('toToolModelSettings resolves the configured auxiliary model snapshot', () => {
  const config = {
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    toolModel: {
      mode: 'custom' as const,
      providerId: 'provider-backup',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    },
    chat: {
      activeRunEnterBehavior: 'enter-steers' as const
    },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai' as const,
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      },
      {
        id: 'provider-backup',
        name: 'backup',
        type: 'anthropic' as const,
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: [],
          disabled: ['claude-haiku-4-5']
        }
      }
    ]
  }

  const customSnapshot = toToolModelSettings(config)
  assert.equal(customSnapshot?.providerName, 'backup')
  assert.equal(customSnapshot?.provider, 'anthropic')
  assert.equal(customSnapshot?.model, 'claude-haiku-4-5')
  assert.equal(customSnapshot?.apiKey, 'sk-ant')

  assert.equal(
    toToolModelSettings({
      ...config,
      toolModel: {
        mode: 'disabled',
        providerId: '',
        providerName: '',
        model: ''
      }
    }),
    null
  )
})

test('normalizeSettingsConfig falls back to the default active-run input behavior', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).chat, {
    activeRunEnterBehavior: 'enter-steers',
    stripCompact: true,
    stripCompactThresholdTokens: DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
    autoMemoryDistillation: true,
    inputBufferEnabled: false,
    recapEnabled: true
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      chat: {
        activeRunEnterBehavior: 'not-a-real-mode'
      },
      providers: []
    }).chat,
    {
      activeRunEnterBehavior: 'enter-steers',
      stripCompact: true,
      stripCompactThresholdTokens: DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
      autoMemoryDistillation: true,
      inputBufferEnabled: false,
      recapEnabled: true
    }
  )
})

test('normalizeSettingsConfig normalizes context handoff threshold', () => {
  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      chat: { stripCompactThresholdTokens: 150_000 }
    }).chat?.stripCompactThresholdTokens,
    150_000
  )

  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      chat: { stripCompactThresholdTokens: 0 }
    }).chat?.stripCompactThresholdTokens,
    DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD
  )
})

test('normalizeSettingsConfig falls back to the default tool model mode', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).toolModel, {
    mode: DEFAULT_TOOL_MODEL_MODE,
    providerId: '',
    providerName: '',
    model: ''
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      toolModel: {
        mode: 'not-a-real-mode',
        providerId: 'provider-work',
        providerName: 'work',
        model: 'gpt-5-mini'
      },
      providers: []
    }).toolModel,
    {
      mode: DEFAULT_TOOL_MODEL_MODE,
      providerId: 'provider-work',
      providerName: 'work',
      model: 'gpt-5-mini'
    }
  )
})

test('normalizeSettingsConfig fills memory defaults and preserves a valid config', () => {
  const defaults = normalizeSettingsConfig({ providers: [] })
  assert.deepEqual(defaults.memory, {
    enabled: true,
    autoRecall: true
  })

  const configured = normalizeSettingsConfig({
    providers: [],
    memory: {
      enabled: true,
      autoRecall: false
    }
  })

  assert.deepEqual(configured.memory, {
    enabled: true,
    autoRecall: false
  })
})

test('normalizeUserPrompts filters invalid and duplicate entries', () => {
  assert.deepEqual(normalizeUserPrompts(null), [])
  assert.deepEqual(normalizeUserPrompts([]), [])

  const result = normalizeUserPrompts([
    { keycode: 'standup', text: 'Daily standup update' },
    { keycode: 'fix', text: 'Please fix:' },
    { keycode: 'standup', text: 'duplicate — should be dropped' },
    { keycode: '1invalid', text: 'starts with digit' },
    { keycode: '', text: 'empty keycode' },
    { keycode: 'valid', text: '' },
    'not-an-object',
    null
  ])

  assert.deepEqual(result, [
    { keycode: 'standup', text: 'Daily standup update' },
    { keycode: 'fix', text: 'Please fix:' }
  ])
})

test('normalizeUserPrompts accepts hyphens in keycodes', () => {
  const result = normalizeUserPrompts([{ keycode: 'my-prompt', text: 'some text' }])
  assert.deepEqual(result, [{ keycode: 'my-prompt', text: 'some text' }])
})

test('[[prompts]] TOML round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-prompts-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    const config: Parameters<typeof store.write>[0] = {
      ...DEFAULT_SETTINGS_CONFIG,
      prompts: [
        { keycode: 'standup', text: 'Daily standup update' },
        { keycode: 'fix', text: 'Please fix:' }
      ]
    }

    store.write(config)

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /\[\[prompts\]\]/)
    assert.match(toml, /keycode = "standup"/)
    assert.match(toml, /text = "Daily standup update"/)
    assert.match(toml, /keycode = "fix"/)

    const read = store.read()
    assert.deepEqual(read.prompts, config.prompts)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('[[prompts]] with multiline text round-trips correctly', () => {
  const original = { keycode: 'essay', text: 'Line one\nLine two\nLine three' } // no leading/trailing whitespace
  const toml = stringifySettingsToml({ ...DEFAULT_SETTINGS_CONFIG, prompts: [original] })
  const parsed = parseSettingsToml(toml)
  assert.deepEqual(parsed.prompts, [original])
})

test('normalizeSettingsConfig returns empty prompts array by default', () => {
  const normalized = normalizeSettingsConfig({ providers: [] })
  assert.deepEqual(normalized.prompts, [])
})

test('normalizeSettingsConfig fills webSearch defaults and preserves imported browser session metadata', () => {
  const normalized = normalizeSettingsConfig({
    providers: [],
    webSearch: {
      defaultProvider: 'google-browser',
      browserSession: {
        sourceBrowser: 'google-chrome',
        sourceProfileName: 'Profile 3',
        importedAt: '2026-03-21T12:00:00.000Z'
      }
    }
  })

  assert.equal(normalized.webSearch?.defaultProvider, 'google-browser')
  assert.equal(normalized.webSearch?.browserSession?.sourceBrowser, 'google-chrome')
  assert.equal(normalized.webSearch?.browserSession?.sourceProfileName, 'Profile 3')
  assert.equal(normalized.webSearch?.browserSession?.importedAt, '2026-03-21T12:00:00.000Z')
  assert.equal(normalized.webSearch?.exa?.apiKey, '')
})

test('normalizeSettingsConfig assigns ids to legacy providers without ids', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        name: 'legacy',
        type: 'openai',
        apiKey: 'sk-legacy',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.match(normalized.providers[0]?.id ?? '', /^[0-9a-f-]{36}$/u)
})

test('normalizeSettingsConfig backfills tool-model providerId from providerName', () => {
  const normalized = normalizeSettingsConfig({
    toolModel: {
      mode: 'custom',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      },
      {
        id: 'provider-backup',
        name: 'backup',
        type: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: [],
          disabled: ['claude-haiku-4-5']
        }
      }
    ]
  })

  assert.equal(normalized.toolModel?.providerId, 'provider-backup')
  assert.equal(normalized.toolModel?.providerName, 'backup')
})

test('normalizeSettingsConfig disables a custom tool model when its provider disappears', () => {
  const normalized = normalizeSettingsConfig({
    toolModel: {
      mode: 'custom',
      providerId: 'provider-backup',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.deepEqual(normalized.toolModel, {
    mode: 'disabled',
    providerId: '',
    providerName: '',
    model: ''
  })
})

test('normalizeSettingsConfig repairs a stale custom tool-model model selection', () => {
  const normalized = normalizeSettingsConfig({
    toolModel: {
      mode: 'custom',
      providerId: 'provider-backup',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    },
    providers: [
      {
        id: 'provider-backup',
        name: 'backup',
        type: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: ['claude-sonnet-4-5'],
          disabled: ['claude-opus-4-6']
        }
      }
    ]
  })

  assert.deepEqual(normalized.toolModel, {
    mode: 'custom',
    providerId: 'provider-backup',
    providerName: 'backup',
    model: 'claude-sonnet-4-5'
  })
})

test('toToolModelSettings resolves providers by providerId when the name changes', () => {
  const snapshot = toToolModelSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    toolModel: {
      mode: 'custom',
      providerId: 'provider-backup',
      providerName: 'old-backup-name',
      model: 'claude-haiku-4-5'
    },
    providers: [
      {
        id: 'provider-backup',
        name: 'backup-renamed',
        type: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: [],
          disabled: ['claude-haiku-4-5']
        }
      }
    ]
  })

  assert.equal(snapshot?.providerName, 'backup-renamed')
  assert.equal(snapshot?.model, 'claude-haiku-4-5')
})

test('normalizeToolModelMode accepts default as a valid mode', () => {
  const normalized = normalizeSettingsConfig({
    toolModel: { mode: 'default' },
    providers: []
  })
  assert.equal(normalized.toolModel?.mode, 'default')
})

test('toToolModelSettings with default mode delegates to the chat default model', () => {
  const snapshot = toToolModelSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    defaultModel: { providerName: 'work', model: 'gpt-5' },
    toolModel: { mode: 'default' },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(snapshot?.providerName, 'work')
  assert.equal(snapshot?.model, 'gpt-5')
})

test('toToolModelSettings with default mode and no defaultModel falls back to primary provider', () => {
  const snapshot = toToolModelSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    toolModel: { mode: 'default' },
    providers: [
      {
        id: 'provider-work',
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      }
    ]
  })

  assert.equal(snapshot?.providerName, 'work')
  assert.equal(snapshot?.model, 'gpt-5')
})

test('normalizeSettingsConfig falls back to the default sidebar visibility', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).general, {
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY,
    demoMode: false,
    preventSystemSleep: false,
    notifyRunCompleted: true,
    notifyCodingTaskStarted: true,
    sidebarPreview: true,
    workSummary: true,
    notifyCodingTaskFinished: true,
    translatorShortcut: 'CommandOrControl+Shift+T',
    jotdownShortcut: 'CommandOrControl+Shift+J',
    activityTracking: { mode: 'simple', ocr: { enabled: false, excludedApps: [] } },
    themeId: DEFAULT_THEME_ID,
    themeAppearance: DEFAULT_THEME_APPEARANCE
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      general: {
        sidebarVisibility: 'not-a-real-sidebar-state'
      },
      providers: []
    }).general,
    {
      sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY,
      sidebarPreview: true,
      workSummary: true,
      demoMode: false,
      preventSystemSleep: false,
      notifyRunCompleted: true,
      notifyCodingTaskStarted: true,
      notifyCodingTaskFinished: true,
      translatorShortcut: 'CommandOrControl+Shift+T',
      jotdownShortcut: 'CommandOrControl+Shift+J',
      activityTracking: { mode: 'simple', ocr: { enabled: false, excludedApps: [] } },
      themeId: DEFAULT_THEME_ID,
      themeAppearance: DEFAULT_THEME_APPEARANCE
    }
  )
})

test('normalizeSettingsConfig normalizes theme preferences', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).general, {
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY,
    sidebarPreview: true,
    workSummary: true,
    demoMode: false,
    preventSystemSleep: false,
    notifyRunCompleted: true,
    notifyCodingTaskStarted: true,
    notifyCodingTaskFinished: true,
    translatorShortcut: 'CommandOrControl+Shift+T',
    jotdownShortcut: 'CommandOrControl+Shift+J',
    activityTracking: { mode: 'simple', ocr: { enabled: false, excludedApps: [] } },
    themeId: DEFAULT_THEME_ID,
    themeAppearance: DEFAULT_THEME_APPEARANCE
  })

  const normalized = normalizeSettingsConfig({
    general: { themeId: 'sumi', themeAppearance: 'dark' },
    providers: []
  })
  assert.equal(normalized.general?.themeId, 'sumi')
  assert.equal(normalized.general?.themeAppearance, 'dark')

  const fallback = normalizeSettingsConfig({
    general: { themeId: 'not-a-real-theme', themeAppearance: 'neon' },
    providers: []
  })
  assert.equal(fallback.general?.themeId, DEFAULT_THEME_ID)
  assert.equal(fallback.general?.themeAppearance, DEFAULT_THEME_APPEARANCE)
})
