import type { ProcessBroker } from '@yachiyo/runtime/services/processBroker/processBroker'

export async function createRuntimeHostServer<TServer>(input: {
  createProcessBroker: () => ProcessBroker
  createServer: (processBroker: ProcessBroker) => TServer
}): Promise<TServer> {
  const processBroker = input.createProcessBroker()
  try {
    return input.createServer(processBroker)
  } catch (startupError) {
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
