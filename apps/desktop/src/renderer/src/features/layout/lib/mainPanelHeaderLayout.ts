export function shouldShowCenteredHeaderAccessory(input: {
  showSidebarToggle: boolean
  hasCenterAccessory: boolean
}): boolean {
  return input.showSidebarToggle && input.hasCenterAccessory
}
