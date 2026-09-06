import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
const signingPath = builderRequire.resolve('app-builder-lib/out/codeSign/macCodeSign.js')
const signingRequire = createRequire(signingPath)

for (const installer of [false, true]) {
  test(`keychain patch preserves certificate passwords (installer=${installer})`, async () => {
    const commands = []
    const exports = {}
    vm.runInNewContext(readFileSync(signingPath, 'utf8'), {
      exports,
      __dirname: new URL('.', `file://${signingPath}`).pathname,
      process: { env: { TRAVIS: 'true' } },
      require(id) {
        if (id === 'builder-util') {
          return {
            exec: async (file, args) => {
              assert.equal(file, '/usr/bin/security')
              commands.push(Array.from(args))
              return ''
            }
          }
        }
        if (id === './codesign') {
          return { importCertificate: async (link) => link }
        }
        return signingRequire(id)
      }
    })
    await exports.createKeychain({
      tmpDir: {},
      currentDir: '/test/project',
      cscLink: '/test/application.p12',
      cscKeyPassword: 'application-password',
      ...(installer
        ? { cscILink: '/test/installer.p12', cscIKeyPassword: 'installer-password' }
        : {})
    })
    /** @type {(command: string[], flag: string) => string} */
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript uses the JSDoc return type above.
    const argument = (command, flag) => command[command.indexOf(flag) + 1]
    const keychainPassword = argument(
      commands.find(([name]) => name === 'create-keychain'),
      '-p'
    )
    assert.notEqual(keychainPassword, 'application-password')
    assert.equal(
      argument(
        commands.find(([name]) => name === 'unlock-keychain'),
        '-p'
      ),
      keychainPassword
    )
    const imports = commands.filter(([name]) => name === 'import')
    assert.deepEqual(
      imports.map((command) => argument(command, '-P')),
      installer ? ['application-password', 'installer-password'] : ['application-password']
    )
    const permissions = commands.filter(([name]) => name === 'set-key-partition-list')
    assert.equal(permissions.length, imports.length)
    for (const command of permissions) {
      assert.equal(argument(command, '-k'), keychainPassword)
    }
  })
}
