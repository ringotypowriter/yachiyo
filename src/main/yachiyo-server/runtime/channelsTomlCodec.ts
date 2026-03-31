import TOML from 'smol-toml'

import type { ChannelsConfig } from '../../../shared/yachiyo/protocol.ts'
import { readConfigFromTomlSlices, writeTomlDocFromSlices } from '../config/tomlSlices.ts'
import { channelsTomlSlices } from './channelsTomlSlices.ts'

export function parseChannelsToml(raw: string): ChannelsConfig {
  const doc = TOML.parse(raw)
  return readConfigFromTomlSlices<ChannelsConfig>(doc, channelsTomlSlices)
}

export function stringifyChannelsToml(config: ChannelsConfig): string {
  const doc = writeTomlDocFromSlices(config, channelsTomlSlices)
  return TOML.stringify(doc)
}
