import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import {
  safeEndpoint,
  parseManagedPlist,
  parseIngress,
  currentQuickHostname,
  resolveQuickEndpoint,
  parseMetrics,
  parsePublicResponse,
  localProbe,
  restartTunnel,
  run
} from './watchdog-probes.mjs'

const accept = (key) =>
  createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
const plist = (port) => ({
  Label: 'sh.ringo.yachiyo.cloudflared',
  ProgramArguments: [
    '/opt/homebrew/bin/cloudflared',
    'tunnel',
    '--url',
    `http://127.0.0.1:${port}`,
    '--metrics=127.0.0.1:20241'
  ]
})

test('signal-terminated and aborted subprocesses are never reported as success', async () => {
  const timeout = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 30)
  assert.notEqual(timeout.code, 0)
  const controller = new AbortController()
  controller.abort()
  assert.notEqual(
    (await run(process.execPath, ['-e', 'process.exit(0)'], controller.signal)).code,
    0
  )
  assert.equal((await run(process.execPath, ['-e', 'process.exit(0)'])).code, 0)
})

test('managed plist exact ownership, loopback endpoints, dynamic port', () => {
  assert.equal(parseManagedPlist(plist(3000)).origin.port, '3000')
  assert.equal(parseManagedPlist(plist(3001)).origin.port, '3001')
  assert.equal(parseManagedPlist(plist(3001)).metrics.href, 'http://127.0.0.1:20241/metrics')
  assert.equal(
    parseManagedPlist({ ...plist(3001), StandardErrorPath: '/custom/home/logs/tunnel.log' })
      .logPath,
    '/custom/home/logs/tunnel.log'
  )
  assert.throws(() => parseManagedPlist({ ...plist(3000), Label: 'other.agent' }))
  assert.throws(() => parseManagedPlist({ ...plist(3000), Program: '/bin/sh' }))
  assert.equal(safeEndpoint('http://example.com'), null)
  assert.equal(safeEndpoint('https://user:secret@example.com', true), null)
  assert.equal(safeEndpoint('https://example.com?token=secret', true), null)
  assert.equal(safeEndpoint('http://example.com', true), null)
  assert.equal(safeEndpoint('wss://example.com', true).protocol, 'https:')
})

test('narrow generated named ingress and unsupported multi-origin', () => {
  const yaml =
    'tunnel: id\ningress:\n  - hostname: remote.example.com\n    service: http://127.0.0.1:3000\n  - service: http_status:404\n'
  assert.equal(parseIngress(yaml).origin.port, '3000')
  assert.equal(parseIngress(yaml).endpoint.hostname, 'remote.example.com')
  assert.equal(
    parseIngress(
      yaml.replace(
        '  - service: http_status:404',
        '  - hostname: other.example.com\n    service: http://127.0.0.1:3001'
      )
    ).origin,
    null
  )
  assert.equal(
    parseIngress(yaml.replace('    service:', '    path: /other\n    service:')).origin,
    null
  )
})

test('current launch hostname rejects stale, insecure, token-bearing URLs', () => {
  const previous = 'Requesting new quick Tunnel\nhttps://old.trycloudflare.com\nStarting tunnel\n'
  assert.equal(currentQuickHostname(previous + 'Requesting new quick Tunnel'), null)
  assert.equal(
    currentQuickHostname(
      previous + 'Requesting new quick Tunnel\nhttps://new.trycloudflare.com\nStarting tunnel'
    ),
    'https://new.trycloudflare.com'
  )
  assert.equal(
    currentQuickHostname(previous + 'Requesting new quick Tunnel\nStarting tunnel'),
    null
  )
  assert.equal(currentQuickHostname('Starting tunnel\nhttps://old.trycloudflare.com'), null)
  assert.equal(currentQuickHostname('https://old.trycloudflare.com'), null)
  for (const url of [
    'http://bad.trycloudflare.com',
    'https://bad.trycloudflare.com?token=x',
    'https://bad.trycloudflare.com.evil.test'
  ])
    assert.equal(currentQuickHostname('Requesting new quick Tunnel\n' + url), null)
  assert.equal(
    currentQuickHostname(previous + 'https://new.trycloudflare.com'),
    'https://new.trycloudflare.com'
  )
})

