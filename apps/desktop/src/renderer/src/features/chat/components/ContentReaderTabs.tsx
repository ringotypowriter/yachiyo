import type { ReactNode } from 'react'
import {
  FileDiff,
  FileText,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquare,
  X
} from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { EMPTY_READER_CONVERSATION, useContentReaderStore } from '../state/useContentReaderStore'
import { readerTitle, type ReaderTarget } from '../lib/contentReader'

function ReaderKindIcon({ kind }: { kind: ReaderTarget['kind'] }): React.JSX.Element {
  if (kind === 'web') return <Globe size={13} />
  if (kind === 'image') return <ImageIcon size={13} />
  if (kind === 'diff') return <FileDiff size={13} />
  return <FileText size={13} />
}

/** Replaces the header title once a conversation has previews; the first tab is the conversation. */
export function ContentReaderTabs({
  threadId,
  title,
  icon,
  accessory
}: {
  threadId: string | null
  title?: string
  icon?: string | null
  accessory?: ReactNode
}): React.JSX.Element | null {
  const conversation = useContentReaderStore((state) =>
    threadId
      ? (state.conversations[threadId] ?? EMPTY_READER_CONVERSATION)
      : EMPTY_READER_CONVERSATION
  )
  const running = useAppStore((state) => !!threadId && !!state.activeRunIdsByThread[threadId])
  const needsAttention = useAppStore(
    (state) =>
      !!threadId &&
      (state.planDocumentsByThread[threadId]?.decision === 'pending' ||
        !!state.toolCalls[threadId]?.some((call) => call.status === 'waiting-for-user'))
  )
  const select = useContentReaderStore((state) => state.select)
  const closeTab = useContentReaderStore((state) => state.closeTab)
  if (!threadId || conversation.tabs.length === 0) return null
  const chatActive = conversation.activeId === 'chat'

  return (
    <div className="content-reader-tabs">
      <div
        className="content-reader-tabs__list"
        role="tablist"
        aria-label="Conversation tabs"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.getAttribute('role') !== 'tab')
            return
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
          )
          const index = tabs.indexOf(event.target as HTMLButtonElement)
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1
          if (next < 0) return
          event.preventDefault()
          tabs[next].click()
          tabs[next].focus()
          tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
      >
        <div className="content-reader-tab" data-active={chatActive}>
          <button
            type="button"
            role="tab"
            tabIndex={chatActive ? 0 : -1}
            aria-selected={chatActive}
            title={title || 'Chat'}
            onClick={() => select(threadId, 'chat')}
          >
            {icon ? (
              <span className="content-reader-tab__emoji">{icon}</span>
            ) : (
              <MessageSquare size={13} />
            )}
            <span>{title || 'Chat'}</span>
            {needsAttention ? (
              <MessageCircleQuestion size={13} aria-label="Needs your attention" />
            ) : running ? (
              <LoaderCircle size={12} className="animate-spin" aria-label="Yachiyo is working" />
            ) : null}
          </button>
        </div>
        <span className="content-reader-tabs__divider" aria-hidden />
        {conversation.tabs.map((tab) => {
          const active = conversation.activeId === tab.id
          const title = readerTitle(tab.target)
          return (
            <div className="content-reader-tab" data-active={active} key={tab.id}>
              <button
                type="button"
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                title={title}
                onClick={() => select(threadId, tab.id)}
              >
                <ReaderKindIcon kind={tab.target.kind} />
                <span>{title}</span>
              </button>
              <button
                type="button"
                className="content-reader-tab-close"
                aria-label={`Close ${title}`}
                onClick={() => closeTab(threadId, tab.id)}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>
      {accessory}
    </div>
  )
}
