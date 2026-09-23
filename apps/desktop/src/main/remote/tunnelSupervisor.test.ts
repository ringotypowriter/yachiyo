import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import {
  CLOUDFLARED_AGENT_LABEL,
  cloudflaredArguments,
  TunnelSupervisor,
  type CommandResult
} from './tunnelSupervisor.ts'

const QUICK_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.ringo.yachiyo.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--protocol</string>
    <string>http2</string>
    <string>--url</string>
    <string>http://127.0.0.1:47831</string>
    <string>--metrics</string>
    <string>127.0.0.1:47832</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>HOME/logs/cloudflared.log</string>
  <key>StandardErrorPath</key>
  <string>HOME/logs/cloudflared.log</string>
</dict>
</plist>
`

async function withSupervisor(
  fn: (input: {
    supervisor: TunnelSupervisor
    root: string
    commands: string[][]
    files: Set<string>
    setHostname: (hostname: string | null) => void
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-tunnel-'))
  const commands: string[][] = []
  const files = new Set(['/opt/homebrew/bin/cloudflared'])
  let hostname: string | null = null
  const supervisor = new TunnelSupervisor({
    paths: {
      launchAgentsDir: join(root, 'LaunchAgents'),
      yachiyoHome: join(root, 'home'),
      cloudflaredUserConfig: join(root, 'cloudflared', 'config.yaml')
    },
    uid: 501,
    fileExists: (path) => files.has(path),
    runner: async (command, args): Promise<CommandResult> => {
      commands.push([command, ...args])
      return { code: 0, stdout: 'state = running', stderr: '' }
    },
    fetch: (async () =>
      hostname === null
        ? new Response('unavailable', { status: 503 })
        : Response.json({ hostname })) as typeof globalThis.fetch
  })
  try {
    await fn({ supervisor, root, commands, files, setHostname: (value) => (hostname = value) })
  } finally {
    supervisor.stopMonitoring()
    await rm(root, { recursive: true, force: true })
  }
}

test('only quick tunnel arguments explicitly select HTTP/2', () => {
  const common = {
    cloudflaredPath: '/opt/homebrew/bin/cloudflared',
    port: 47831,
    metricsPort: 47832,
    namedConfigPath: '/home/remote/cloudflared-named.yml'
  }
  assert.deepEqual(cloudflaredArguments({ ...common, install: { mode: 'quick' } }), [
    common.cloudflaredPath,
    'tunnel',
    '--no-autoupdate',
    '--protocol',
    'http2',
    '--url',
    'http://127.0.0.1:47831',
    '--metrics',
    '127.0.0.1:47832'
  ])
  assert.deepEqual(
    cloudflaredArguments({
      ...common,
      install: { mode: 'named', tunnelName: 'yachiyo-mac', hostname: 'mac.example.com' }
    }),
    [
      common.cloudflaredPath,
      'tunnel',
      '--no-autoupdate',
      '--config',
      common.namedConfigPath,
      '--metrics',
      '127.0.0.1:47832',
      'run',
      'yachiyo-mac'
    ]
  )
})

test('quick tunnel LaunchAgent plist matches the expected snapshot', async () => {
  await withSupervisor(async ({ supervisor, root, commands }) => {
    await supervisor.install({ mode: 'quick' }, { port: 47831, metricsPort: 47832 })

    const plist = await readFile(supervisor.plistPath, 'utf8')
    assert.equal(plist, QUICK_PLIST.replaceAll('HOME', join(root, 'home')))
    assert.deepEqual(commands, [
      ['launchctl', 'bootout', `gui/501/${CLOUDFLARED_AGENT_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', supervisor.plistPath]
    ])
  })
})

test('named tunnel runs with its own --config and never the user cloudflared config', async () => {
  await withSupervisor(async ({ supervisor, root }) => {
    await supervisor.install(
      { mode: 'named', tunnelName: 'yachiyo-mac', hostname: 'mac.example.com' },
      { port: 47831, metricsPort: 47832 }
    )
    const plist = await readFile(supervisor.plistPath, 'utf8')
    assert.match(
      plist,
      /<string>--config<\/string>\n {4}<string>[^<]*cloudflared-named\.yml<\/string>/
    )
    assert.match(plist, /<string>run<\/string>\n {4}<string>yachiyo-mac<\/string>/)
    assert.equal(plist.includes(join(root, 'cloudflared')), false)

    assert.equal(
      await readFile(supervisor.namedConfigPath, 'utf8'),
      [
        'tunnel: yachiyo-mac',
        'ingress:',
        '  - hostname: mac.example.com',
        '    service: http://127.0.0.1:47831',
        '  - service: http_status:404',
        ''
      ].join('\n')
    )
  })
})

test('a quick tunnel is refused while ~/.cloudflared/config.yaml exists', async () => {
  await withSupervisor(async ({ supervisor, root, files, commands }) => {
    files.add(join(root, 'cloudflared', 'config.yaml'))
    await assert.rejects(
      supervisor.install({ mode: 'quick' }, { port: 1, metricsPort: 2 }),
      /named tunnel/
    )
    assert.deepEqual(commands, [])
  })
})

test('missing cloudflared is reported with the install command', async () => {
  await withSupervisor(async ({ supervisor, files }) => {
    files.clear()
    await assert.rejects(
      supervisor.install({ mode: 'quick' }, { port: 1, metricsPort: 2 }),
      /brew install cloudflared/
    )
  })
})

test('the quick tunnel hostname is read from metrics and changes are reported', async () => {
  await withSupervisor(async ({ supervisor, setHostname }) => {
    const changes: Array<RemoteEndpoint | null> = []
    const config: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, enabled: true }
    supervisor.monitor(config, (endpoint) => changes.push(endpoint))

    await supervisor.poll()
    assert.equal(changes.length, 0, 'cloudflared not answering keeps the endpoint unknown')

    setHostname('first-fox.trycloudflare.com')
    await supervisor.poll()
    await supervisor.poll()
    setHostname('second-owl.trycloudflare.com')
    await supervisor.poll()
    setHostname(null)
    await supervisor.poll()

    assert.deepEqual(
      changes.map((endpoint) => endpoint?.url),
      [
        'wss://first-fox.trycloudflare.com/remote/v1',
        'wss://second-owl.trycloudflare.com/remote/v1'
      ]
    )
    assert.equal(supervisor.endpoint(config)?.url, 'wss://second-owl.trycloudflare.com/remote/v1')
  })
})

test('named and disabled tunnels resolve endpoints without polling', async () => {
  await withSupervisor(async ({ supervisor }) => {
    const named: RemoteConfig = {
      ...DEFAULT_REMOTE_CONFIG,
      tunnel: 'named',
      namedHostname: 'mac.example.com'
    }
    assert.deepEqual(supervisor.endpoint(named), {
      kind: 'tunnel',
      url: 'wss://mac.example.com/remote/v1'
    })
    assert.equal(supervisor.endpoint({ ...DEFAULT_REMOTE_CONFIG, tunnel: 'none' }), null)
  })
})
