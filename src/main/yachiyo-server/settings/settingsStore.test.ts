import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_MAX_CHAT_TOKEN,
  DEFAULT_TOOL_MODEL_MODE,
  DEFAULT_SIDEBAR_VISIBILITY,
  normalizeUserPrompts
} from '../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SETTINGS_CONFIG,
  createSettingsStore,
  normalizeSettingsConfig,
  parseSettingsToml,
  stringifySettingsToml,
  toEffectiveProviderSettings,
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
      general: {
        sidebarVisibility: 'collapsed',
        demoMode: true,
        notifyRunCompleted: true,
        notifyCodingTaskStarted: true,
        notifyCodingTaskFinished: true,
        translatorShortcut: 'CommandOrControl+Shift+T',
        jotdownShortcut: 'CommandOrControl+Shift+J'
      },
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up',
        maxChatToken: 4096,
        stripCompact: true
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
        provider: 'nowledge-mem',
        baseUrl: 'http://127.0.0.1:14242'
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

    assert.deepEqual(store.read(), config)

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /enabledTools = \[.*"read".*"bash".*\]/)
    assert.match(toml, /\[general\]/)
    assert.match(toml, /sidebarVisibility = "collapsed"/)
    assert.match(toml, /demoMode = true/)
    assert.match(toml, /activeRunEnterBehavior = "enter-queues-follow-up"/)
    assert.match(toml, /maxChatToken = 4096/)
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
    assert.match(toml, /provider = "nowledge-mem"/)
    assert.match(toml, /baseUrl = "http:\/\/127\.0\.0\.1:14242"/)
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

test('normalizeSettingsConfig preserves unset chat maxChatToken and rejects invalid values', () => {
  assert.equal(normalizeSettingsConfig({ providers: [] }).chat?.maxChatToken, undefined)

  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      chat: { maxChatToken: 8192 }
    }).chat?.maxChatToken,
    8192
  )

  assert.equal(
    normalizeSettingsConfig({
      providers: [],
      chat: { maxChatToken: 0 }
    }).chat?.maxChatToken,
    DEFAULT_MAX_CHAT_TOKEN
  )
})

test('stringifySettingsToml does not materialize maxChatToken for legacy configs that never set it', () => {
  const normalized = normalizeSettingsConfig({
    providers: [],
    chat: { activeRunEnterBehavior: 'enter-steers' }
  })

  const toml = stringifySettingsToml(normalized)
  const reparsed = parseSettingsToml(toml)

  assert.doesNotMatch(toml, /maxChatToken/u)
  assert.equal(reparsed.chat?.maxChatToken, undefined)
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

test('normalizeSettingsConfig strips runtime-managed tools from user tool preferences', () => {
  const normalized = normalizeSettingsConfig({
    enabledTools: ['read', 'skillsRead', 'bash'],
    providers: []
  })

  assert.deepEqual(normalized.enabledTools, ['read', 'bash'])
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
    stripCompact: true
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
      stripCompact: true
    }
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
    enabled: false,
    provider: 'nowledge-mem',
    baseUrl: DEFAULT_MEMORY_BASE_URL
  })

  const configured = normalizeSettingsConfig({
    providers: [],
    memory: {
      enabled: true,
      provider: 'nowledge-mem',
      baseUrl: 'http://mem.local:14242'
    }
  })

  assert.deepEqual(configured.memory, {
    enabled: true,
    provider: 'nowledge-mem',
    baseUrl: 'http://mem.local:14242'
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
    notifyRunCompleted: true,
    notifyCodingTaskStarted: true,
    notifyCodingTaskFinished: true,
    translatorShortcut: 'CommandOrControl+Shift+T',
    jotdownShortcut: 'CommandOrControl+Shift+J'
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
      demoMode: false,
      notifyRunCompleted: true,
      notifyCodingTaskStarted: true,
      notifyCodingTaskFinished: true,
      translatorShortcut: 'CommandOrControl+Shift+T',
      jotdownShortcut: 'CommandOrControl+Shift+J'
    }
  )
})

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
enabled = false
provider = "nowledge-mem"
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
enabled = false
provider = "nowledge-mem"
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
