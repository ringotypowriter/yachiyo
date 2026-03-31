import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  parseChannelsToml,
  readChannelsConfig,
  stringifyChannelsToml,
  writeChannelsConfig
} from './channelsConfig.ts'

test('channels config round-trips through TOML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-channels-config-'))
  const filePath = join(root, 'channels.toml')

  try {
    const config = {
      telegram: {
        enabled: true,
        botToken: 'telegram-token',
        model: { providerName: 'main', model: 'gpt-5' },
        group: {
          enabled: true,
          model: { providerName: 'group-main', model: 'gpt-4.1' },
          vision: true,
          activeCheckIntervalMs: 5000,
          engagedCheckIntervalMs: 1500,
          wakeBufferMs: 300,
          dormancyMissCount: 4,
          disengageMissCount: 2
        }
      },
      qq: {
        enabled: true,
        wsUrl: 'ws://127.0.0.1:3001',
        token: 'qq-token',
        model: { providerName: 'backup', model: 'claude-sonnet-4-5' },
        group: {
          enabled: false,
          activeCheckIntervalMs: 2500
        }
      },
      discord: {
        enabled: false,
        botToken: 'discord-token',
        model: { providerName: 'discord-main', model: 'gemini-2.5-pro' }
      },
      guestInstruction: 'Keep replies concise for guest conversations.',
      memoryFilterKeywords: ['secret', 'private'],
      imageToText: {
        enabled: true,
        model: { providerName: 'vision-main', model: 'gpt-4.1-mini' }
      },
      groupVerbosity: 0.4,
      groupCheckIntervalMs: 9000,
      dmCompactTokenThresholdK: 48,
      groupContextWindowK: 96
    }

    writeChannelsConfig(config, filePath)

    const raw = await readFile(filePath, 'utf8')
    assert.match(raw, /\[telegram\]/)
    assert.match(raw, /bot_token = "telegram-token"/)
    assert.match(raw, /\[telegram.group\]/)
    assert.match(raw, /vision = true/)
    assert.match(raw, /\[privacy\]/)
    assert.match(raw, /memory_filter_keywords = \[ "secret", "private" \]/)
    assert.match(raw, /\[image_to_text\]/)
    assert.match(raw, /\[group\]/)

    const reparsed = readChannelsConfig(filePath)
    assert.deepEqual(reparsed, config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readChannelsConfig returns empty config for invalid TOML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-channels-invalid-'))
  const filePath = join(root, 'channels.toml')

  try {
    await writeFile(filePath, '[telegram\nenabled = true\n', 'utf8')
    assert.deepEqual(readChannelsConfig(filePath), {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseChannelsToml clamps group verbosity into the supported range', () => {
  const config = parseChannelsToml(`
[group]
verbosity = 9
check_interval_ms = 12000
`)

  assert.equal(config.groupVerbosity, 1)
  assert.equal(config.groupCheckIntervalMs, 12000)
})

test('stringifyChannelsToml omits empty optional sections', () => {
  const toml = stringifyChannelsToml({
    telegram: {
      enabled: false,
      botToken: ''
    }
  })

  assert.match(toml, /\[telegram\]/)
  assert.doesNotMatch(toml, /\[privacy\]/)
  assert.doesNotMatch(toml, /\[image_to_text\]/)
  assert.doesNotMatch(toml, /\[group\]/)
})
