import type { UpdateChannel } from '@yachiyo/shared/protocol'

/** Base URL of the R2 release mirror. Override for local testing via env;
 *  set to an empty string to disable the mirror entirely. */
export const UPDATE_MIRROR_BASE: string =
  process.env.YACHIYO_UPDATE_MIRROR ?? 'https://yachiyo-release.ringo.sh'

const PROBE_TIMEOUT_MS = 4000

export type UpdateFeed = { source: 'mirror'; url: string } | { source: 'github' }

export interface MirrorProbeFetch {
  (url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean }>
}

export function mirrorFeedUrl(mirrorBase: string, channel: UpdateChannel): string {
  const base = mirrorBase.replace(/\/+$/, '')
  return `${base}/${channel === 'beta' ? 'nightly' : 'stable'}`
}

/** Pick the update feed: the mirror when it responds with a channel manifest,
 * otherwise GitHub. Never throws — any probe failure means GitHub. */
export async function resolveUpdateFeed(options: {
  mirrorBase: string
  channel: UpdateChannel
  platform: NodeJS.Platform
  fetchFn: MirrorProbeFetch
  timeoutMs?: number
}): Promise<UpdateFeed> {
  const { mirrorBase, channel, platform, fetchFn, timeoutMs = PROBE_TIMEOUT_MS } = options
  if (!mirrorBase) return { source: 'github' }

  const url = mirrorFeedUrl(mirrorBase, channel)
  try {
    const manifest = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml'
    const resp = await fetchFn(`${url}/${manifest}`, { signal: AbortSignal.timeout(timeoutMs) })
    return resp.ok ? { source: 'mirror', url } : { source: 'github' }
  } catch {
    return { source: 'github' }
  }
}

/** Return feeds in update priority order. Beta users must also receive stable
 * releases: a nightly can be an older prerelease of the stable version that
 * has since shipped. */
export async function resolveUpdateFeeds(options: {
  mirrorBase: string
  channel: UpdateChannel
  platform: NodeJS.Platform
  fetchFn: MirrorProbeFetch
  timeoutMs?: number
}): Promise<UpdateFeed[]> {
  if (options.channel !== 'beta') return [await resolveUpdateFeed(options)]

  const nightly = await resolveUpdateFeed(options)
  const stable = await resolveUpdateFeed({ ...options, channel: 'stable' })
  const feeds: UpdateFeed[] = []

  if (nightly.source === 'mirror') feeds.push(nightly)
  if (stable.source === 'mirror') feeds.push(stable)
  feeds.push({ source: 'github' })
  return feeds
}

export interface UpdateFeedCheckResult {
  available: boolean
  version: string
}

/** Check feeds in order and stop at the first newer build. */
export async function checkUpdateFeeds(
  feeds: readonly UpdateFeed[],
  checkFeed: (feed: UpdateFeed) => Promise<UpdateFeedCheckResult>
): Promise<UpdateFeedCheckResult> {
  let lastVersion: string | undefined
  for (const feed of feeds) {
    const result = await checkFeed(feed)
    lastVersion = result.version
    if (result.available) return result
  }

  if (!lastVersion) {
    throw new Error('No update feeds were configured.')
  }
  return { available: false, version: lastVersion }
}
