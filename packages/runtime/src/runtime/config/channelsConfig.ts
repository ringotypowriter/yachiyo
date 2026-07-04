/**
 * Read/write helper for ~/.yachiyo/channels.toml.
 *
 * Kept intentionally separate from config.toml so channel settings (including
 * bot tokens) never need to touch the main settings normalization pipeline.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ChannelsConfig, GroupProbeHeadlessAdapterKind } from '@yachiyo/shared/protocol'
import {
  defaultGroupProbeHeadlessAdapterProviderName,
  isGroupProbeHeadlessAdapterKind
} from '@yachiyo/shared/protocol'
import { resolveYachiyoChannelsPath } from '../../config/paths.ts'
import { parseChannelsToml, stringifyChannelsToml } from './channelsTomlCodec.ts'

export type { ChannelsConfig }
export { parseChannelsToml, stringifyChannelsToml }

type ChannelsConfigEnv = Record<string, string | undefined>

const GROUP_PROBE_HEADLESS_ADAPTER_ENV = 'YACHIYO_GROUP_PROBE_HEADLESS_ADAPTER'
const GROUP_PROBE_HEADLESS_PROVIDER_ENV = 'YACHIYO_GROUP_PROBE_HEADLESS_PROVIDER'
const GROUP_PROBE_HEADLESS_MODEL_ENV = 'YACHIYO_GROUP_PROBE_HEADLESS_MODEL'
const LEGACY_CLAUDE_CODE_PROBE_ENABLED_ENV = 'YACHIYO_GROUP_CLAUDE_CODE_PROBE_ENABLED'
const LEGACY_CLAUDE_CODE_PROBE_MODEL_ENV = 'YACHIYO_GROUP_CLAUDE_CODE_PROBE_MODEL'

function readEnvString(env: ChannelsConfigEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function readEnvAdapterKind(
  env: ChannelsConfigEnv,
  key: string
): GroupProbeHeadlessAdapterKind | undefined {
  const value = readEnvString(env, key)
  if (!value) {
    return undefined
  }

  if (!isGroupProbeHeadlessAdapterKind(value)) {
    throw new Error(`${key} must be one of: claude-code`)
  }

  return value
}

function readEnvBoolean(env: ChannelsConfigEnv, key: string): boolean | undefined {
  const value = readEnvString(env, key)
  if (value === undefined) {
    return undefined
  }

  switch (value.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      throw new Error(`${key} must be one of: true, false, 1, 0, yes, no, on, off`)
  }
}

function removeGroupProbeAdapter(config: ChannelsConfig): ChannelsConfig {
  const next = { ...config }
  delete next.groupProbeAdapter
  return next
}

function applyLegacyClaudeCodeProbeEnvOverrides(
  config: ChannelsConfig,
  env: ChannelsConfigEnv
): ChannelsConfig {
  const enabled = readEnvBoolean(env, LEGACY_CLAUDE_CODE_PROBE_ENABLED_ENV)
  const model = readEnvString(env, LEGACY_CLAUDE_CODE_PROBE_MODEL_ENV)

  if (enabled === undefined && !model) {
    return config
  }

  if (enabled === false) {
    return removeGroupProbeAdapter(config)
  }

  if (!model) {
    throw new Error(`${LEGACY_CLAUDE_CODE_PROBE_MODEL_ENV} must be set`)
  }

  return {
    ...config,
    groupProbeAdapter: {
      adapter: 'claude-code',
      providerName: defaultGroupProbeHeadlessAdapterProviderName('claude-code'),
      model
    }
  }
}

function applyChannelsEnvOverrides(config: ChannelsConfig, env: ChannelsConfigEnv): ChannelsConfig {
  const adapter = readEnvAdapterKind(env, GROUP_PROBE_HEADLESS_ADAPTER_ENV)
  const providerName = readEnvString(env, GROUP_PROBE_HEADLESS_PROVIDER_ENV)
  const model = readEnvString(env, GROUP_PROBE_HEADLESS_MODEL_ENV)

  if (!adapter && !providerName && !model) {
    return applyLegacyClaudeCodeProbeEnvOverrides(config, env)
  }

  if (!adapter || !model) {
    throw new Error(
      `${GROUP_PROBE_HEADLESS_ADAPTER_ENV} and ${GROUP_PROBE_HEADLESS_MODEL_ENV} must both be set`
    )
  }

  return {
    ...config,
    groupProbeAdapter: {
      adapter,
      providerName: providerName ?? defaultGroupProbeHeadlessAdapterProviderName(adapter),
      model
    }
  }
}

// channels.toml is re-read on hot paths (twice per group probe turn), so cache the
// parsed document keyed by file stat. Env overrides are applied per call since they
// depend on the caller-supplied env.
const parsedChannelsCache = new Map<
  string,
  { mtimeMs: number; size: number; config: ChannelsConfig }
>()

export function readChannelsConfig(
  filePath?: string,
  env: ChannelsConfigEnv = process.env
): ChannelsConfig {
  const path = filePath ?? resolveYachiyoChannelsPath()

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch {
    return applyChannelsEnvOverrides({}, env)
  }

  const cached = parsedChannelsCache.get(path)
  let config: ChannelsConfig
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    config = cached.config
  } else {
    try {
      config = parseChannelsToml(readFileSync(path, 'utf8'))
    } catch {
      config = {}
    }
    parsedChannelsCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, config })
  }

  // Clone so callers can never mutate the cached object.
  return applyChannelsEnvOverrides(structuredClone(config), env)
}

export function writeChannelsConfig(config: ChannelsConfig, filePath?: string): ChannelsConfig {
  const path = filePath ?? resolveYachiyoChannelsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyChannelsToml(config), 'utf8')
  parsedChannelsCache.delete(path)
  return config
}
