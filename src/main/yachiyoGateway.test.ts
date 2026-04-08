import { describe, test } from 'node:test'
import assert from 'node:assert'
import type { BrowserWindow } from 'electron'
import type { YachiyoServerEvent } from '../shared/yachiyo/protocol'
import { isHighFrequencyChatEvent, isAuxiliaryWindow } from './yachiyoGatewayFilter'

function mockWindow(url: string): BrowserWindow {
  return {
    webContents: { getURL: () => url }
  } as unknown as BrowserWindow
}

describe('isHighFrequencyChatEvent', () => {
  test('returns true for message.delta', () => {
    assert.strictEqual(
      isHighFrequencyChatEvent({ type: 'message.delta' } as unknown as YachiyoServerEvent),
      true
    )
  })

  test('returns true for message.reasoning.delta', () => {
    assert.strictEqual(
      isHighFrequencyChatEvent({
        type: 'message.reasoning.delta'
      } as unknown as YachiyoServerEvent),
      true
    )
  })

  test('returns false for other events', () => {
    assert.strictEqual(
      isHighFrequencyChatEvent({ type: 'message.completed' } as unknown as YachiyoServerEvent),
      false
    )
    assert.strictEqual(
      isHighFrequencyChatEvent({ type: 'settings.updated' } as unknown as YachiyoServerEvent),
      false
    )
  })
})

describe('isAuxiliaryWindow', () => {
  test('returns false for main window', () => {
    assert.strictEqual(isAuxiliaryWindow(mockWindow('file://app/renderer/index.html')), false)
  })

  test('returns true for settings window', () => {
    assert.strictEqual(
      isAuxiliaryWindow(mockWindow('file://app/renderer/settings/index.html')),
      true
    )
  })

  test('returns true for translator window', () => {
    assert.strictEqual(
      isAuxiliaryWindow(mockWindow('file://app/renderer/translator/index.html')),
      true
    )
  })

  test('returns true for jotdown window', () => {
    assert.strictEqual(
      isAuxiliaryWindow(mockWindow('file://app/renderer/jotdown/index.html')),
      true
    )
  })
})
