export type GroupProbeHeadlessAdapterKind = 'claude-code'

export interface GroupProbeHeadlessAdapterConfig {
  adapter: GroupProbeHeadlessAdapterKind
  providerName: string
  model: string
}

const GROUP_PROBE_HEADLESS_ADAPTER_KINDS = new Set<string>(['claude-code'])

export function isGroupProbeHeadlessAdapterKind(
  value: string
): value is GroupProbeHeadlessAdapterKind {
  return GROUP_PROBE_HEADLESS_ADAPTER_KINDS.has(value)
}

export function defaultGroupProbeHeadlessAdapterProviderName(
  adapter: GroupProbeHeadlessAdapterKind
): string {
  switch (adapter) {
    case 'claude-code':
      return 'Claude Code'
  }
}

export function resolveGroupProbeHeadlessAdapter(
  config: GroupProbeHeadlessAdapterConfig | undefined,
  selectedModel: { providerName: string; model: string } | undefined
): GroupProbeHeadlessAdapterConfig | undefined {
  if (
    !config ||
    !selectedModel ||
    config.providerName !== selectedModel.providerName ||
    config.model !== selectedModel.model
  ) {
    return undefined
  }

  return config
}
