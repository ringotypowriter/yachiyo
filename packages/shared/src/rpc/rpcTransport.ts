export interface RpcErrorShape {
  name: string
  message: string
  stack?: string
}

export interface RpcRequestMessage {
  kind: 'rpc:request'
  id: number
  method: string
  args: unknown[]
  expectsProgress?: boolean
}

export type RpcResponseMessage =
  | { kind: 'rpc:response'; id: number; ok: true; value: unknown }
  | { kind: 'rpc:response'; id: number; ok: false; error: RpcErrorShape }

export interface RpcProgressMessage {
  kind: 'rpc:progress'
  id: number
  value: unknown
}

export interface RpcEventMessage {
  kind: 'rpc:event'
  payload: unknown
}

export type RpcMessage =
  | RpcRequestMessage
  | RpcResponseMessage
  | RpcProgressMessage
  | RpcEventMessage

export interface RpcTransport {
  post(message: RpcMessage): void
  onMessage(handler: (message: RpcMessage) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}
