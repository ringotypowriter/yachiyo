import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const preload = ts.transpileModule(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function exposedPlaintextCredentials(argv: string[], contextIsolated: boolean): boolean {
  let exposedApi: { plaintextCredentials: boolean } | undefined
  const rendererWindow: { api?: { plaintextCredentials: boolean } } = {}
  runInNewContext(preload, {
    exports: {},
    require: (id: string) => {
      assert.equal(id, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (name: string, api: { plaintextCredentials: boolean }) => {
            assert.equal(name, 'api')
            exposedApi = api
          }
        },
        ipcRenderer: {}
      }
    },
    process: {
      argv,
      contextIsolated,
      platform: 'linux',
      versions: { electron: 'test', chrome: 'test', node: 'test' }
    },
    window: rendererWindow
  })
  const api = contextIsolated ? exposedApi : rendererWindow.api
  assert.ok(api)
  return api.plaintextCredentials
}

for (const contextIsolated of [true, false]) {
  test(`plaintext credential warning is disabled without the explicit flag (isolated: ${contextIsolated})`, () => {
    assert.equal(exposedPlaintextCredentials(['electron'], contextIsolated), false)
    assert.equal(
      exposedPlaintextCredentials(
        ['electron', '--yachiyo-plaintext-credentials=false'],
        contextIsolated
      ),
      false
    )
  })

  test(`plaintext credential warning reflects the main-process flag (isolated: ${contextIsolated})`, () => {
    assert.equal(
      exposedPlaintextCredentials(['electron', '--yachiyo-plaintext-credentials'], contextIsolated),
      true
    )
  })
}
