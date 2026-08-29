import type { ProcessBroker } from '@yachiyo/runtime/services/processBroker/processBroker'

export async function createRuntimeHostServer<TServer>(input: {
  createProcessBroker: () => ProcessBroker
  createServer: (processBroker: ProcessBroker) => TServer
}): Promise<TServer> {
  let processBroker: ProcessBroker | undefined
  try {
    processBroker = input.createProcessBroker()
    await processBroker.start()
    return input.createServer(processBroker)
  } catch (startupError) {
    if (!processBroker) throw startupError
    try {
      await processBroker.close()
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Runtime host startup and process broker cleanup both failed.'
      )
    }
    throw startupError
  }
}
