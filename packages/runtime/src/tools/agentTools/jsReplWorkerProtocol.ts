export interface JsReplSerializedError {
  name: string
  message: string
  stack?: string
}

export interface JsReplWorkerFetchRequest {
  url: string
  init: {
    method?: string
    headers?: [string, string][]
    bodyBase64?: string
    redirect?: RequestRedirect
    referrer?: string
    referrerPolicy?: ReferrerPolicy
    credentials?: RequestCredentials
    cache?: RequestCache
    mode?: RequestMode
    integrity?: string
    keepalive?: boolean
  }
}

export interface JsReplWorkerFetchSuccess {
  status: number
  statusText: string
  headers: [string, string][]
  body?: ReadableStream<Uint8Array>
  url: string
  redirected: boolean
  type: ResponseType
}

export type JsReplWorkerFetchResult = JsReplWorkerFetchSuccess | { error: JsReplSerializedError }

export type JsReplParentMessage =
  | {
      type: 'init'
      workspacePath: string
      toolNames: string[]
    }
  | {
      type: 'execute'
      runId: string
      code: string
      cwd: string
      reset: boolean
      timeoutMs: number
    }
  | {
      type: 'toolResult'
      runId: string
      callId: number
      result: { ok: true; value: unknown } | { ok: false; error: JsReplSerializedError }
    }
  | {
      type: 'fetchResult'
      runId: string
      callId: number
      result: JsReplWorkerFetchResult
    }

export type JsReplWorkerMessage =
  | { type: 'ready' }
  | {
      type: 'toolCall'
      runId: string
      callId: number
      toolName: string
      input: unknown
    }
  | {
      type: 'fetchCall'
      runId: string
      callId: number
      request: JsReplWorkerFetchRequest
    }
  | {
      type: 'result'
      runId: string
      result?: string
      consoleLines: string[]
      displayOutputs: string[]
      error?: string
      timedOut: boolean
    }
