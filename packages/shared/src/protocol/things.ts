export interface ThingThreadScopeRecord {
  thingId: string
  threadId: string
  threadTitle?: string
  createdAt: string
  updatedAt: string
}

export interface ThingSourceQuoteRecord {
  id: string
  thingId: string
  threadId: string
  threadTitle?: string
  threadIcon?: string
  messageId?: string
  spanRowId?: string
  sourceRowId: string
  quote: string
  createdAt: string
}

export interface ThingRecord {
  id: string
  name: string
  summary: string
  lastUpdatedAt: string
  createdAt: string
  updatedAt: string
  includedChats: ThingThreadScopeRecord[]
  sourceQuotes: ThingSourceQuoteRecord[]
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
  threadId?: string
  sourceQuotes?: Array<{
    threadId: string
    messageId?: string
    spanRowId?: string
    sourceRowId: string
    quote: string
  }>
}

export interface UpdateThingInput {
  name: string
  summary?: string
  touch?: boolean
}

export interface DeleteThingInput {
  name: string
}

export interface LinkThingThreadInput {
  name: string
  threadId: string
}

export interface AddThingQuoteInput {
  name: string
  threadId: string
  messageId?: string
  spanRowId?: string
  sourceRowId: string
  quote: string
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
