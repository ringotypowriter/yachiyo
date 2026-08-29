import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { RuntimeLiveServices } from '@yachiyo/runtime/app/host/runtimeLiveServices'
import { runAfterRuntimeLiveServicesReady } from '@yachiyo/runtime/app/host/runtimeLiveServicesReadiness'

import {
  clearPendingUpdateReceipt,
  readPendingUpdateReceipt,
  type ReadPendingUpdateReceipt
} from './pendingUpdateReceipt.ts'
import { deliverPendingUpdateReceiptAfterChannelReady } from './pendingUpdateReceiptDelivery.ts'
import { createPendingUpdateReceiptDeliveryLifecycle } from './pendingUpdateReceiptDeliveryLifecycle.ts'
import { createUpdateReceiptCoordinator } from './updateReceiptCoordinator.ts'
import { describeUpdateOutcome } from './updateReceiptMessage.ts'

type UpdateReceiptCoordinator = ReturnType<typeof createUpdateReceiptCoordinator>

export interface GatewayPendingUpdateReceiptDelivery {
  updateReceiptCoordinator: UpdateReceiptCoordinator
  receiptPath(): string
  requestDelivery(): Promise<void>
}

export function createGatewayPendingUpdateReceiptDelivery(input: {
  userDataPath: () => string
  currentVersion: () => string
  useUtilityRuntime: boolean
  hostCall: (method: string, args?: unknown[]) => Promise<unknown>
  getLiveServices: () => RuntimeLiveServices | null
}): GatewayPendingUpdateReceiptDelivery {
  const receiptPath = (): string => join(input.userDataPath(), 'pending-update-receipt.json')
  const updateReceiptCoordinator = createUpdateReceiptCoordinator({
    read: () => readPendingUpdateReceipt(receiptPath(), Date.now()),
    clear: (attemptId) => clearPendingUpdateReceipt(receiptPath(), attemptId),
    describe: (receipt) => describeUpdateOutcome(receipt, input.currentVersion()).message,
    newToken: randomUUID
  })

  const readActivelyDeliverable = (path: string): ReadPendingUpdateReceipt | undefined => {
    const pending = readPendingUpdateReceipt(path, Date.now())
    if (!pending || updateReceiptCoordinator.canActivelyDeliver(pending.attemptId)) return pending
    return undefined
  }

  const lifecycle = createPendingUpdateReceiptDeliveryLifecycle({
    deliver: async () => {
      const path = receiptPath()
      await runAfterRuntimeLiveServicesReady(
        async () => {
          if (input.useUtilityRuntime) {
            await input.hostCall('waitForLiveServicesReady')
            return
          }
          const liveServices = input.getLiveServices()
          if (!liveServices) throw new Error('Yachiyo live services are not running')
          await liveServices.start()
        },
        () =>
          deliverPendingUpdateReceiptAfterChannelReady({
            read: () => readActivelyDeliverable(path),
            waitForChannelReady: async (channelId) => {
              if (input.useUtilityRuntime) {
                await input.hostCall('waitForChannelReady', [{ channelId }])
                return
              }
              const liveServices = input.getLiveServices()
              if (!liveServices) throw new Error('Yachiyo live services are not running')
              await liveServices.waitForChannelReady(channelId)
            },
            describe: (receipt) => describeUpdateOutcome(receipt, input.currentVersion()).message,
            sendActive: async ({ channelId, message, notAfterMs }) => {
              await input.hostCall('sendChannelMessage', [
                { id: channelId, message, delivery: 'active', notAfterMs }
              ])
            },
            sendTimeoutMs: 2_000,
            clear: (attemptId) => clearPendingUpdateReceipt(path, attemptId),
            defer: (attemptId) => updateReceiptCoordinator.defer(attemptId),
            onDeliveryError: (error) => {
              console.error(
                '[update-receipt] active delivery failed, deferring to next message:',
                error
              )
            }
          })
      )
    },
    onDeliveryError: (error) =>
      console.error('[yachiyo] live services or update receipt delivery failed:', error)
  })

  return {
    updateReceiptCoordinator,
    receiptPath,
    requestDelivery: () => lifecycle.requestDelivery()
  }
}
