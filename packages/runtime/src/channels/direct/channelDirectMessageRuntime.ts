import type {
  ChannelPlatform,
  ChannelsConfig,
  ComposerReasoningSelection,
  ProviderSettings,
  ChannelUserRecord,
  ThreadModelOverride,
  ThreadRecord
} from '@yachiyo/shared/protocol'
import type {
  DirectMessageCreateThreadInput,
  DirectMessageServer,
  DirectMessageService
} from './directMessageService.ts'
import {
  createDirectMessageService,
  resolveDirectMessageThread,
  type DirectMessageThreadResolution
} from './directMessageService.ts'
import {
  createDmSlashCommandPendingChoiceStore,
  handleDmSlashCommand,
  resolvePendingDmSlashCommandChoice,
  shouldDiscardPendingBatchForDmCommand,
  type DmSlashCommandServer
} from './dmSlashCommands.ts'
import type { ChannelPolicy } from '../shared/channelPolicy.ts'
import type { ChannelReplyPayload } from '../shared/channelReply.ts'
import { getReasoningSelectorState } from '@yachiyo/shared/reasoningEffort'

interface DirectMessageEffortServer {
  getChannelsConfig(): ChannelsConfig
  resolveProviderSettings(modelOverride?: ThreadModelOverride): ProviderSettings
}

export function resolveChannelDirectMessageEffort(
  server: DirectMessageEffortServer,
  platform: ChannelPlatform,
  thread: ThreadRecord
): ComposerReasoningSelection | undefined {
  const effort = server.getChannelsConfig()[platform]?.reasoningEffort
  if (effort === undefined) return undefined
  const settings = server.resolveProviderSettings(thread.modelOverride)
  const { options } = getReasoningSelectorState({ provider: settings, model: settings.model })
  if (options.includes(effort)) return effort
  console.warn(
    `[${platform}] DM effort ${effort} is unsupported by ${settings.model}; using the conversation preference`
  )
  return undefined
}

interface ChannelDirectMessageCreateThreadRequest {
  workspacePath?: string
  source?: ThreadRecord['source']
  channelUserId?: string
  title?: string
  handoffFromThreadId?: string
}

export interface ChannelDirectMessageRuntimeServer
  extends DirectMessageServer, DmSlashCommandServer, DirectMessageEffortServer {
  createThread(input?: ChannelDirectMessageCreateThreadRequest): Promise<ThreadRecord>
}

export interface ChannelDirectMessageThreadResolverServer extends Pick<
  DirectMessageServer,
  'findActiveChannelThread' | 'setThreadModelOverride' | 'getThreadTotalTokens'
> {
  createThread(input?: ChannelDirectMessageCreateThreadRequest): Promise<ThreadRecord>
}

export interface ChannelDirectMessageThreadResolverOptions {
  platform: ChannelPlatform
  logLabel: string
  server: ChannelDirectMessageThreadResolverServer
  policy: ChannelPolicy
  modelOverride?: ThreadModelOverride
  formatGuestThreadTitle(channelUser: ChannelUserRecord): string
}

export interface ChannelDirectMessageRuntimeOptions<TTarget> {
  platform: ChannelPlatform
  logLabel: string
  server: ChannelDirectMessageRuntimeServer
  policy: ChannelPolicy
  modelOverride?: ThreadModelOverride
  sendMessage(target: TTarget, text: string): Promise<void>
  sendReply?(target: TTarget, payload: ChannelReplyPayload): Promise<void>
  startBatchIndicator?(target: TTarget): void | (() => void)
  startHandlingIndicator?(target: TTarget): void | (() => void)
  replyDelayMs?(): number
  nonRunReply: string
  errorReply: string
  formatGuestThreadTitle(channelUser: ChannelUserRecord): string
}

function buildThreadInput(
  platform: ChannelPlatform,
  channelUser: ChannelUserRecord,
  formatGuestThreadTitle: (channelUser: ChannelUserRecord) => string,
  input?: DirectMessageCreateThreadInput
): ChannelDirectMessageCreateThreadRequest {
  return {
    source: platform,
    channelUserId: channelUser.id,
    ...(channelUser.role === 'owner'
      ? input?.workspacePath
        ? { workspacePath: input.workspacePath }
        : {}
      : {
          workspacePath: channelUser.workspacePath,
          title: formatGuestThreadTitle(channelUser)
        }),
    ...(input?.handoffFromThreadId ? { handoffFromThreadId: input.handoffFromThreadId } : {})
  }
}

export function createChannelDirectMessageThreadResolver(
  options: ChannelDirectMessageThreadResolverOptions
): (channelUser: ChannelUserRecord) => Promise<DirectMessageThreadResolution> {
  return (channelUser) =>
    resolveDirectMessageThread({
      logLabel: options.logLabel,
      server: options.server,
      channelUser,
      policy: options.policy,
      modelOverride: options.modelOverride,
      createThread: (input) =>
        options.server.createThread(
          buildThreadInput(options.platform, channelUser, options.formatGuestThreadTitle, input)
        )
    })
}

export function createChannelDirectMessageRuntime<TTarget>(
  options: ChannelDirectMessageRuntimeOptions<TTarget>
): DirectMessageService<TTarget> {
  const slashCommandPendingChoices = createDmSlashCommandPendingChoiceStore()
  const resolveThread = createChannelDirectMessageThreadResolver(options)
  const directMessages = createDirectMessageService<TTarget>({
    logLabel: options.logLabel,
    server: options.server,
    policy: options.policy,
    resolveThread,
    resolveReasoningEffort: (thread) =>
      resolveChannelDirectMessageEffort(options.server, options.platform, thread),
    sendMessage: options.sendMessage,
    sendReply: options.sendReply,
    startBatchIndicator: options.startBatchIndicator,
    startHandlingIndicator: options.startHandlingIndicator,
    replyDelayMs: options.replyDelayMs,
    nonRunReply: options.nonRunReply,
    errorReply: options.errorReply,
    shouldDiscardPendingBatch: shouldDiscardPendingBatchForDmCommand,
    resolvePlainTextCommand: (channelUser, text) =>
      resolvePendingDmSlashCommandChoice(slashCommandPendingChoices, channelUser, text),
    handleSlashCommand: (target, channelUser, command, args, context) =>
      handleDmSlashCommand(
        {
          server: options.server,
          threadReuseWindowMs: options.policy.threadReuseWindowMs,
          contextTokenLimit: options.policy.contextTokenLimit,
          pendingChoices: slashCommandPendingChoices,
          createFreshThread: (user) =>
            options.server.createThread(
              buildThreadInput(options.platform, user, options.formatGuestThreadTitle)
            ),
          sendMessage: options.sendMessage,
          requestStop: (userId) => directMessages.requestStop(userId)
        },
        target,
        channelUser,
        command,
        args,
        context
      )
  })

  return directMessages
}
