import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { RemoteConfig } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import { REMOTE_WS_PATH } from '@yachiyo/shared/remote/wire'

export const CLOUDFLARED_AGENT_LABEL = 'sh.ringo.yachiyo.cloudflared'
const METRICS_POLL_INTERVAL_MS = 30_000
const CLOUDFLARED_CANDIDATES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']

export type TunnelInstallMode =
  | { mode: 'quick' }
  | { mode: 'named'; tunnelName: string; hostname: string }

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export interface TunnelPaths {
  launchAgentsDir: string
  /** `<YACHIYO_HOME>`; holds `logs/cloudflared.log` and `remote/cloudflared-named.yml`. */
  yachiyoHome: string
  /** The user's cloudflared config; a quick tunnel refuses to start while it exists. */
  cloudflaredUserConfig: string
}

export interface TunnelStatus {
  cloudflaredPath: string | null
  agentInstalled: boolean
  agentRunning: boolean
  hostname: string | null
  endpoint: RemoteEndpoint | null
}

export interface TunnelSupervisorOptions {
  paths: TunnelPaths
  uid: number
  runner?: CommandRunner
  fetch?: typeof globalThis.fetch
  fileExists?: (path: string) => boolean
  log?: (line: string) => void
}

export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const exitCode = (error as { code?: unknown } | null)?.code
      const code = !error ? 0 : typeof exitCode === 'number' ? exitCode : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export function defaultTunnelPaths(yachiyoHome: string): TunnelPaths {
  return {
    launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
    yachiyoHome,
    cloudflaredUserConfig: join(homedir(), '.cloudflared', 'config.yaml')
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The `ProgramArguments` for each mode; `--no-autoupdate` leaves upgrades to Homebrew. */
export function cloudflaredArguments(input: {
  cloudflaredPath: string
  install: TunnelInstallMode
  port: number
  metricsPort: number
  namedConfigPath: string
}): string[] {
  const metrics = ['--metrics', `127.0.0.1:${input.metricsPort}`]
  // Avoid QUIC/UDP instability on TUN-proxied networks in both tunnel modes.
  const protocol = ['--protocol', 'http2']
  if (input.install.mode === 'quick') {
    return [
      input.cloudflaredPath,
      'tunnel',
      '--no-autoupdate',
      ...protocol,
      '--url',
      `http://127.0.0.1:${input.port}`,
      ...metrics
    ]
  }
  return [
    input.cloudflaredPath,
    'tunnel',
    '--no-autoupdate',
    ...protocol,
    '--config',
    input.namedConfigPath,
    ...metrics,
    'run',
    input.install.tunnelName
  ]
}

export function renderLaunchAgentPlist(input: {
  programArguments: string[]
  logPath: string
}): string {
  const args = input.programArguments
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CLOUDFLARED_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`
}

/** Ingress for a named tunnel, passed with `--config` so `~/.cloudflared/config.yaml` is untouched. */
export function renderNamedTunnelConfig(input: {
  tunnelName: string
  hostname: string
  port: number
}): string {
  return [
    `tunnel: ${input.tunnelName}`,
    'ingress:',
    `  - hostname: ${input.hostname}`,
    `    service: http://127.0.0.1:${input.port}`,
    '  - service: http_status:404',
    ''
  ].join('\n')
}

export function tunnelEndpointFor(hostname: string): RemoteEndpoint {
  return { kind: 'tunnel', url: `wss://${hostname}${REMOTE_WS_PATH}` }
}

/**
 * Installs cloudflared as a KeepAlive LaunchAgent so the tunnel (and a quick tunnel's random
 * hostname) outlives app restarts, and watches cloudflared's metrics endpoint for the current
 * quick-tunnel hostname.
 */
export class TunnelSupervisor {
  private readonly options: TunnelSupervisorOptions
  private readonly runner: CommandRunner
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly fileExists: (path: string) => boolean
  private hostname: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private monitored: RemoteConfig | null = null
  private onChange: ((endpoint: RemoteEndpoint | null) => void) | null = null

  constructor(options: TunnelSupervisorOptions) {
    this.options = options
    this.runner = options.runner ?? defaultCommandRunner
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.fileExists = options.fileExists ?? existsSync
  }

  get plistPath(): string {
    return join(this.options.paths.launchAgentsDir, `${CLOUDFLARED_AGENT_LABEL}.plist`)
  }

  get namedConfigPath(): string {
    return join(this.options.paths.yachiyoHome, 'remote', 'cloudflared-named.yml')
  }

  get logPath(): string {
    return join(this.options.paths.yachiyoHome, 'logs', 'cloudflared.log')
  }

  private get domain(): string {
    return `gui/${this.options.uid}`
  }

  findCloudflared(): string | null {
    return CLOUDFLARED_CANDIDATES.find((candidate) => this.fileExists(candidate)) ?? null
  }

  /** A quick tunnel cannot start while `~/.cloudflared/config.yaml` exists. */
  hasConflictingUserConfig(): boolean {
    return this.fileExists(this.options.paths.cloudflaredUserConfig)
  }

  async install(
    install: TunnelInstallMode,
    ports: { port: number; metricsPort: number }
  ): Promise<void> {
    const cloudflaredPath = this.findCloudflared()
    if (!cloudflaredPath) {
      throw new Error('cloudflared is not installed. Install it with: brew install cloudflared')
    }
    if (install.mode === 'quick' && this.hasConflictingUserConfig()) {
      throw new Error(
        `A quick tunnel cannot run while ${this.options.paths.cloudflaredUserConfig} exists. Use a named tunnel instead.`
      )
    }
    if (install.mode === 'named') {
      await mkdir(dirname(this.namedConfigPath), { recursive: true })
      await writeFile(
        this.namedConfigPath,
        renderNamedTunnelConfig({ ...install, port: ports.port }),
        'utf8'
      )
    }
    await mkdir(dirname(this.logPath), { recursive: true })
    await mkdir(this.options.paths.launchAgentsDir, { recursive: true })
    await writeFile(
      this.plistPath,
      renderLaunchAgentPlist({
        programArguments: cloudflaredArguments({
          cloudflaredPath,
          install,
          port: ports.port,
          metricsPort: ports.metricsPort,
          namedConfigPath: this.namedConfigPath
        }),
        logPath: this.logPath
      }),
      'utf8'
    )
    // Replace any previous agent; bootout fails harmlessly when none is loaded.
    await this.runner('launchctl', ['bootout', `${this.domain}/${CLOUDFLARED_AGENT_LABEL}`])
    const loaded = await this.runner('launchctl', ['bootstrap', this.domain, this.plistPath])
    if (loaded.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim() || loaded.code}`)
    }
    this.hostname = null
    this.options.log?.(`[remote] cloudflared LaunchAgent installed (${install.mode})`)
  }

  async uninstall(): Promise<void> {
    await this.runner('launchctl', ['bootout', `${this.domain}/${CLOUDFLARED_AGENT_LABEL}`])
    await rm(this.plistPath, { force: true })
    this.setHostname(null)
    this.options.log?.('[remote] cloudflared LaunchAgent removed')
  }

  async status(config: RemoteConfig): Promise<TunnelStatus> {
    const printed = await this.runner('launchctl', [
      'print',
      `${this.domain}/${CLOUDFLARED_AGENT_LABEL}`
    ])
    return {
      cloudflaredPath: this.findCloudflared(),
      agentInstalled: this.fileExists(this.plistPath),
      agentRunning: printed.code === 0 && /state = running/.test(printed.stdout),
      hostname: this.hostname,
      endpoint: this.endpoint(config)
    }
  }

  endpoint(config: RemoteConfig | null = this.monitored): RemoteEndpoint | null {
    if (!config || config.tunnel === 'none') return null
    if (config.tunnel === 'named') {
      return config.namedHostname ? tunnelEndpointFor(config.namedHostname) : null
    }
    return this.hostname ? tunnelEndpointFor(this.hostname) : null
  }

  /** Follows the tunnel hostname for `config`; `onChange` fires whenever the endpoint changes. */
  monitor(config: RemoteConfig, onChange: (endpoint: RemoteEndpoint | null) => void): void {
    const previous = this.endpoint()
    this.monitored = config
    this.onChange = onChange
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (config.tunnel === 'quick') {
      void this.poll()
      this.pollTimer = setInterval(() => void this.poll(), METRICS_POLL_INTERVAL_MS)
      this.pollTimer.unref()
    }
    const next = this.endpoint()
    if (previous?.url !== next?.url) onChange(next)
  }

  stopMonitoring(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.monitored = null
    this.onChange = null
  }

  /** Reads `GET /quicktunnel` from cloudflared metrics; exposed for tests. */
  async poll(): Promise<void> {
    const config = this.monitored
    if (!config || config.tunnel !== 'quick') return
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${config.metricsPort}/quicktunnel`, {
        signal: AbortSignal.timeout(3_000)
      })
      if (!response.ok) return
      const body = (await response.json()) as { hostname?: unknown }
      const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : ''
      // An empty hostname means cloudflared has not registered yet; keep the last known one.
      if (hostname) this.setHostname(hostname)
    } catch {
      // cloudflared not running (app started before the agent, or between restarts): the
      // last known hostname stays until metrics answer again.
    }
  }

  protected setHostname(hostname: string | null): void {
    if (hostname === this.hostname) return
    this.hostname = hostname
    this.onChange?.(this.endpoint())
  }
}
