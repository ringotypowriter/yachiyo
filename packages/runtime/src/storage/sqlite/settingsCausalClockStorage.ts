import type { BetterSqlite3Client } from './sqliteRuntime.ts'

const KEY = 'settings_causal_clock'

export function readSettingsCausalClock(client: BetterSqlite3Client): Record<string, number> {
  const row = client.prepare('SELECT value FROM sync_meta WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as Record<string, number>) : {}
}

export function acceptSettingsCausalClock(
  client: BetterSqlite3Client,
  snapshot: { deviceId: string; seq: number; causalClock: Record<string, number> }
): void {
  const clock = readSettingsCausalClock(client)
  for (const [deviceId, seq] of Object.entries({
    ...snapshot.causalClock,
    [snapshot.deviceId]: snapshot.seq
  })) {
    clock[deviceId] = Math.max(clock[deviceId] ?? 0, seq)
  }
  client
    .prepare(
      "INSERT INTO sync_meta (key, value) VALUES ('settings_causal_clock', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(JSON.stringify(clock))
}
