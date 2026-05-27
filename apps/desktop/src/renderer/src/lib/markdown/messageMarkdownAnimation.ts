import type { AnimateOptions } from 'streamdown'

export function getMessageMarkdownAnimation(isStreaming: boolean): false | AnimateOptions {
  if (!isStreaming) return false
  return { sep: 'char', animation: 'blurIn', duration: 110, easing: 'ease-out', stagger: 2 }
}
