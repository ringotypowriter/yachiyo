export type DiscoveredAppKind = 'editor' | 'terminal' | 'markdown'

export interface DiscoveredApp {
  id: string
  name: string
  executablePath: string
  kind: DiscoveredAppKind
  launchArguments?: string[]
  iconDataUrl?: string
}

export interface DiscoveredApps {
  editors: DiscoveredApp[]
  terminals: DiscoveredApp[]
  markdownEditors: DiscoveredApp[]
}
