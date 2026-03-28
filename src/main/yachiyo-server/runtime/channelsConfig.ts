/**
 * Read/write helper for ~/.yachiyo/channels.toml.
 *
 * Kept intentionally separate from config.toml so channel settings (including
 * bot tokens) never need to touch the main settings normalisation pipeline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import TOML from 'smol-toml'

import { resolveYachiyoChannelsPath } from '../config/paths.ts'
import type {
  ChannelsConfig,
  GroupChannelConfig,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol.ts'

export type { ChannelsConfig }

// ─── read ─────────────────────────────────────────────────────────────────────

export function readChannelsConfig(filePath?: string): ChannelsConfig {
  const path = filePath ?? resolveYachiyoChannelsPath()

  if (!existsSync(path)) {
    return {}
  }

  try {
    const raw = readFileSync(path, 'utf8')
    return parseChannelsToml(raw)
  } catch {
    return {}
  }
}

// ─── write ────────────────────────────────────────────────────────────────────

export function writeChannelsConfig(config: ChannelsConfig, filePath?: string): ChannelsConfig {
  const path = filePath ?? resolveYachiyoChannelsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyChannelsToml(config), 'utf8')
  return config
}

// ─── TOML parse ──────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

function parseModel(section: Record<string, unknown>): ThreadModelOverride | undefined {
  const providerName = str(section['model_provider'])
  const model = str(section['model_name'])
  return providerName && model ? { providerName, model } : undefined
}

function parseGroupConfig(section: Record<string, unknown>): GroupChannelConfig | undefined {
  const group = section['group'] as Record<string, unknown> | undefined
  if (!group) return undefined

  const enabled = bool(group['enabled'])
  if (!enabled) return { enabled: false }

  const groupModel = (() => {
    const providerName = str(group['model_provider'])
    const model = str(group['model_name'])
    return providerName && model ? { providerName, model } : undefined
  })()

  const vision = typeof group['vision'] === 'boolean' ? group['vision'] : undefined

  return {
    enabled,
    ...(groupModel ? { model: groupModel } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(int(group['active_check_interval_ms']) !== undefined
      ? { activeCheckIntervalMs: int(group['active_check_interval_ms'])! }
      : {}),
    ...(int(group['engaged_check_interval_ms']) !== undefined
      ? { engagedCheckIntervalMs: int(group['engaged_check_interval_ms'])! }
      : {}),
    ...(int(group['wake_buffer_ms']) !== undefined
      ? { wakeBufferMs: int(group['wake_buffer_ms'])! }
      : {}),
    ...(int(group['dormancy_miss_count']) !== undefined
      ? { dormancyMissCount: int(group['dormancy_miss_count'])! }
      : {}),
    ...(int(group['disengage_miss_count']) !== undefined
      ? { disengageMissCount: int(group['disengage_miss_count'])! }
      : {})
  }
}

export function parseChannelsToml(raw: string): ChannelsConfig {
  const doc = TOML.parse(raw)
  const config: ChannelsConfig = {}

  const tg = doc['telegram'] as Record<string, unknown> | undefined
  if (tg) {
    config.telegram = {
      enabled: bool(tg['enabled']),
      botToken: str(tg['bot_token']),
      ...(parseModel(tg) ? { model: parseModel(tg) } : {}),
      ...(parseGroupConfig(tg) ? { group: parseGroupConfig(tg) } : {})
    }
  }

  const qq = doc['qq'] as Record<string, unknown> | undefined
  if (qq) {
    config.qq = {
      enabled: bool(qq['enabled']),
      wsUrl: str(qq['ws_url']),
      ...(str(qq['token']) ? { token: str(qq['token']) } : {}),
      ...(parseModel(qq) ? { model: parseModel(qq) } : {}),
      ...(parseGroupConfig(qq) ? { group: parseGroupConfig(qq) } : {})
    }
  }

  const privacy = doc['privacy'] as Record<string, unknown> | undefined
  if (privacy) {
    const gi = privacy['guest_instruction']
    if (typeof gi === 'string' && gi.trim()) {
      config.guestInstruction = gi
    }

    const kw = privacy['memory_filter_keywords']
    if (Array.isArray(kw)) {
      config.memoryFilterKeywords = kw.filter((item): item is string => typeof item === 'string')
    }
  }

  return config
}

// ─── TOML serialize ──────────────────────────────────────────────────────────

function buildSection(
  entries: Array<[string, string | boolean | string[] | undefined]>
): Record<string, unknown> {
  const section: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (value !== undefined) section[key] = value
  }
  return section
}

function buildGroupSection(group: GroupChannelConfig): Record<string, unknown> {
  const section: Record<string, unknown> = { enabled: group.enabled }
  if (group.model) {
    section['model_provider'] = group.model.providerName
    section['model_name'] = group.model.model
  }
  if (group.vision !== undefined) {
    section['vision'] = group.vision
  }
  if (group.activeCheckIntervalMs !== undefined) {
    section['active_check_interval_ms'] = group.activeCheckIntervalMs
  }
  if (group.engagedCheckIntervalMs !== undefined) {
    section['engaged_check_interval_ms'] = group.engagedCheckIntervalMs
  }
  if (group.wakeBufferMs !== undefined) {
    section['wake_buffer_ms'] = group.wakeBufferMs
  }
  if (group.dormancyMissCount !== undefined) {
    section['dormancy_miss_count'] = group.dormancyMissCount
  }
  if (group.disengageMissCount !== undefined) {
    section['disengage_miss_count'] = group.disengageMissCount
  }
  return section
}

export function stringifyChannelsToml(config: ChannelsConfig): string {
  const doc: Record<string, unknown> = {}

  if (config.telegram) {
    const tgSection = buildSection([
      ['enabled', config.telegram.enabled],
      ['bot_token', config.telegram.botToken],
      ['model_provider', config.telegram.model?.providerName || undefined],
      ['model_name', config.telegram.model?.model || undefined]
    ])
    if (config.telegram.group) {
      tgSection['group'] = buildGroupSection(config.telegram.group)
    }
    doc['telegram'] = tgSection
  }

  if (config.qq) {
    const qqSection = buildSection([
      ['enabled', config.qq.enabled],
      ['ws_url', config.qq.wsUrl],
      ['token', config.qq.token || undefined],
      ['model_provider', config.qq.model?.providerName || undefined],
      ['model_name', config.qq.model?.model || undefined]
    ])
    if (config.qq.group) {
      qqSection['group'] = buildGroupSection(config.qq.group)
    }
    doc['qq'] = qqSection
  }

  const hasPrivacy =
    config.guestInstruction?.trim() ||
    (config.memoryFilterKeywords && config.memoryFilterKeywords.length > 0)

  if (hasPrivacy) {
    doc['privacy'] = buildSection([
      ['guest_instruction', config.guestInstruction?.trim() || undefined],
      [
        'memory_filter_keywords',
        config.memoryFilterKeywords?.length ? config.memoryFilterKeywords : undefined
      ]
    ])
  }

  return TOML.stringify(doc)
}
