import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import { YachiyoAvatar } from '@renderer/components/avatar/YachiyoAvatar'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { ResponseShareSnapshot } from '../../lib/share/responseShareModel'
import type { ResponseShareTheme } from '../../lib/share/responseShareTheme'
import { ShareToolView } from './ShareToolView'
import './responseShare.css'

export interface ShareDocumentOptions {
  includeQuestion: boolean
  toolDetails: boolean
  toolOverrides: Record<string, boolean>
  hiddenBlocks: readonly string[]
}

export function ShareDocument({
  snapshot,
  theme,
  options,
  documentRef
}: {
  snapshot: ResponseShareSnapshot
  theme: ResponseShareTheme
  options: ShareDocumentOptions
  documentRef?: Ref<HTMLElement>
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const [sources, setSources] = useState<string[]>([])
  useLayoutEffect(() => {
    const root = contentRef.current
    if (!root) return
    const collect = (): void => {
      const urls = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((href) => /^https?:\/\//i.test(href))
      const next = [...new Set(urls)]
      setSources((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      )
    }
    collect()
    const observer = new MutationObserver(collect)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    })
    return () => observer.disconnect()
  }, [snapshot, options])
  return (
    <article
      ref={documentRef}
      className="response-share-document"
      style={theme.style}
      data-appearance={theme.variant}
      data-yachiyo-theme={theme.themeId}
      data-yachiyo-theme-variant={theme.variant}
      onClickCapture={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <header data-share-header>
        <YachiyoAvatar static idleWink={false} size="conversation" />
        <strong>Yachiyo</strong>
      </header>
      <main data-share-content>
        <div ref={contentRef}>
          {options.includeQuestion && snapshot.question ? (
            <section className="response-share-question" data-share-block>
              <h2>Question</h2>
              <MessageMarkdown
                content={snapshot.question.content}
                share={{ theme, workspacePath: snapshot.workspacePath }}
              />
              {snapshot.question.attachmentNames?.length ? (
                <p className="response-share-muted">
                  Attachments: {snapshot.question.attachmentNames.join(', ')}
                </p>
              ) : null}
            </section>
          ) : null}
          {snapshot.blocks
            .filter(
              (block) =>
                !options.hiddenBlocks.includes(block.id) &&
                (options.includeQuestion || block.kind !== 'user')
            )
            .map((block) => (
              <section
                key={block.id}
                data-share-block
                data-share-block-id={block.id}
                className={
                  block.kind === 'user'
                    ? 'response-share-question'
                    : block.kind === 'tool'
                      ? 'response-share-tool-block'
                      : undefined
                }
              >
                {block.kind === 'tool' ? (
                  <ShareToolView
                    toolCall={block.toolCall}
                    details={options.toolOverrides[block.id] ?? options.toolDetails}
                  />
                ) : (
                  <>
                    {block.kind === 'user' ? <h2>User</h2> : null}
                    <MessageMarkdown
                      content={block.content}
                      share={{
                        theme,
                        workspacePath: snapshot.workspacePath
                      }}
                    />
                    {block.kind === 'user' && block.attachmentNames?.length ? (
                      <p className="response-share-muted">
                        Attachments: {block.attachmentNames.join(', ')}
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            ))}
        </div>
        {sources.length ? (
          <section className="response-share-sources" data-share-block>
            <h2>Sources</h2>
            <ol>
              {sources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ol>
          </section>
        ) : null}
      </main>
      <footer data-share-footer>
        <span>yachiyo.ringo.sh</span>
        <span>
          {options.hiddenBlocks.length > 0 ? 'Excerpt · ' : ''}
          {snapshot.status !== 'completed'
            ? `${snapshot.status === 'failed' ? 'Failed' : 'Stopped'} · `
            : ''}
          <span data-share-page-number>1 / 1</span>
        </span>
      </footer>
    </article>
  )
}
