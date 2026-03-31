/**
 * Read/write helper for ~/.yachiyo/channels.toml.
 *
 * Kept intentionally separate from config.toml so channel settings (including
 * bot tokens) never need to touch the main settings normalization pipeline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ChannelsConfig } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoChannelsPath } from '../config/paths.ts'
import { parseChannelsToml, stringifyChannelsToml } from './channelsTomlCodec.ts'

export type { ChannelsConfig }
export { parseChannelsToml, stringifyChannelsToml }

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

export function writeChannelsConfig(config: ChannelsConfig, filePath?: string): ChannelsConfig {
  const path = filePath ?? resolveYachiyoChannelsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyChannelsToml(config), 'utf8')
  return config
}
