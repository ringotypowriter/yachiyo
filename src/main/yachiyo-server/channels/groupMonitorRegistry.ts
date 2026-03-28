/**
 * Lifecycle manager for all active group monitors.
 *
 * One registry per platform service. Handles creating, routing messages to,
 * and tearing down {@link GroupMonitor} instances.
 */

import type {
  ChannelGroupRecord,
  GroupChannelConfig,
  GroupMessageEntry,
  GroupReplyDecision
} from '../../../shared/yachiyo/protocol.ts'
import type { GroupPolicyDefaults } from './channelPolicy.ts'
import {
  createGroupMonitor,
  type GroupMonitor,
  type GroupMonitorConfig,
  type Phase
} from './groupMonitor.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupMonitorRegistryCallbacks {
  /** Decide whether to reply to the recent messages. */
  onCheck(
    group: ChannelGroupRecord,
    recentMessages: GroupMessageEntry[]
  ): Promise<GroupReplyDecision>
  /** Generate + send a reply. Called only when the judge says yes. Receives full buffer for context. */
  onReply(
    group: ChannelGroupRecord,
    decision: GroupReplyDecision,
    allRecentMessages: GroupMessageEntry[]
  ): Promise<void>
  /** State-change logger / persistence hook. */
  onStateChange(group: ChannelGroupRecord, newPhase: Phase): void
}

export interface GroupMonitorRegistry {
  /** Start monitoring an approved group. Idempotent — safe to call if already running. */
  startMonitor(group: ChannelGroupRecord): void
  /** Stop monitoring a group (e.g. blocked or unapproved). */
  stopMonitor(groupId: string): void
  /** Route an incoming group message to the correct monitor. */
  routeMessage(groupId: string, entry: GroupMessageEntry): void
  /** Tear down all monitors (shutdown). */
  stopAll(): void
  /** Check whether a monitor is currently active for a group. */
  hasMonitor(groupId: string): boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGroupMonitorRegistry(
  policyDefaults: GroupPolicyDefaults,
  configOverrides: GroupChannelConfig | undefined,
  callbacks: GroupMonitorRegistryCallbacks
): GroupMonitorRegistry {
  const monitors = new Map<string, { monitor: GroupMonitor; group: ChannelGroupRecord }>()

  function resolveConfig(): GroupMonitorConfig {
    return {
      activeCheckIntervalMs:
        configOverrides?.activeCheckIntervalMs ?? policyDefaults.activeCheckIntervalMs,
      engagedCheckIntervalMs:
        configOverrides?.engagedCheckIntervalMs ?? policyDefaults.engagedCheckIntervalMs,
      wakeBufferMs: configOverrides?.wakeBufferMs ?? policyDefaults.wakeBufferMs,
      dormancyMissCount: configOverrides?.dormancyMissCount ?? policyDefaults.dormancyMissCount,
      disengageMissCount: configOverrides?.disengageMissCount ?? policyDefaults.disengageMissCount,
      maxRecentMessages: policyDefaults.maxRecentMessages,
      recentMessageWindowMs: policyDefaults.recentMessageWindowMs
    }
  }

  return {
    startMonitor(group) {
      if (monitors.has(group.id)) return

      const config = resolveConfig()
      const monitor = createGroupMonitor(config, {
        onCheck: (messages) => callbacks.onCheck(group, messages),
        onReply: (decision, allMessages) => callbacks.onReply(group, decision, allMessages),
        onStateChange: (newPhase) => callbacks.onStateChange(group, newPhase)
      })

      monitors.set(group.id, { monitor, group })
      console.log(`[group-monitor] started monitor for group "${group.name}" (${group.id})`)
    },

    stopMonitor(groupId) {
      const entry = monitors.get(groupId)
      if (!entry) return

      entry.monitor.stop()
      monitors.delete(groupId)
      console.log(`[group-monitor] stopped monitor for group "${entry.group.name}" (${groupId})`)
    },

    routeMessage(groupId, message) {
      const entry = monitors.get(groupId)
      if (!entry) return

      entry.monitor.onMessage(message)
    },

    stopAll() {
      for (const [id, entry] of monitors) {
        entry.monitor.stop()
        monitors.delete(id)
      }
      console.log('[group-monitor] stopped all monitors')
    },

    hasMonitor(groupId) {
      return monitors.has(groupId)
    }
  }
}
