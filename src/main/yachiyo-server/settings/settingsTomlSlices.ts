import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_MEMORY_PROVIDER,
  DEFAULT_TOOL_MODEL_MODE,
  DEFAULT_WEB_SEARCH_PROVIDER,
  type SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import { ensureProviderId } from '../../../shared/yachiyo/providerConfig.ts'
import type { TomlConfigSlice, TomlDoc } from '../config/tomlSlices.ts'
import { readTomlArray, readTomlTable } from '../config/tomlSlices.ts'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'

export const settingsTomlSlices: readonly TomlConfigSlice<SettingsConfig, TomlDoc>[] = [
  {
    key: 'enabledTools',
    read(doc) {
      const enabledTools = readTomlArray(doc['enabledTools'])
      return enabledTools ? { enabledTools: enabledTools as SettingsConfig['enabledTools'] } : {}
    },
    write(config) {
      return {
        enabledTools: config.enabledTools ?? DEFAULT_SETTINGS_CONFIG.enabledTools
      }
    }
  },
  {
    key: 'general',
    read(doc) {
      const general = readTomlTable(doc['general'])
      return general ? { general: general as SettingsConfig['general'] } : {}
    },
    write(config) {
      return {
        general: {
          sidebarVisibility:
            config.general?.sidebarVisibility ?? DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility,
          demoMode: config.general?.demoMode === true,
          notifyRunCompleted: config.general?.notifyRunCompleted !== false,
          notifyCodingTaskStarted: config.general?.notifyCodingTaskStarted !== false,
          notifyCodingTaskFinished: config.general?.notifyCodingTaskFinished !== false,
          ...(config.general?.updateChannel != null
            ? { updateChannel: config.general.updateChannel }
            : {}),
          ...(config.general?.uiFontSize != null ? { uiFontSize: config.general.uiFontSize } : {}),
          ...(config.general?.chatFontSize != null
            ? { chatFontSize: config.general.chatFontSize }
            : {}),
          ...(config.general?.translatorShortcut != null
            ? { translatorShortcut: config.general.translatorShortcut }
            : {}),
          ...(config.general?.jotdownShortcut != null
            ? { jotdownShortcut: config.general.jotdownShortcut }
            : {})
        }
      }
    }
  },
  {
    key: 'chat',
    read(doc) {
      const chat = readTomlTable(doc['chat'])
      return chat ? { chat: chat as SettingsConfig['chat'] } : {}
    },
    write(config) {
      return {
        chat: {
          activeRunEnterBehavior:
            config.chat?.activeRunEnterBehavior ?? DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
          stripCompact: config.chat?.stripCompact !== false,
          autoMemoryDistillation: config.chat?.autoMemoryDistillation !== false
        }
      }
    }
  },
  {
    key: 'workspace',
    read(doc) {
      const workspace = readTomlTable(doc['workspace'])
      return workspace ? { workspace: workspace as SettingsConfig['workspace'] } : {}
    },
    write(config) {
      const savedPaths = config.workspace?.savedPaths ?? []
      const rawLabels = config.workspace?.pathLabels
      // Strip labels for paths no longer in savedPaths to prevent stale context.
      const pathLabels = rawLabels
        ? Object.fromEntries(Object.entries(rawLabels).filter(([p]) => savedPaths.includes(p)))
        : undefined
      return {
        workspace: {
          savedPaths,
          ...(pathLabels && Object.keys(pathLabels).length > 0 ? { pathLabels } : {}),
          editorApp: config.workspace?.editorApp ?? '',
          terminalApp: config.workspace?.terminalApp ?? ''
        }
      }
    }
  },
  {
    key: 'skills',
    read(doc) {
      const skills = readTomlTable(doc['skills'])
      return skills ? { skills: skills as SettingsConfig['skills'] } : {}
    },
    write(config) {
      const skills: Record<string, unknown> = {
        enabled: config.skills?.enabled ?? []
      }
      const disabled = config.skills?.disabled ?? []
      if (disabled.length > 0) {
        skills.disabled = disabled
      }
      return { skills }
    }
  },
  {
    key: 'toolModel',
    read(doc) {
      const toolModel = readTomlTable(doc['toolModel'])
      return toolModel ? { toolModel: toolModel as SettingsConfig['toolModel'] } : {}
    },
    write(config) {
      return {
        toolModel: {
          mode: config.toolModel?.mode ?? DEFAULT_TOOL_MODEL_MODE,
          providerId: config.toolModel?.providerId ?? '',
          providerName: config.toolModel?.providerName ?? '',
          model: config.toolModel?.model ?? ''
        }
      }
    }
  },
  {
    key: 'defaultModel',
    read(doc) {
      const defaultModel = readTomlTable(doc['defaultModel'])
      return defaultModel
        ? { defaultModel: defaultModel as unknown as SettingsConfig['defaultModel'] }
        : {}
    },
    write(config) {
      return {
        defaultModel: {
          providerName: config.defaultModel?.providerName ?? '',
          model: config.defaultModel?.model ?? ''
        }
      }
    }
  },
  {
    key: 'memory',
    read(doc) {
      const memory = readTomlTable(doc['memory'])
      return memory ? { memory: memory as SettingsConfig['memory'] } : {}
    },
    write(config) {
      return {
        memory: {
          enabled: config.memory?.enabled === true,
          provider: config.memory?.provider ?? DEFAULT_MEMORY_PROVIDER,
          baseUrl: config.memory?.baseUrl ?? DEFAULT_MEMORY_BASE_URL
        }
      }
    }
  },
  {
    key: 'webSearch',
    read(doc) {
      const webSearch = readTomlTable(doc['webSearch'])
      return webSearch ? { webSearch: webSearch as SettingsConfig['webSearch'] } : {}
    },
    write(config) {
      return {
        webSearch: {
          defaultProvider: config.webSearch?.defaultProvider ?? DEFAULT_WEB_SEARCH_PROVIDER,
          browserSession: {
            sourceBrowser: config.webSearch?.browserSession?.sourceBrowser ?? '',
            sourceProfileName: config.webSearch?.browserSession?.sourceProfileName ?? '',
            importedAt: config.webSearch?.browserSession?.importedAt ?? '',
            lastImportError: config.webSearch?.browserSession?.lastImportError ?? ''
          },
          exa: {
            apiKey: config.webSearch?.exa?.apiKey ?? '',
            baseUrl: config.webSearch?.exa?.baseUrl ?? ''
          }
        }
      }
    }
  },
  {
    key: 'providers',
    read(doc) {
      const providers = readTomlArray(doc['providers'])
      return providers ? { providers: providers as SettingsConfig['providers'] } : {}
    },
    write(config) {
      return {
        providers: config.providers.map((provider) => ({
          id: ensureProviderId(provider.id),
          name: provider.name,
          type: provider.type,
          thinkingEnabled: provider.thinkingEnabled !== false,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          project: provider.project ?? '',
          location: provider.location ?? '',
          serviceAccountEmail: provider.serviceAccountEmail ?? '',
          serviceAccountPrivateKey: provider.serviceAccountPrivateKey ?? '',
          modelList: {
            enabled: provider.modelList.enabled,
            disabled: provider.modelList.disabled
          }
        }))
      }
    }
  },
  {
    key: 'prompts',
    read(doc) {
      const prompts = readTomlArray(doc['prompts'])
      return prompts ? { prompts: prompts as SettingsConfig['prompts'] } : {}
    },
    write(config) {
      return {
        prompts: (config.prompts ?? []).map((prompt) => ({
          keycode: prompt.keycode,
          text: prompt.text
        }))
      }
    }
  },
  {
    key: 'subagentProfiles',
    read(doc) {
      const subagentProfiles = readTomlArray(doc['subagentProfiles'])
      return subagentProfiles
        ? { subagentProfiles: subagentProfiles as SettingsConfig['subagentProfiles'] }
        : {}
    },
    write(config) {
      return {
        subagentProfiles: (config.subagentProfiles ?? []).map((profile) => ({
          id: profile.id,
          name: profile.name,
          enabled: profile.enabled,
          description: profile.description,
          command: profile.command,
          args: profile.args,
          env: profile.env,
          ...(profile.showInChatPicker !== undefined
            ? { showInChatPicker: profile.showInChatPicker }
            : {}),
          ...(profile.allowDirectChat !== undefined
            ? { allowDirectChat: profile.allowDirectChat }
            : {}),
          ...(profile.allowDelegation !== undefined
            ? { allowDelegation: profile.allowDelegation }
            : {})
        }))
      }
    }
  },
  {
    key: 'essentials',
    read(doc) {
      const essentials = readTomlArray(doc['essentials'])
      return essentials ? { essentials: essentials as SettingsConfig['essentials'] } : {}
    },
    write(config) {
      return {
        essentials: (config.essentials ?? []).map((essential) => {
          const entry: Record<string, unknown> = {
            id: essential.id,
            icon: essential.icon,
            iconType: essential.iconType,
            label: essential.label ?? '',
            workspacePath: essential.workspacePath ?? '',
            order: essential.order
          }

          if (essential.privacyMode !== undefined) {
            entry['privacyMode'] = essential.privacyMode
          }

          if (essential.modelOverride) {
            entry['modelOverride'] = {
              providerName: essential.modelOverride.providerName,
              model: essential.modelOverride.model
            }
          }

          return entry
        })
      }
    }
  }
]
