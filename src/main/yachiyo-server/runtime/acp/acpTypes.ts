import type { SubagentProfile, ThreadRuntimeBinding } from '../../../../shared/yachiyo/protocol'

export type { ThreadRuntimeBinding }

/** Subset of SubagentProfile fields that control ACP visibility and routing. */
export interface AcpProfileExt {
  showInChatPicker?: boolean
  allowDelegation?: boolean
  allowDirectChat?: boolean
}

/** A SubagentProfile guaranteed to have ACP routing fields resolved. */
export interface ResolvedAcpProfile extends SubagentProfile {
  showInChatPicker: boolean
  allowDelegation: boolean
  allowDirectChat: boolean
}

/** Resolve ACP routing flags with defaults for backward compatibility. */
export function resolveAcpProfile(profile: SubagentProfile): ResolvedAcpProfile {
  return {
    ...profile,
    showInChatPicker: profile.showInChatPicker ?? false,
    allowDelegation: profile.allowDelegation ?? true,
    allowDirectChat: profile.allowDirectChat ?? false
  }
}
