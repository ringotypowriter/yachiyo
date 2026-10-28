export const APP_SERVER_PROTOCOL = 1

export interface AppServerAddress {
  protocol: number
  instanceId: string
  url: string
  token: string
}

export interface AppEventCursor {
  instanceId: string
  sequence: number
}

export interface AppEventEnvelope {
  cursor: AppEventCursor
  event: unknown
}

export interface AppEventSubscription {
  cursor: AppEventCursor
  reset: boolean
  events: AppEventEnvelope[]
}
