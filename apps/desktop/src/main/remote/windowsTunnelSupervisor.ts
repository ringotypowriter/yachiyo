import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import {
  cloudflaredArguments,
  renderNamedTunnelConfig,
  TunnelSupervisor,
  type TunnelInstallMode,
  type TunnelStatus
} from './tunnelSupervisor.ts'

const RESTART_INTERVAL_MS = 30_000

type TunnelChild = {
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
  off(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
  kill(): boolean
}

/** A cloudflared process owned by the Windows desktop app, never an elevated system service. */
export class WindowsTunnelSupervisor extends TunnelSupervisor {
  private readonly searchPath: string
  private readonly exists: (path: string) => boolean
  private readonly spawn: (command: string, args: string[]) => TunnelChild
  private readonly log?: (line: string) => void
  private child: TunnelChild | null = null
  private config: RemoteConfig | null = null
  private restartTimer: ReturnType<typeof setInterval> | null = null
  private starting: Promise<void> | null = null

  constructor(options: {
    yachiyoHome: string
    searchPath?: string
    fileExists?: (path: string) => boolean
    spawn?: (command: string, args: string[]) => TunnelChild
    fetch?: typeof globalThis.fetch
    log?: (line: string) => void
  }) {
    super({
      paths: {
        launchAgentsDir: '',
        yachiyoHome: options.yachiyoHome,
        cloudflaredUserConfig: join(homedir(), '.cloudflared', 'config.yaml')
      },
      uid: 0,
      fetch: options.fetch,
      fileExists: options.fileExists,
      log: options.log
    })
    this.searchPath = options.searchPath ?? process.env.PATH ?? ''
    this.exists = options.fileExists ?? existsSync
    this.spawn =
      options.spawn ??
      ((command, args) => spawnProcess(command, args, { stdio: 'ignore', windowsHide: true }))
    this.log = options.log
  }

  override findCloudflared(): string | null {
    for (const directory of this.searchPath.split(';')) {
      if (!directory) continue
      const candidate = win32.join(directory.replace(/^"|"$/g, ''), 'cloudflared.exe')
      if (this.exists(candidate)) return candidate
    }
    return null
  }

  override async install(
    install: TunnelInstallMode,
    ports: { port: number; metricsPort: number }
  ): Promise<void> {
    if (!this.findCloudflared()) {
      throw new Error(
        'cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared'
      )
    }
    if (install.mode === 'quick' && this.hasConflictingUserConfig()) {
      throw new Error(
        'A quick tunnel cannot run with a user cloudflared config. Use a named tunnel instead.'
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
    await this.stopChildAndWait()
    this.config = {
      ...DEFAULT_REMOTE_CONFIG,
      enabled: true,
      tunnel: install.mode,
      port: ports.port,
      metricsPort: ports.metricsPort
    }
    await this.ensureRunning()
  }

  override async uninstall(): Promise<void> {
    this.stopMonitoring()
  }

  override async status(config: RemoteConfig): Promise<TunnelStatus> {
    return {
      cloudflaredPath: this.findCloudflared(),
      agentInstalled: config.tunnel !== 'none' && this.findCloudflared() !== null,
      agentRunning: this.child !== null,
      hostname:
        config.tunnel === 'quick' ? (this.endpoint(config)?.url.split('/')[2] ?? null) : null,
      endpoint: this.endpoint(config)
    }
  }

  override monitor(
    config: RemoteConfig,
    onChange: (endpoint: RemoteEndpoint | null) => void
  ): void {
    super.monitor(config, onChange)
    this.config = config
    if (config.tunnel === 'none' || !config.enabled) {
      this.stopChild()
      if (this.restartTimer) clearInterval(this.restartTimer)
      this.restartTimer = null
      return
    }
    void this.ensureRunning().catch((error: unknown) =>
      this.log?.(`[remote] cloudflared start failed: ${String(error)}`)
    )
    if (!this.restartTimer) {
      this.restartTimer = setInterval(() => {
        void this.ensureRunning().catch((error: unknown) =>
          this.log?.(`[remote] cloudflared restart failed: ${String(error)}`)
        )
      }, RESTART_INTERVAL_MS)
      this.restartTimer.unref()
    }
  }

  override stopMonitoring(): void {
    super.stopMonitoring()
    if (this.restartTimer) clearInterval(this.restartTimer)
    this.restartTimer = null
    this.config = null
    this.stopChild()
  }

  async ensureRunning(): Promise<void> {
    if (this.child || !this.config || this.config.tunnel === 'none') return
    if (this.starting) return this.starting
    this.starting = this.startChild(this.config).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startChild(config: RemoteConfig): Promise<void> {
    const binary = this.findCloudflared()
    if (!binary)
      throw new Error(
        'cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared'
      )
    let install: TunnelInstallMode = { mode: 'quick' }
    if (config.tunnel === 'named') {
      const contents = await readFile(this.namedConfigPath, 'utf8')
      const tunnelName = /^tunnel: (.+)$/m.exec(contents)?.[1]
      if (!tunnelName)
        throw new Error('Named tunnel config is missing its tunnel name. Reinstall the tunnel.')
      install = { mode: 'named', tunnelName, hostname: config.namedHostname }
    }
    if (this.config !== config || this.child) return
    const [, ...args] = cloudflaredArguments({
      cloudflaredPath: binary,
      install,
      port: config.port,
      metricsPort: config.metricsPort,
      namedConfigPath: this.namedConfigPath
    })
    const child = this.spawn(binary, args)
    this.child = child
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.setHostname(null)
      }
    })
    child.on('error', (error) => {
      this.log?.(`[remote] cloudflared failed: ${String(error)}`)
      if (this.child === child) {
        this.child = null
        this.setHostname(null)
      }
    })
  }

  private stopChild(): void {
    const child = this.child
    this.child = null
    this.setHostname(null)
    child?.kill()
  }

  private async stopChildAndWait(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.setHostname(null)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        clearTimeout(timeout)
        child.off('exit', onExit)
        child.off('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onExit = (): void => done()
      const onError = (error: unknown): void =>
        done(new Error(`cloudflared stop failed: ${String(error)}`))
      const timeout = setTimeout(
        () => done(new Error('cloudflared did not exit; the tunnel was not replaced.')),
        5_000
      )
      child.once('exit', onExit)
      child.once('error', onError)
      if (!child.kill()) {
        done(new Error('cloudflared could not be stopped; the tunnel was not replaced.'))
      }
    })
  }
}
