import type { ChatAccepted, SendChatInput } from '@yachiyo/shared/protocol'
import {
  isRemoteMethodName,
  REMOTE_MUTATING_METHODS,
  remoteMethods,
  type RemoteChatAccepted,
  type RemoteMethodInput,
  type RemoteMethodName,
  type RemoteMethodOutput
} from '@yachiyo/shared/remote/methods'
import { projectMessage } from '@yachiyo/shared/remote/project'
import type { RemoteThreadSummary } from '@yachiyo/shared/remote/projections'
import { REMOTE_PROTOCOL_VERSION } from '@yachiyo/shared/remote/protocolVersion'
import type { RpcMethods } from '@yachiyo/shared/rpc/rpcClient'
import type { RemoteHostOps } from '@yachiyo/runtime/app/host/remote/remoteHostOps'
import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'

import type { AttachmentStaging } from './attachmentStaging.ts'
import { RemoteError } from './remoteErrors.ts'
import type { RemoteEventSubscription } from './remoteEventHub.ts'

/** Server methods the facade calls; in production this is the runtime RPC proxy. */
export type RemoteServerPort = RpcMethods<
  Pick<
    YachiyoServer,
    | 'createThread'
    | 'sendChat'
    | 'retryMessage'
    | 'editMessage'
    | 'selectReplyBranch'
    | 'createBranch'
    | 'cancelRun'
    | 'answerToolQuestion'
    | 'withdrawPendingSteer'
    | 'deleteMessageFromHere'
    | 'starThread'
    | 'archiveThread'
    | 'readThreadPlanDocument'
    | 'acceptThreadPlanDocument'
    | 'setThreadModelOverride'
    | 'setThreadIcon'
  >
>

export type RemoteHostPort = RpcMethods<RemoteHostOps>

export interface RemoteFacadeIdentity {
  remoteDeviceId: string
  deviceName: string
  appVersion: string
}

export interface RemoteCallContext {
  pairingId: string
  subscription: RemoteEventSubscription
}

export interface RemoteFacadeOptions {
  server: RemoteServerPort
  host: RemoteHostPort
  attachments: AttachmentStaging
  identity: () => RemoteFacadeIdentity
  epoch: () => string
  audit: (line: string) => void
}

export interface RemoteFacade {
  dispatch(context: RemoteCallContext, method: string, input: unknown): Promise<unknown>
}

type Handler<M extends RemoteMethodName> = (
  input: RemoteMethodInput<M>,
  context: RemoteCallContext
) => Promise<RemoteMethodOutput<M>>

type HandlerTable = { [M in RemoteMethodName]: Handler<M> }

const OK = { ok: true } as const

function projectAccepted(accepted: ChatAccepted): RemoteChatAccepted {
  if (accepted.kind === 'active-run-steer-pending') {
    return { kind: accepted.kind, threadId: accepted.thread.id, runId: accepted.runId }
  }
  const userMessage = projectMessage(accepted.userMessage)
  return {
    kind: accepted.kind === 'active-run-steer' ? 'active-run-steer-pending' : accepted.kind,
    threadId: accepted.thread.id,
    runId: accepted.runId,
    ...(userMessage ? { userMessage } : {})
  }
}

function describeIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>
}): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`)
    .join('; ')
}

/**
 * The only surface the phone can reach. Every input is parsed with the shared zod schema,
 * every result is a projection, and every state-changing call leaves one audit line.
 */
export function createRemoteFacade(options: RemoteFacadeOptions): RemoteFacade {
  const { server, host, attachments } = options

  async function summaryOf(threadId: string): Promise<RemoteThreadSummary> {
    const summary = await host['host.remote.getThreadSummary']({ threadId })
    if (!summary) throw new RemoteError('RemoteNotFound', 'Thread not found.')
    return summary
  }

  async function withAttachments(
    pairingId: string,
    attachmentIds: readonly string[] | undefined
  ): Promise<Pick<SendChatInput, 'images' | 'attachments'>> {
    if (!attachmentIds?.length) return {}
    const resolved = await attachments.consume(pairingId, attachmentIds)
    return {
      ...(resolved.images.length ? { images: resolved.images } : {}),
      ...(resolved.attachments.length ? { attachments: resolved.attachments } : {})
    }
  }

  const handlers: HandlerTable = {
    'remote.hello': async () => {
      const identity = options.identity()
      const info = await host['host.remote.getHostInfo']()
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        remoteDeviceId: identity.remoteDeviceId,
        ...(info.syncDeviceId ? { syncDeviceId: info.syncDeviceId } : {}),
        deviceName: identity.deviceName,
        appVersion: identity.appVersion,
        epoch: options.epoch(),
        activeRunEnterBehavior: info.activeRunEnterBehavior
      }
    },
    'threads.list': (input) => host['host.remote.listThreadSummaries'](input),
    'threads.load': (input) => host['host.remote.loadThread'](input),
    'threads.create': async (input) => {
      const thread = await server.createThread(input)
      return { thread: await summaryOf(thread.id) }
    },
    'threads.search': (input) => host['host.remote.search'](input),
    'threads.star': async (input) => {
      await server.starThread(input)
      return OK
    },
    'threads.archive': async (input) => {
      await server.archiveThread({ threadId: input.threadId })
      return OK
    },
    'workspaces.listRecent': () => host['host.remote.listRecentWorkspaces'](),
    'models.listSelectable': () => host['host.remote.listSelectableModels'](),
    'chat.send': async (input, context) => {
      const accepted = await server.sendChat({
        threadId: input.threadId,
        content: input.content,
        ...(await withAttachments(context.pairingId, input.attachmentIds)),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        runTrigger: 'local'
      })
      return projectAccepted(accepted)
    },
    'chat.startThread': async (input, context) => {
      const essential = input.essentialId
        ? (await host['host.remote.listEssentials']()).essentials.find(
            (entry) => entry.id === input.essentialId
          )
        : undefined
      if (input.essentialId && !essential) {
        throw new RemoteError('RemoteNotFound', 'Essential not found.')
      }
      // Resolve attachments first so a rejected upload never leaves an empty thread behind.
      const payload = await withAttachments(context.pairingId, input.attachmentIds)
      const modelOverride = input.modelOverride ?? essential?.modelOverride
      const workspacePath = input.workspacePath ?? essential?.workspacePath
      const privacyMode = input.privacyMode ?? essential?.privacyMode
      const thread = await server.createThread({
        ...(workspacePath ? { workspacePath } : {}),
        ...(essential ? { createdFromEssentialId: essential.id } : {}),
        ...(privacyMode ? { privacyMode: true } : {}),
        ...(modelOverride ? { modelOverride } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
      })
      if (essential?.icon) await server.setThreadIcon({ threadId: thread.id, icon: essential.icon })
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: input.content,
        ...payload,
        ...(input.runMode ? { runMode: input.runMode } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        runTrigger: 'local'
      })
      return { thread: await summaryOf(thread.id), accepted: projectAccepted(accepted) }
    },
    'chat.retry': async (input) => {
      const accepted = await server.retryMessage(input)
      return { threadId: accepted.thread.id, runId: accepted.runId }
    },
    'chat.edit': async (input, context) => {
      const accepted = await server.editMessage({
        threadId: input.threadId,
        messageId: input.messageId,
        content: input.content,
        ...(await withAttachments(context.pairingId, input.attachmentIds))
      })
      return projectAccepted(accepted)
    },
    'chat.withdrawSteer': async (input) => {
      await server.withdrawPendingSteer(input)
      return OK
    },
    'chat.removeFollowUp': async (input) => {
      await server.deleteMessageFromHere(input)
      return OK
    },
    'branch.select': async (input) => {
      await server.selectReplyBranch(input)
      return OK
    },
    'branch.create': async (input) => {
      const snapshot = await server.createBranch(input)
      return { thread: await summaryOf(snapshot.thread.id) }
    },
    'run.cancel': async (input) => {
      await server.cancelRun(input)
      return OK
    },
    'run.answerToolQuestion': async (input) => {
      await server.answerToolQuestion({
        runId: input.runId,
        toolCallId: input.toolCallId,
        answer: input.answer
      })
      return OK
    },
    'plan.read': async (input) => {
      const plan = await server.readThreadPlanDocument(input)
      return { content: plan.content, ...(plan.decision ? { decision: plan.decision } : {}) }
    },
    'plan.accept': async (input) => projectAccepted(await server.acceptThreadPlanDocument(input)),
    'attachments.begin': (input, context) =>
      attachments.begin({ ...input, pairingId: context.pairingId }),
    'attachments.chunk': (input, context) =>
      attachments.chunk({ ...input, pairingId: context.pairingId }),
    'attachments.commit': (input, context) =>
      attachments.commit({ ...input, pairingId: context.pairingId }),
    'images.get': (input) => host['host.remote.getImage'](input),
    'files.get': (input) => host['host.remote.getFile'](input),
    'essentials.list': () => host['host.remote.listEssentials'](),
    'essentials.getIcon': (input) => host['host.remote.getEssentialIcon'](input),
    'appearance.get': () => host['host.remote.getAppearance'](),
    'tasks.list': (input) => host['host.remote.listTasks'](input),
    'events.subscribe': async (input, context) => {
      context.subscription.setThreads(input.threadIds)
      return context.subscription.resume(input.resumeFrom)
    }
  }

  return {
    async dispatch(context, method, rawInput) {
      if (!isRemoteMethodName(method)) {
        throw new RemoteError('RemoteMethodNotFound', `Unknown method ${method}.`)
      }
      if (
        method === 'remote.hello' &&
        (rawInput as { protocolVersion?: unknown } | null)?.protocolVersion !==
          REMOTE_PROTOCOL_VERSION
      ) {
        throw new RemoteError(
          'RemoteProtocolVersionMismatch',
          `This desktop speaks remote protocol ${REMOTE_PROTOCOL_VERSION}.`
        )
      }
      const parsed = remoteMethods[method].input.safeParse(rawInput ?? {})
      if (!parsed.success) {
        throw new RemoteError('RemoteValidationError', describeIssues(parsed.error))
      }
      if (REMOTE_MUTATING_METHODS.has(method)) {
        const threadId =
          typeof (parsed.data as { threadId?: unknown }).threadId === 'string'
            ? ` thread=${(parsed.data as { threadId: string }).threadId}`
            : ''
        options.audit(`[remote] pairing=${context.pairingId} method=${method}${threadId}`)
      }
      const handler = handlers[method] as Handler<RemoteMethodName>
      return handler(parsed.data as RemoteMethodInput<RemoteMethodName>, context)
    }
  }
}
