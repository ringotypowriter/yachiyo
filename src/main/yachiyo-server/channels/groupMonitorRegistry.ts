/**
 * Lifecycle manager for all active group monitors.
 *
 * One registry per platform service. Handles creating, routing messages to,
 * and tearing down {@link GroupMonitor} instances.
 */

import type {
  ChannelGroupRecord,
  GroupChannelConfig,
  GroupMessageEntry
} from '../../../shared/yachiyo/protocol.ts'
import type { GroupPolicyDefaults } from './channelPolicy.ts'
import {
  createGroupMonitor,
  type GroupMonitor,
  type GroupMonitorConfig,
  type GroupMonitorRestoreState,
  type Phase
} from './groupMonitor.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupMonitorRegistryCallbacks {
  /**
   * Single-pass callback: model decides + speaks (or stays silent).
   * `freshCount` is how many tail messages are new since last check.
   * Returns true if the model spoke, false if silent.
   */
  onTurn(
    group: ChannelGroupRecord,
    recentMessages: GroupMessageEntry[],
    freshCount: number
  ): Promise<boolean>
  /** State-change logger / persistence hook. */
  onStateChange(group: ChannelGroupRecord, newPhase: Phase): void
}

export interface GroupMonitorPersistence {
  save(groupId: string, phase: Phase, buffer: GroupMessageEntry[]): void
  load(groupId: string): GroupMonitorRestoreState | undefined
  delete(groupId: string): void
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
  /** Read-only snapshot of a monitor's buffer (empty if no monitor for this group). */
  getRecentMessages(groupId: string): GroupMessageEntry[]
  /** Wipe the in-memory message buffer for a group without stopping the monitor. */
  clearGroupMessages(groupId: string): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGroupMonitorRegistry(
  policyDefaults: GroupPolicyDefaults,
  configOverrides: GroupChannelConfig | undefined,
  callbacks: GroupMonitorRegistryCallbacks,
  globalCheckIntervalMs?: number,
  persistence?: GroupMonitorPersistence
): GroupMonitorRegistry {
  const monitors = new Map<string, { monitor: GroupMonitor; group: ChannelGroupRecord }>()
  const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function resolveConfig(): GroupMonitorConfig {
    const activeMs =
      configOverrides?.activeCheckIntervalMs ??
      globalCheckIntervalMs ??
      policyDefaults.activeCheckIntervalMs
    return {
      activeCheckIntervalMs: activeMs,
      engagedCheckIntervalMs:
        configOverrides?.engagedCheckIntervalMs ?? policyDefaults.engagedCheckIntervalMs,
      wakeBufferMs: configOverrides?.wakeBufferMs ?? policyDefaults.wakeBufferMs,
      dormancyMissCount: configOverrides?.dormancyMissCount ?? policyDefaults.dormancyMissCount,
      disengageMissCount: configOverrides?.disengageMissCount ?? policyDefaults.disengageMissCount,
      maxRecentMessages: policyDefaults.maxRecentMessages,
      recentMessageWindowMs: policyDefaults.recentMessageWindowMs
    }
  }

  function persistSnapshot(groupId: string, monitor: GroupMonitor): void {
    if (!persistence) return
    const { phase, buffer } = monitor.getSnapshot()
    persistence.save(groupId, phase, buffer)
  }

  function scheduleDebouncedSave(groupId: string, monitor: GroupMonitor): void {
    if (!persistence) return
    const existing = saveDebounceTimers.get(groupId)
    if (existing) clearTimeout(existing)
    saveDebounceTimers.set(
      groupId,
      setTimeout(() => {
        saveDebounceTimers.delete(groupId)
        persistSnapshot(groupId, monitor)
      }, 5_000)
    )
  }

  function clearDebouncedSave(groupId: string): void {
    const timer = saveDebounceTimers.get(groupId)
    if (timer) {
      clearTimeout(timer)
      saveDebounceTimers.delete(groupId)
    }
  }

  return {
    startMonitor(group) {
      if (monitors.has(group.id)) return

      const config = resolveConfig()
      const restoreState = persistence?.load(group.id)
      if (restoreState) {
        console.log(
          `[group-monitor] restoring ${restoreState.buffer.length} buffered messages for "${group.name}"`
        )
      }

      const monitor = createGroupMonitor(
        config,
        {
          onTurn: (messages, freshCount) => callbacks.onTurn(group, messages, freshCount),
          onStateChange: (newPhase) => {
            callbacks.onStateChange(group, newPhase)
            persistSnapshot(group.id, monitor)
          }
        },
        restoreState
      )

      monitors.set(group.id, { monitor, group })
      console.log(`[group-monitor] started monitor for group "${group.name}" (${group.id})`)
    },

    stopMonitor(groupId) {
      const entry = monitors.get(groupId)
      if (!entry) return

      clearDebouncedSave(groupId)
      persistSnapshot(groupId, entry.monitor)
      entry.monitor.stop()
      monitors.delete(groupId)
      console.log(`[group-monitor] stopped monitor for group "${entry.group.name}" (${groupId})`)
    },

    routeMessage(groupId, message) {
      const entry = monitors.get(groupId)
      if (!entry) return

      entry.monitor.onMessage(message)
      scheduleDebouncedSave(groupId, entry.monitor)
    },

    stopAll() {
      for (const [id, entry] of monitors) {
        clearDebouncedSave(id)
        persistSnapshot(id, entry.monitor)
        entry.monitor.stop()
        monitors.delete(id)
      }
      console.log('[group-monitor] stopped all monitors')
    },

    hasMonitor(groupId) {
      return monitors.has(groupId)
    },

    getRecentMessages(groupId) {
      const entry = monitors.get(groupId)
      return entry ? entry.monitor.getRecentMessages() : []
    },
    clearGroupMessages(groupId) {
      monitors.get(groupId)?.monitor.clearBuffer()
    }
  }
}
