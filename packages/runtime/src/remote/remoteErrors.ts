import type { RemoteErrorName } from '@yachiyo/shared/remote/common'

/** An error whose `name` reaches the phone verbatim in `RpcErrorShape.name`. */
export class RemoteError extends Error {
  constructor(name: RemoteErrorName, message: string) {
    super(message)
    this.name = name
  }
}
