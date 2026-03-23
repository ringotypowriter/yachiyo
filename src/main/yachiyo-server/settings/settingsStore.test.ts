import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_TOOL_MODEL_MODE,
  DEFAULT_SIDEBAR_VISIBILITY
} from '../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SETTINGS_CONFIG,
  createSettingsStore,
  normalizeSettingsConfig,
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
        sidebarVisibility: 'collapsed'
      },
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up'
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
      providers: [
        {
          id: 'provider-work',
          name: 'work',
          type: 'openai' as const,
          apiKey: 'sk-work',
          baseUrl: 'https://openrouter.example/v1',
          modelList: {
            enabled: ['gpt-5', 'gpt-4.1'],
            disabled: ['o3-mini']
          }
        },
        {
          id: 'provider-backup',
          name: 'backup',
          type: 'anthropic' as const,
          apiKey: 'sk-ant',
          baseUrl: '',
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
    assert.match(toml, /enabledTools = \["read","bash"\]/)
    assert.match(toml, /\[general\]/)
    assert.match(toml, /sidebarVisibility = "collapsed"/)
    assert.match(toml, /activeRunEnterBehavior = "enter-queues-follow-up"/)
    assert.match(toml, /\[workspace\]/)
    assert.match(
      toml,
      /savedPaths = \["\/Users\/ringo\/projects\/yachiyo","\/Users\/ringo\/projects\/handshake"\]/
    )
    assert.match(toml, /\[skills\]/)
    assert.match(toml, /enabled = \["workspace-refactor","release-checklist"\]/)
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
    assert.match(toml, /\[providers\.modelList\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('normalizeSettingsConfig keeps vertex providers', () => {
  const normalized = normalizeSettingsConfig({
    providers: [
      {
        id: 'provider-vertex',
        name: 'vertex-work',
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

  assert.equal(normalized.providers[0]?.type, 'vertex')
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
    activeRunEnterBehavior: 'enter-steers'
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      chat: {
        activeRunEnterBehavior: 'not-a-real-mode'
      },
      providers: []
    }).chat,
    {
      activeRunEnterBehavior: 'enter-steers'
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
    mode: DEFAULT_TOOL_MODEL_MODE,
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

test('normalizeSettingsConfig falls back to the default sidebar visibility', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).general, {
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      general: {
        sidebarVisibility: 'not-a-real-sidebar-state'
      },
      providers: []
    }).general,
    {
      sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY
    }
  )
})
