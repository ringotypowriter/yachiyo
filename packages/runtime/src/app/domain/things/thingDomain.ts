import { randomUUID } from 'node:crypto'

import type {
  AddThingSourceInput,
  CreateThingInput,
  ListThingsInput,
  RemoveThingSourceInput,
  ThingMentionResolution,
  ThingRecord,
  UpdateThingInput
} from '@yachiyo/shared/protocol'
import type { StoredThingRow, YachiyoStorage } from '../../../storage/storage.ts'

const INACTIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export interface ThingDomainDeps {
  storage: YachiyoStorage
  now?: () => Date
  onThingsChanged?: (things: ThingRecord[]) => void | Promise<void>
}

export function normalizeThingName(name: string): string {
  return name
    .trim()
    .replace(/^#+/, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/_+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export class ThingDomain {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly onThingsChanged?: (things: ThingRecord[]) => void | Promise<void>

  constructor(deps: ThingDomainDeps) {
    this.storage = deps.storage
    this.now = deps.now ?? (() => new Date())
    this.onThingsChanged = deps.onThingsChanged
  }

  async listThings(input: ListThingsInput = {}): Promise<ThingRecord[]> {
    const things = this.storage.listThings().map((thing) => this.toThingRecord(thing))
    return input.includeInactive ? things : things.filter((thing) => !thing.isInactive)
  }

  async getThing(name: string): Promise<ThingRecord | undefined> {
    const normalizedName = normalizeThingName(name)
    if (!normalizedName) return undefined
    const thing = this.storage.getThingByName(normalizedName)
    return thing ? this.toThingRecord(thing) : undefined
  }

  async createThing(input: CreateThingInput): Promise<ThingRecord> {
    const name = normalizeThingName(input.name)
    if (!name) throw new Error('Thing name is required.')
    const existing = this.storage.getThingByName(name)
    if (existing) return this.toThingRecord(existing)

    const now = this.nowIso()
    const row: StoredThingRow = {
      id: randomUUID(),
      name,
      summary: input.summary.trim(),
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.storage.createThing(row)
    await this.emitChanged()
    return this.toThingRecord(row)
  }

  async updateThing(input: UpdateThingInput): Promise<ThingRecord | undefined> {
    const row = await this.mustGetThingRow(input.name)
    if (!row) return undefined
    const now = this.nowIso()
    const next: StoredThingRow = {
      ...row,
      ...(input.summary !== undefined ? { summary: input.summary.trim() } : {}),
      ...(input.touch === false ? {} : { lastUpdatedAt: now }),
      updatedAt: now
    }
    this.storage.updateThing(next)
    await this.emitChanged()
    return this.toThingRecord(next)
  }

  async deleteThing(name: string): Promise<boolean> {
    const row = await this.mustGetThingRow(name)
    if (!row) return false
    this.storage.deleteThing(row.id)
    await this.emitChanged()
    return true
  }

  async upsertSource(input: AddThingSourceInput): Promise<ThingRecord | undefined> {
    const row = await this.mustGetThingRow(input.name)
    if (!row) return undefined
    const now = this.nowIso()
    this.storage.upsertThingSource({
      id: randomUUID(),
      thingId: row.id,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
      spanRowId: input.spanRowId ?? null,
      sourceRowId: input.sourceRowId,
      preview: input.preview.trim(),
      createdAt: now
    })
    const next = { ...row, lastUpdatedAt: now, updatedAt: now }
    this.storage.updateThing(next)
    await this.emitChanged()
    return this.toThingRecord(next)
  }

  async removeSource(input: RemoveThingSourceInput): Promise<boolean> {
    const row = await this.mustGetThingRow(input.name)
    if (!row) return false
    const source = this.storage.listThingSources(row.id).find((item) => item.id === input.sourceId)
    if (!source) return false

    this.storage.deleteThingSource(source.id)
    this.storage.updateThing({ ...row, updatedAt: this.nowIso() })
    await this.emitChanged()
    return true
  }

  async restoreThing(name: string): Promise<ThingRecord | undefined> {
    return this.updateThing({ name, touch: true })
  }

  async resolveThingMention(name: string): Promise<ThingMentionResolution> {
    const normalizedName = normalizeThingName(name)
    const row = normalizedName ? this.storage.getThingByName(normalizedName) : undefined
    if (!row) return { name: normalizedName || name, resolved: false, reason: 'not-found' }
    const thing = this.toThingRecord(row)
    if (thing.isInactive) return { name: thing.name, resolved: false, reason: 'inactive' }
    return { name: thing.name, thing, resolved: true }
  }

  private async mustGetThingRow(name: string): Promise<StoredThingRow | undefined> {
    const normalizedName = normalizeThingName(name)
    return normalizedName ? this.storage.getThingByName(normalizedName) : undefined
  }

  private toThingRecord(row: StoredThingRow): ThingRecord {
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      lastUpdatedAt: row.lastUpdatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sources: this.storage.listThingSources(row.id),
      isInactive: this.now().getTime() - new Date(row.lastUpdatedAt).getTime() >= INACTIVE_AFTER_MS
    }
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private async emitChanged(): Promise<void> {
    if (this.onThingsChanged)
      await this.onThingsChanged(await this.listThings({ includeInactive: true }))
  }
}
