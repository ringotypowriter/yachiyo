export const AUTO_COMPACT_NOTICE = 'Compacting the conversation now to keep context manageable.'

export async function notifyAutoCompact<Target>(
  sendMessage: (target: Target, text: string) => Promise<unknown>,
  target: Target
): Promise<void> {
  await sendMessage(target, AUTO_COMPACT_NOTICE).catch(() => {})
}
