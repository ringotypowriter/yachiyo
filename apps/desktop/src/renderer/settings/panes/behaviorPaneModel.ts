export const LAUNCH_AT_LOGIN_PROMPT =
  'Set up Yachiyo to launch automatically when I log in on macOS.'

export function hasEnabledChatModel(
  providers: readonly { modelList: { enabled: readonly string[]; disabled?: readonly string[] } }[]
): boolean {
  return providers.some((provider) => provider.modelList.enabled.length > 0)
}
