import { runYachiyoCli } from './yachiyoCli.ts'

runYachiyoCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Error: ${message}\n`)
  process.exitCode = 1
})
