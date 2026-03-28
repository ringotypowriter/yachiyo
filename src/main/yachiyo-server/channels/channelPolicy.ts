/**
 * Channel policy abstraction — defines how replies are formatted and delivered
 * on a specific external surface. Each channel provides its own implementation.
 *
 * Telegram is the first concrete channel; future channels (Discord, Slack, etc.)
 * plug in their own policy while reusing the same conversation context model.
 */

import type { ChannelPlatform, ToolCallName } from '../../../shared/yachiyo/protocol.ts'
import { CHANNEL_REPLY_HINT, extractChannelReply } from './channelReply.ts'

export interface ChannelPolicy {
  /** Unique channel identifier. */
  platform: ChannelPlatform

  /** Channel-specific formatting instruction injected into the system prefix. */
  replyInstruction: string

  /** Extract the user-visible reply from raw model output. */
  extractVisibleReply(rawOutput: string): string

  /** Read-only tools safe to expose to this channel's users. */
  allowedTools: ToolCallName[]

  /** Token budget before triggering compaction to rolling summary. */
  contextTokenLimit: number

  /** Thread reuse window in milliseconds. */
  threadReuseWindowMs: number

  /** Maximum image file size in bytes. @default 5_242_880 (5 MB) */
  maxImageBytes: number

  /** Maximum number of images accepted per batch. @default 4 */
  maxImagesPerBatch: number

  /** TTL for channel-sourced images on disk, in milliseconds. @default 604_800_000 (7 days) */
  imageTtlMs: number
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000

export const telegramPolicy: ChannelPolicy = {
  platform: 'telegram',
  replyInstruction: CHANNEL_REPLY_HINT,
  extractVisibleReply: extractChannelReply,
  allowedTools: ['read', 'grep', 'glob', 'webRead', 'webSearch'],
  contextTokenLimit: 64_000,
  threadReuseWindowMs: 24 * 60 * 60 * 1_000,
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerBatch: 4,
  imageTtlMs: SEVEN_DAYS_MS
}

export const qqPolicy: ChannelPolicy = {
  platform: 'qq',
  replyInstruction: CHANNEL_REPLY_HINT,
  extractVisibleReply: extractChannelReply,
  allowedTools: ['read', 'grep', 'glob', 'webRead', 'webSearch'],
  contextTokenLimit: 64_000,
  threadReuseWindowMs: 24 * 60 * 60 * 1_000,
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerBatch: 4,
  imageTtlMs: SEVEN_DAYS_MS
}

/** Resolve the channel policy for a given platform. */
export function resolveChannelPolicy(platform: ChannelPlatform): ChannelPolicy {
  switch (platform) {
    case 'telegram':
      return telegramPolicy
    case 'qq':
      return qqPolicy
    default:
      throw new Error(`Unknown channel platform: ${platform}`)
  }
}
