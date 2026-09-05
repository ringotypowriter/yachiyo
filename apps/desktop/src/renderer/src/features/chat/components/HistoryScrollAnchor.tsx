import { Component, type ReactNode, type RefObject } from 'react'
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
  type TimelineViewportAnchor
} from '../lib/timeline/timelineViewportAnchor.ts'

interface Props {
  children?: ReactNode
  containerRef: RefObject<HTMLDivElement | null>
  threadId: string | null
  messages: readonly { id: string }[]
  navigationKey: string | null
  resolveOffset: (key: string) => number | null
  onRestore: () => void
}

/** Capture before React mutates the DOM, not when an asynchronous page request starts. */
export class HistoryScrollAnchor extends Component<Props> {
  private anchor: TimelineViewportAnchor | null = null
  private frame: number | null = null
  private observer: ResizeObserver | null = null
  private restoredScrollTop = 0

  cancel = (): void => {
    this.anchor = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  getSnapshotBeforeUpdate(previous: Props): TimelineViewportAnchor | null {
    if (
      previous.threadId !== this.props.threadId ||
      previous.navigationKey !== this.props.navigationKey
    ) {
      this.cancel()
      return null
    }
    const oldest = previous.messages[0]?.id
    const container = this.props.containerRef.current
    return container &&
      oldest &&
      this.props.messages.findIndex((message) => message.id === oldest) > 0
      ? captureTimelineViewportAnchor(container)
      : null
  }

  componentDidUpdate(...[, , snapshot]: [Props, unknown, TimelineViewportAnchor | null]): void {
    if (snapshot) this.anchor = snapshot
    this.restore()
  }

  componentDidMount(): void {
    // Capture precedes the virtualizer's scroll listener and synchronous React update.
    this.props.containerRef.current?.addEventListener('scroll', this.handleScroll, true)
    this.observer = new ResizeObserver(this.scheduleRestore)
    const content = this.props.containerRef.current?.firstElementChild
    if (content) this.observer.observe(content)
  }

  componentWillUnmount(): void {
    this.cancel()
    this.observer?.disconnect()
    this.props.containerRef.current?.removeEventListener('scroll', this.handleScroll, true)
  }

  private handleScroll = (): void => {
    const container = this.props.containerRef.current
    if (this.anchor && container && Math.abs(container.scrollTop - this.restoredScrollTop) > 0.5) {
      this.cancel()
    }
  }

  private scheduleRestore = (): void => {
    if (!this.anchor || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.restore()
    })
  }

  private restore = (): void => {
    const container = this.props.containerRef.current
    const anchor = this.anchor
    if (!container || !anchor) return
    // A mounted row is the source of truth. The measurement cache may already
    // describe the next React layout, so applying it first would bounce back.
    if (restoreTimelineViewportAnchor(container, anchor) === null) {
      const offset = this.props.resolveOffset(anchor.key)
      if (offset === null) {
        this.cancel()
        return
      }
      // Only use the estimate to bring an unmounted keyed row into render range.
      container.scrollTop = Math.max(0, offset - anchor.top)
    }
    this.restoredScrollTop = container.scrollTop
    this.props.onRestore()
  }

  render(): ReactNode {
    return this.props.children
  }
}
