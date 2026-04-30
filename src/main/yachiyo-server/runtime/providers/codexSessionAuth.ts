import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_REFRESH_MARGIN_SECONDS = 300 // refresh if less than 5 min remaining

interface CodexAuthJson {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    access_token: string
    refresh_token: string
    id_token?: string
    account_id?: string
  }
  last_refresh?: string
}

interface RefreshResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

function expandPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

async function readAuthFile(filePath: string): Promise<CodexAuthJson> {
  const content = await readFile(filePath, 'utf8')
  return JSON.parse(content) as CodexAuthJson
}

function parseJwtExpiration(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return null
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(decoded) as Record<string, unknown>
    const exp = claims['exp']
    return typeof exp === 'number' ? exp : null
  } catch {
    return null
  }
}

function isTokenExpired(jwt: string): boolean {
  const exp = parseJwtExpiration(jwt)
  if (!exp) return false
  const now = Math.floor(Date.now() / 1000)
  return exp - now < TOKEN_REFRESH_MARGIN_SECONDS
}

export async function readCodexSessionAuth(
  sessionPath: string,
  forceRefresh = false
): Promise<{ accessToken: string; accountId?: string }> {
  const resolved = expandPath(sessionPath)
  let auth: CodexAuthJson
  try {
    auth = await readAuthFile(resolved)
  } catch (err) {
    throw new Error(
      `Failed to read Codex session file at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const accessToken = auth.tokens?.access_token
  if (!accessToken) {
    throw new Error(`No access_token found in Codex session file at ${resolved}`)
  }

  const accountId = auth.tokens?.account_id

  const refreshToken = auth.tokens?.refresh_token
  if ((forceRefresh || isTokenExpired(accessToken)) && refreshToken) {
    return refreshCodexToken(resolved, refreshToken, auth)
  }

  return { accessToken, accountId }
}

async function refreshCodexToken(
  filePath: string,
  refreshToken: string,
  currentAuth: CodexAuthJson
): Promise<{ accessToken: string; accountId?: string }> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })

  const response = await fetch(CODEX_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Codex token refresh failed (${response.status}): ${body || response.statusText}. Please re-authenticate with Codex CLI.`
    )
  }

  const data = (await response.json()) as RefreshResponse
  const newAccessToken = data.access_token
  const newRefreshToken = data.refresh_token

  if (!newAccessToken) {
    throw new Error(
      'Codex token refresh returned no access_token. Please re-authenticate with Codex CLI.'
    )
  }

  const accountId = currentAuth.tokens?.account_id

  // Race-safe write: re-read the file before persisting. If another process
  // (e.g. Codex CLI) already refreshed the token, skip our write and use
  // the fresher token from disk.
  try {
    const latest = await readAuthFile(filePath)
    const latestAccess = latest.tokens?.access_token
    if (
      latestAccess &&
      latestAccess !== currentAuth.tokens?.access_token &&
      !isTokenExpired(latestAccess)
    ) {
      console.info('[codexSessionAuth] another process already refreshed the token; using theirs')
      return { accessToken: latestAccess, accountId: latest.tokens?.account_id ?? accountId }
    }
  } catch {
    // If re-reading fails, fall through to write our refreshed token.
  }

  const updated: CodexAuthJson = {
    ...currentAuth,
    tokens: {
      access_token: newAccessToken,
      refresh_token: newRefreshToken ?? currentAuth.tokens?.refresh_token ?? '',
      id_token: data.id_token ?? currentAuth.tokens?.id_token ?? '',
      account_id: currentAuth.tokens?.account_id ?? ''
    },
    last_refresh: new Date().toISOString()
  }

  try {
    // Atomic write via temp file + rename to avoid half-written state.
    const tmpPath = `${filePath}.tmp.${Date.now()}`
    await writeFile(tmpPath, JSON.stringify(updated, null, 2), { mode: 0o600 })
    await rename(tmpPath, filePath)
  } catch (err) {
    // Non-fatal: we can still use the refreshed token even if saving fails.
    console.warn('[codexSessionAuth] failed to write back session file:', err)
  }

  return { accessToken: newAccessToken, accountId }
}
