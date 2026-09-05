import {
  elementScroll,
  observeElementOffset,
  type VirtualizerOptions
} from '@tanstack/virtual-core'

type ScrollOptions<T extends HTMLElement> = Pick<
  VirtualizerOptions<T, HTMLElement>,
  'scrollToFn' | 'observeElementOffset'
>

export function createTimelineVirtualizerScroll<
  T extends HTMLElement = HTMLElement
>(): ScrollOptions<T> {
  let appliedAdjustment = 0
  return {
    observeElementOffset(instance, onOffset) {
      return observeElementOffset(instance, (offset, isScrolling) => {
        // The virtualizer resets its cumulative adjustment on this same callback.
        appliedAdjustment = 0
        onOffset(offset, isScrolling)
      })
    },
    scrollToFn(offset, options, instance) {
      if (options.adjustments === undefined || !instance.scrollElement) {
        elementScroll(offset, options, instance)
        return
      }
      const delta = options.adjustments - appliedAdjustment
      // Native scrolling can advance before its next event reaches the virtualizer.
      // Apply only the new measured-height delta to the live viewport.
      const before = instance.scrollElement.scrollTop
      elementScroll(before, { ...options, adjustments: delta }, instance)
      // A spacer that has not grown yet can clamp the write. Keep that remainder
      // available for the next measurement rather than counting it as applied.
      appliedAdjustment += instance.scrollElement.scrollTop - before
    }
  }
}
