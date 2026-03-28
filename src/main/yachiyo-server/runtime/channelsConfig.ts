/**
 * Read/write helper for ~/.yachiyo/channels.toml.
 *
 * Kept intentionally separate from config.toml so channel settings (including
 * bot tokens) never need to touch the main settings normalisation pipeline.
 *
 * File format:
 *
 *   [telegram]
 *   enabled = true
 *   bot_token = "123456:ABC-DEF..."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { resolveYachiyoChannelsPath } from '../config/paths.ts'
import type { ChannelsConfig } from '../../../shared/yachiyo/protocol.ts'

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

// ─── TOML parser ──────────────────────────────────────────────────────────────

export function parseChannelsToml(raw: string): ChannelsConfig {
  const config: ChannelsConfig = {}
  let section = ''

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      continue
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/)
    if (!kvMatch) continue

    const key = kvMatch[1].trim()
    const rawVal = kvMatch[2].trim()

    if (section === 'telegram') {
      if (!config.telegram) {
        config.telegram = { enabled: false, botToken: '' }
      }
      if (key === 'enabled') {
        config.telegram.enabled = rawVal === 'true'
      } else if (key === 'bot_token') {
        config.telegram.botToken = unquote(rawVal)
      } else if (key === 'model_provider') {
        if (!config.telegram.model) config.telegram.model = { providerName: '', model: '' }
        config.telegram.model.providerName = unquote(rawVal)
      } else if (key === 'model_name') {
        if (!config.telegram.model) config.telegram.model = { providerName: '', model: '' }
        config.telegram.model.model = unquote(rawVal)
      }
    }
  }

  return config
}

// ─── TOML serializer ─────────────────────────────────────────────────────────

export function stringifyChannelsToml(config: ChannelsConfig): string {
  const lines: string[] = []

  if (config.telegram !== undefined) {
    lines.push('[telegram]')
    lines.push(`enabled = ${config.telegram.enabled ? 'true' : 'false'}`)
    lines.push(`bot_token = ${quoteToml(config.telegram.botToken)}`)
    if (config.telegram.model?.providerName && config.telegram.model?.model) {
      lines.push(`model_provider = ${quoteToml(config.telegram.model.providerName)}`)
      lines.push(`model_name = ${quoteToml(config.telegram.model.model)}`)
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return value
}
