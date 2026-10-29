import type { RpcCallOptions, RpcClient } from '@yachiyo/shared/rpc/rpcClient'

/** Only an authenticated native host may provide desktop capabilities. */
export class AppHostBridge implements RpcClient {
  private client: RpcClient | undefined

  attach(client: RpcClient): () => void {
    if (this.client) throw new Error('A desktop host is already attached')
    this.client = client
    return () => {
      if (this.client === client) this.client = undefined
    }
  }

  get connected(): boolean {
    return this.client !== undefined
  }

  call(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown> {
    if (!this.client)
      return Promise.reject(new Error('This operation requires an attached desktop app'))
    return this.client.call(method, args, options)
  }

  subscribe(): () => void {
    throw new Error('Native host events are not part of the runtime event stream')
  }

  close(): void {
    this.client?.close()
    this.client = undefined
  }
}
