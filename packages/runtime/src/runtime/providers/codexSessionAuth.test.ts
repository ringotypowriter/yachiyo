import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readCodexSessionAuth } from './codexSessionAuth.ts'

function encodeBase64Url(input: unknown): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url')
}

function createJwt(exp: number): string {
  return `${encodeBase64Url({ alg: 'none' })}.${encodeBase64Url({ exp })}.signature`
}

async function withTempAuthFile(auth: unknown, fn: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-codex-auth-'))
  const authPath = join(root, 'auth.json')

  try {
    await writeFile(authPath, JSON.stringify(auth, null, 2), 'utf8')
    await fn(authPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('readCodexSessionAuth reads a fresh access token without refreshing', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('Token refresh should not be called for a fresh token.')
  }) as typeof globalThis.fetch

  try {
    const accessToken = createJwt(Math.floor(Date.now() / 1000) + 3600)
    await withTempAuthFile(
      {
        tokens: {
          access_token: accessToken,
          refresh_token: 'refresh-token',
          account_id: 'acct_123'
        }
      },
      async (authPath) => {
        const result = await readCodexSessionAuth(authPath)

        assert.deepEqual(result, {
          accessToken,
          accountId: 'acct_123'
        })
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('readCodexSessionAuth refreshes an expiring token and persists the new session', async () => {
  const originalFetch = globalThis.fetch
  const oldAccessToken = createJwt(Math.floor(Date.now() / 1000) + 60)
  const newAccessToken = createJwt(Math.floor(Date.now() / 1000) + 3600)
  let requestedUrl = ''
  let refreshBody: URLSearchParams | undefined

  globalThis.fetch = (async (input, init) => {
    requestedUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    refreshBody = new URLSearchParams(String(init?.body))

    return new Response(
      JSON.stringify({
        access_token: newAccessToken,
        refresh_token: 'new-refresh-token',
        id_token: 'new-id-token'
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }) as typeof globalThis.fetch

  try {
    await withTempAuthFile(
      {
        tokens: {
          access_token: oldAccessToken,
          refresh_token: 'old-refresh-token',
          id_token: 'old-id-token',
          account_id: 'acct_123'
        }
      },
      async (authPath) => {
        const result = await readCodexSessionAuth(authPath)
        const saved = JSON.parse(await readFile(authPath, 'utf8')) as {
          last_refresh?: string
          tokens?: {
            access_token?: string
            refresh_token?: string
            id_token?: string
            account_id?: string
          }
        }

        assert.equal(requestedUrl, 'https://auth.openai.com/oauth/token')
        assert.equal(refreshBody?.get('grant_type'), 'refresh_token')
        assert.equal(refreshBody?.get('refresh_token'), 'old-refresh-token')
        assert.deepEqual(result, {
          accessToken: newAccessToken,
          accountId: 'acct_123'
        })
        assert.equal(saved.tokens?.access_token, newAccessToken)
        assert.equal(saved.tokens?.refresh_token, 'new-refresh-token')
        assert.equal(saved.tokens?.id_token, 'new-id-token')
        assert.equal(saved.tokens?.account_id, 'acct_123')
        assert.match(saved.last_refresh ?? '', /^\d{4}-\d{2}-\d{2}T/u)
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('readCodexSessionAuth uses a newer token if another process refreshed first', async () => {
  const originalFetch = globalThis.fetch
  const oldAccessToken = createJwt(Math.floor(Date.now() / 1000) + 60)
  const otherAccessToken = createJwt(Math.floor(Date.now() / 1000) + 3600)
  const fetchedAccessToken = createJwt(Math.floor(Date.now() / 1000) + 7200)

  try {
    await withTempAuthFile(
      {
        tokens: {
          access_token: oldAccessToken,
          refresh_token: 'old-refresh-token',
          account_id: 'acct_old'
        }
      },
      async (authPath) => {
        globalThis.fetch = (async () => {
          await writeFile(
            authPath,
            JSON.stringify(
              {
                tokens: {
                  access_token: otherAccessToken,
                  refresh_token: 'other-refresh-token',
                  account_id: 'acct_other'
                }
              },
              null,
              2
            ),
            'utf8'
          )

          return new Response(
            JSON.stringify({
              access_token: fetchedAccessToken,
              refresh_token: 'fetched-refresh-token'
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        }) as typeof globalThis.fetch

        const result = await readCodexSessionAuth(authPath)
        const saved = JSON.parse(await readFile(authPath, 'utf8')) as {
          tokens?: { access_token?: string; refresh_token?: string }
        }

        assert.deepEqual(result, {
          accessToken: otherAccessToken,
          accountId: 'acct_other'
        })
        assert.equal(saved.tokens?.access_token, otherAccessToken)
        assert.equal(saved.tokens?.refresh_token, 'other-refresh-token')
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('readCodexSessionAuth rejects session files without an access token', async () => {
  await withTempAuthFile(
    {
      tokens: {
        refresh_token: 'refresh-token'
      }
    },
    async (authPath) => {
      await assert.rejects(() => readCodexSessionAuth(authPath), {
        message: `No access_token found in Codex session file at ${authPath}`
      })
    }
  )
})
