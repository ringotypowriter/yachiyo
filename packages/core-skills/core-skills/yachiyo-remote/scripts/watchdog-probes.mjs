import { execFile } from 'node:child_process'
import { readFile, open } from 'node:fs/promises'
import { basename, join, isAbsolute } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

const LABEL = 'sh.ringo.yachiyo.cloudflared'
const LIMIT = 1024 * 1024
const cache = new Map()
const quickCache = new Map()
const acceptFor = (key) =>
  createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
export const run = (file, args, signal, timeout = 3000) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { signal, timeout, maxBuffer: LIMIT, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.code ?? 'TERMINATED') : 0,
          stdout: stdout || '',
          stderr: stderr || ''
        })
      }
    )
  })

export function safeEndpoint(value, publicEndpoint = false) {
  try {
    const u = new URL(value)
    if (u.username || u.password || u.search || u.hash) return null
    if (publicEndpoint) {
      if (!['https:', 'wss:'].includes(u.protocol) || !u.hostname.includes('.')) return null
      u.protocol = 'https:'
    } else if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      return null
    return u
  } catch {
    return null
  }
}
const option = (args, name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='))
  return i < 0 ? null : args[i] === name ? args[i + 1] : args[i].slice(name.length + 1)
}

export function parseManagedPlist(plist) {
  const args = plist.ProgramArguments
  if (
    plist.Label !== LABEL ||
    !Array.isArray(args) ||
    !args.every((a) => typeof a === 'string') ||
    basename(plist.Program || args[0] || '') !== 'cloudflared' ||
    basename(args[0] || '') !== 'cloudflared'
  ) {
    throw new Error('unsupported-managed-plist')
  }
  const origin = safeEndpoint(option(args, '--url'))
  const metricsArg = option(args, '--metrics')
  const metrics = safeEndpoint(
    metricsArg?.startsWith('http:') ? metricsArg : `http://${metricsArg}`
  )
  if (metrics) metrics.pathname = '/metrics'
  const logPath =
    typeof plist.StandardErrorPath === 'string' &&
    isAbsolute(plist.StandardErrorPath) &&
    !plist.StandardErrorPath.endsWith('.plist')
      ? plist.StandardErrorPath
      : null
  return {
    origin,
    metrics,
    logPath,
    configPath: option(args, '--config'),
    mode: option(args, '--url') ? 'quick' : 'named'
  }
}