test('quick endpoint cache requires same known PID and truncated marker-free tail', () => {
  const text = 'Requesting new quick Tunnel\nhttps://old.trycloudflare.com\nStarting tunnel\n'
  const state = resolveQuickEndpoint({ text, pid: 123, inode: 10 })
  assert.equal(state.endpoint, 'https://old.trycloudflare.com')
  assert.equal(
    resolveQuickEndpoint({ text: 'connection log', pid: 123, truncated: true }, state).endpoint,
    state.endpoint
  )
  assert.equal(
    resolveQuickEndpoint({ text: 'connection log', pid: 124, truncated: true }, state).endpoint,
    null
  )
  assert.equal(
    resolveQuickEndpoint({ text: 'connection log', pid: null, truncated: true }, state).endpoint,
    null
  )
  assert.equal(resolveQuickEndpoint({ text: 'connection log', pid: 123 }, state).endpoint, null)
  const pending = resolveQuickEndpoint(
    { text: text + 'Requesting new quick Tunnel\n', pid: 123, inode: 10 },
    state
  )
  assert.equal(pending.endpoint, null)
  assert.equal(
    resolveQuickEndpoint({ text: 'connection log', pid: 123, truncated: true }, pending).endpoint,
    null
  )
  const changed = resolveQuickEndpoint({ text, pid: 124, inode: 10 }, state)
  assert.equal(changed.endpoint, null)
  assert.equal(resolveQuickEndpoint({ text, pid: 124, inode: 10 }, changed).endpoint, null)
  assert.equal(
    resolveQuickEndpoint(
      {
        text: text + 'Requesting new quick Tunnel\nhttps://new.trycloudflare.com',
        pid: 124,
        inode: 10
      },
      changed
    ).endpoint,
    'https://new.trycloudflare.com'
  )
})

test('metrics absent and malformed remain unknown, never zero', () => {
  assert.equal(parseMetrics('# HELP metric\n'), null)
  assert.equal(parseMetrics('cloudflared_tunnel_ha_connections 0\n'), 0)
  assert.equal(parseMetrics('cloudflared_tunnel_ha_connections{a="b"} 2\n'), 2)
  assert.equal(parseMetrics('cloudflared_tunnel_ha_connections NaN\n'), null)
})

test('public WS handshake, proxy CONNECT is not proof, 530 receipt establishes network', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ=='
  const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
  const proxy = 'HTTP/1.1 200 Connection established\r\n\r\n'
  assert.equal(parsePublicResponse(proxy, key).publicStatus, null)
  assert.equal(parsePublicResponse(proxy, key).networkHealthy, null)
  assert.equal(parsePublicResponse(proxy + response, key).publicStatus, 101)
  assert.equal(parsePublicResponse(response, 'wrong-key').publicStatus, null)
  assert.deepEqual(
    parsePublicResponse('HTTP/1.1 530 Unknown\r\nServer: cloudflare\r\n\r\nerror code: 1033', key),
    { publicStatus: 530, publicErrorCode: 1033, networkHealthy: true }
  )
})

async function serverFor(t, handler) {
  const server = http.createServer(handler)
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { server, endpoint: `http://127.0.0.1:${server.address().port}/remote/v1` }
}

test('local origin verifies random key and valid 101 then closes', async (t) => {
  const { server, endpoint } = await serverFor(t)
  server.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/remote/v1')
    assert.equal(Buffer.from(req.headers['sec-websocket-key'], 'base64').length, 16)
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(req.headers['sec-websocket-key'])}\r\n\r\n`
    )
  })
  assert.equal(await localProbe(endpoint, { websocket: true }), true)
})

test('local invalid WS accept and ordinary 200 are unhealthy', async (t) => {
  const { server, endpoint } = await serverFor(t, (_req, res) => res.end('not websocket'))
  assert.equal(await localProbe(endpoint, { websocket: true }), false)
  server.on('upgrade', (_req, socket) =>
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n'
    )
  )
  assert.equal(await localProbe(endpoint, { websocket: true }), false)
})

test('local metrics bounded, timeout and abort return unknown', async (t) => {
  const normal = await serverFor(t, (_req, res) => res.end('cloudflared_tunnel_ha_connections 1\n'))
  assert.equal(parseMetrics(await localProbe(normal.endpoint)), 1)
  const large = await serverFor(t, (_req, res) => res.end('x'.repeat(1024 * 1024 + 1)))
  assert.equal(await localProbe(large.endpoint), null)
  const hung = await serverFor(t, () => {})
  assert.equal(await localProbe(hung.endpoint, { timeout: 20 }), null)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await localProbe(hung.endpoint, { signal: controller.signal }), null)
})

test('restart rejects invalid uid before any system invocation', async () => {
  await assert.rejects(
    restartTunnel({ home: '/nonexistent', uid: '501/other.agent' }),
    /invalid-uid/
  )
})
