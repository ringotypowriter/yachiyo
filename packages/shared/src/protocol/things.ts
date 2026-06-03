export interface ThingThreadScopeRecord {
  thingId: string
  threadId: string
  threadTitle?: string
  createdAt: string
  updatedAt: string
}

export interface ThingSourceRecord {
  id: string
  thingId: string
  threadId: string
  threadTitle?: string
  threadIcon?: string
  messageId?: string
  spanRowId?: string
  sourceRowId: string
  preview: string
  createdAt: string
}

export interface ThingRecord {
  id: string
  name: string
  summary: string
  lastUpdatedAt: string
  createdAt: string
  updatedAt: string
  sources: ThingSourceRecord[]
  isInactive: boolean
}

export interface ListThingsInput {
  includeInactive?: boolean
}

export interface GetThingInput {
  name: string
}

export interface CreateThingInput {
  name: string
  summary: string
}

export interface UpdateThingInput {
  name: string
  summary?: string
  touch?: boolean
}

export interface DeleteThingInput {
  name: string
}

export interface RemoveThingSourceInput {
  name: string
  sourceId: string
}

export interface AddThingSourceInput {
  name: string
  threadId: string
  messageId?: string
  spanRowId?: string
  sourceRowId: string
  preview: string
}

export interface ContinueThingInput {
  name: string
}

export interface ThingMentionResolution {
  name: string
  thing?: ThingRecord
  resolved: boolean
  reason?: 'not-found' | 'inactive'
}