// Only a single generated ingress hostname/service pair is supported. Never guess
// which origin belongs to which hostname in arbitrary user-authored YAML.
export function parseIngress(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^ingress:\s*(?:#.*)?$/.test(line))
  if (start < 0) return { origin: null, endpoint: null }
  const block = []
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#-]/.test(line)) break
    block.push(line)
  }
  const hosts = block
    .map((l) => l.match(/^\s*-?\s*hostname:\s*["']?([a-zA-Z0-9.-]+)["']?\s*$/)?.[1])
    .filter(Boolean)
  const services = block
    .map((l) => l.match(/^\s*-?\s*service:\s*["']?([^\s"']+)["']?\s*$/)?.[1])
    .filter(Boolean)
  if (
    hosts.length !== 1 ||
    services.length !== 2 ||
    services[1] !== 'http_status:404' ||
    block.some((l) => /^\s*(?:-\s*)?path:/.test(l))
  )
    return { origin: null, endpoint: null }
  return { origin: safeEndpoint(services[0]), endpoint: safeEndpoint(`https://${hosts[0]}`, true) }
}

export function currentQuickHostname(text) {
  // Quick mode prints its URL before "Starting tunnel"; only a new request
  // begins a new endpoint generation. Missing request markers remain unknown.
  const markers = [...text.matchAll(/Requesting new quick Tunnel/gi)]
  if (!markers.length) return null
  const segment = text.slice(markers.at(-1).index)
  const urls = [...segment.matchAll(/https:\/\/[^\s|"'<>]+/gi)]
    .map((m) => safeEndpoint(m[0], true))
    .filter(
      (u) =>
        u && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(u.hostname) && !u.port && u.pathname === '/'
    )
  return urls.length ? urls.at(-1).origin : null
}

export function parseMetrics(text) {
  const values = [
    ...text.matchAll(
      /^cloudflared_tunnel_ha_connections(?:\{[^\n]*\})?\s+([\d.eE+-]+)(?:\s+\d+)?\s*$/gm
    )
  ].map((m) => Number(m[1]))
  return values.length && values.every((n) => Number.isFinite(n) && n >= 0)
    ? values.reduce((a, b) => a + b, 0)
    : null
}

export function resolveQuickEndpoint(
  { text, pid, truncated = false, offset = 0, inode = 0 },
  previous
) {
  const marker = [...text.matchAll(/Requesting new quick Tunnel/gi)].at(-1)
  const requestId = marker
    ? `${inode}:${offset + Buffer.byteLength(text.slice(0, marker.index))}`
    : (previous?.requestId ?? null)
  let blockedRequest = previous?.blockedRequest ?? null
  if (previous?.pid && pid && previous.pid !== pid && requestId === previous.requestId)
    blockedRequest = requestId
  const samePid = Number.isSafeInteger(pid) && pid > 0 && pid === previous?.pid
  const endpoint = !pid
    ? null
    : marker
      ? requestId === blockedRequest
        ? null
        : currentQuickHostname(text)
      : truncated && samePid
        ? previous.endpoint
        : null
  return { pid: pid ?? previous?.pid ?? null, endpoint, requestId, blockedRequest }
}

export function localProbe(endpoint, { websocket = false, signal, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64')
    let done = false
    const finish = (value) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    const req = http.get(endpoint, {
      signal,
      headers: websocket
        ? {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key
          }
        : {}
    })
    const timer = setTimeout(() => {
      finish(null)
      req.destroy()
    }, timeout)
    req.on('upgrade', (res, socket) => {
      finish(
        res.statusCode === 101 &&
          res.headers['sec-websocket-accept'] === acceptFor(key) &&
          res.headers.upgrade?.toLowerCase() === 'websocket' &&
          /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(res.headers.connection || '')
      )
      socket.destroy()
    })
    req.on('response', (res) => {
      if (websocket) {
        finish(false)
        res.destroy()
        return
      }
      let data = ''
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > LIMIT) {
          finish(null)
          res.destroy()
        } else data += chunk
      })
      res.on('end', () => finish(res.statusCode === 200 ? data : null))
      res.on('error', () => finish(null))
    })
    req.on('error', () => finish(null))
  })
}

export function parsePublicResponse(output, key) {
  const blocks = [
    ...output.matchAll(/HTTP\/1\.[01] (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/g)
  ]
  const actual = blocks
    .filter((b) => !/^HTTP\/1\.[01] 200 Connection established/i.test(b[0]))
    .at(-1)
  if (!actual) return { publicStatus: null, publicErrorCode: null, networkHealthy: null }
  const status = Number(actual[1])
  const headers = Object.fromEntries(
    actual[2].split(/\r?\n/).map((l) => {
      const i = l.indexOf(':')
      return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]
    })
  )
  const valid =
    status !== 101 ||
    (headers['sec-websocket-accept'] === acceptFor(key) &&
      headers.upgrade?.toLowerCase() === 'websocket' &&
      /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(headers.connection || ''))
  return {
    publicStatus: valid ? status : null,
    publicErrorCode:
      status === 530 &&
      /(?:error\s*(?:code[:\s]*)?|"code"\s*:\s*)1033\b/i.test(
        output.slice(actual.index + actual[0].length)
      )
        ? 1033
        : null,
    networkHealthy: true
  }
}

async function publicProbe(endpoint, signal) {
  const key = randomBytes(16).toString('base64')
  const url = new URL('/remote/v1', endpoint)
  const result = await run(
    '/usr/bin/curl',
    [
      '--disable',
      '--silent',
      '--http1.1',
      '--max-time',
      '5',
      '--max-filesize',
      String(LIMIT),
      '--include',
      '--proto',
      '=https',
      '--request',
      'GET',
      '--header',
      'Connection: Upgrade',
      '--header',
      'Upgrade: websocket',
      '--header',
      'Sec-WebSocket-Version: 13',
      '--header',
      `Sec-WebSocket-Key: ${key}`,
      url.href
    ],
    signal,
    6000
  )
  // curl exit 28 is expected when an accepted upgrade remains open.
  return parsePublicResponse(result.stdout, key)
}

async function tail(path) {
  const file = await open(path, 'r')
  try {
    const { size, ino } = await file.stat()
    const offset = Math.max(0, size - LIMIT)
    const buffer = Buffer.alloc(Math.min(size, LIMIT))
    await file.read(buffer, 0, buffer.length, offset)
    return { text: buffer.toString('utf8'), truncated: size > LIMIT, offset, inode: ino }
  } finally {
    await file.close()
  }
}
async function managed(home, signal) {
  const result = await run(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', join(home, 'Library/LaunchAgents', `${LABEL}.plist`)],
    signal
  )
  if (result.code !== 0) throw new Error('managed-plist-unavailable')
  return parseManagedPlist(JSON.parse(result.stdout))
}

export async function observeTunnel({ home, uid = process.getuid?.(), signal }) {
  const unknown = {
    haConnections: null,
    originHealthy: null,
    publicStatus: null,
    publicErrorCode: null,
    networkHealthy: null
  }
  let cfg
  try {
    cfg = await managed(home, signal)
  } catch {
    quickCache.delete(home)
    return { ...unknown, reason: 'managed-plist-unavailable-or-unsupported' }
  }
  let launchPid = null
  if (
    Number.isSafeInteger(Number(uid)) &&
    Number(uid) >= 0 &&
    uid !== null &&
    uid !== undefined &&
    uid !== ''
  ) {
    const processInfo = await run(
      '/bin/launchctl',
      ['print', `gui/${Number(uid)}/${LABEL}`],
      signal
    )
    if (processInfo.code === 0)
      launchPid = Number(processInfo.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null
  }
  let endpoint = null
  if (cfg.mode === 'quick') {
    try {
      const state = resolveQuickEndpoint(
        {
          ...(await tail(cfg.logPath || join(home, '.yachiyo/logs/cloudflared.log'))),
          pid: launchPid
        },
        quickCache.get(home)
      )
      if (!quickCache.has(home) && quickCache.size >= 32)
        quickCache.delete(quickCache.keys().next().value)
      quickCache.set(home, state)
      endpoint = state.endpoint
    } catch {
      quickCache.delete(home)
    }
  } else if (cfg.configPath && /\.ya?ml$/i.test(cfg.configPath)) {
    try {
      const text = await readFile(cfg.configPath, 'utf8')
      if (Buffer.byteLength(text) <= LIMIT) {
        const parsed = parseIngress(text)
        cfg.origin = parsed.origin
        endpoint = parsed.endpoint?.href ?? null
      }
    } catch {
      /* unknown */
    }
  }
  const origin = cfg.origin ? new URL('/remote/v1', cfg.origin) : null
  const [metrics, originHealthy] = await Promise.all([
    cfg.metrics ? localProbe(cfg.metrics, { signal }) : null,
    origin ? localProbe(origin, { websocket: true, signal }) : null
  ])
  const haConnections = metrics === null ? null : parseMetrics(metrics)
  const fingerprint = JSON.stringify([
    endpoint,
    cfg.origin?.href,
    cfg.metrics?.href,
    cfg.mode,
    launchPid
  ])
  const prior = cache.get(home)
  let publicResult = unknown
  if (endpoint) {
    if (
      haConnections !== 0 &&
      prior?.fingerprint === fingerprint &&
      Date.now() - prior.time < 300000
    )
      publicResult = prior.result
    else {
      publicResult = await publicProbe(endpoint, signal)
      cache.set(home, { fingerprint, time: Date.now(), result: publicResult })
    }
  } else cache.delete(home)
  return {
    ...unknown,
    ...publicResult,
    haConnections,
    originHealthy,
    mode: cfg.mode,
    endpoint,
    launchPid,
    config: {
      managed: true,
      origin: cfg.origin?.origin ?? null,
      metrics: cfg.metrics?.origin ?? null
    },
    reason: !origin
      ? 'unsupported-or-unknown-origin'
      : !endpoint
        ? 'current-public-endpoint-unknown'
        : null
  }
}

export async function restartTunnel({ home, uid, signal }) {
  if (
    !Number.isSafeInteger(Number(uid)) ||
    Number(uid) < 0 ||
    uid === undefined ||
    uid === null ||
    uid === ''
  )
    throw new Error('invalid-uid')
  await managed(home, signal)
  const result = await run(
    '/bin/launchctl',
    ['kickstart', '-k', `gui/${Number(uid)}/${LABEL}`],
    signal
  )
  if (result.code !== 0) throw new Error('launchctl-kickstart-failed')
  cache.delete(home)
  return { restarted: true }
}
