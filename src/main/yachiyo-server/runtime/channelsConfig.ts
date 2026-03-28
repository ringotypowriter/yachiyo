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
import type { ChannelsConfig, ThreadModelOverride } from '../../../shared/yachiyo/protocol.ts'

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

function parseModel(section: Record<string, unknown>): ThreadModelOverride | undefined {
  const providerName = str(section['model_provider'])
  const model = str(section['model_name'])
  return providerName && model ? { providerName, model } : undefined
}

export function parseChannelsToml(raw: string): ChannelsConfig {
  const doc = TOML.parse(raw)
  const config: ChannelsConfig = {}

  const tg = doc['telegram'] as Record<string, unknown> | undefined
  if (tg) {
    config.telegram = {
      enabled: bool(tg['enabled']),
      botToken: str(tg['bot_token']),
      ...(parseModel(tg) ? { model: parseModel(tg) } : {})
    }
  }

  const qq = doc['qq'] as Record<string, unknown> | undefined
  if (qq) {
    config.qq = {
      enabled: bool(qq['enabled']),
      wsUrl: str(qq['ws_url']),
      ...(str(qq['token']) ? { token: str(qq['token']) } : {}),
      ...(parseModel(qq) ? { model: parseModel(qq) } : {})
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

export function stringifyChannelsToml(config: ChannelsConfig): string {
  const doc: Record<string, unknown> = {}

  if (config.telegram) {
    doc['telegram'] = buildSection([
      ['enabled', config.telegram.enabled],
      ['bot_token', config.telegram.botToken],
      ['model_provider', config.telegram.model?.providerName || undefined],
      ['model_name', config.telegram.model?.model || undefined]
    ])
  }

  if (config.qq) {
    doc['qq'] = buildSection([
      ['enabled', config.qq.enabled],
      ['ws_url', config.qq.wsUrl],
      ['token', config.qq.token || undefined],
      ['model_provider', config.qq.model?.providerName || undefined],
      ['model_name', config.qq.model?.model || undefined]
    ])
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
