/**
 * Wraps a stdout ReadableStream and silently drops any lines that are not
 * valid JSON objects or arrays (e.g. agent setup messages, Node.js warnings,
 * ANSI escape sequences). This prevents non-JSON output from polluting the
 * ndjson protocol stream.
 */
export function filterJsonLines(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  function tryExtractJson(line: string): string | null {
    const jsonStart = line.search(/[{[]/)
    if (jsonStart < 0) return null
    const candidate = line.slice(jsonStart)
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      return null
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            const json = tryExtractJson(buffer.trim())
            if (json) {
              controller.enqueue(encoder.encode(json + '\n'))
            }
            controller.close()
            break
          }
          const chunk = decoder.decode(value, { stream: true }).replace(/\r/g, '\n')
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const raw of lines) {
            const json = tryExtractJson(raw.trim())
            if (json) {
              controller.enqueue(encoder.encode(json + '\n'))
            }
          }
        }
      } catch (err) {
        controller.error(err)
      }
    }
  })
}
