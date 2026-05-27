import { useEffect, useMemo, useState } from 'react'
import type { MemoryTermDocument, MemoryTermEntry, SettingsConfig } from '@yachiyo/shared/protocol'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { theme } from '@renderer/theme/theme'
import {
  ListPagination,
  SettingLabel,
  SettingRow,
  SettingSection,
  SettingSwitch
} from '../components/primitives'
import {
  deleteMemoryTerm,
  flattenMemoryTermTopics,
  loadMemoryTermDocument
} from './memoryTermDocumentModel'

const MEMORY_TERMS_PAGE_SIZE = 10

export interface MemoryPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function MemoryPane({ draft, onChange }: MemoryPaneProps): React.JSX.Element {
  const [view, setView] = useState<'overview' | 'terms'>('overview')
  const [memoryTermsPage, setMemoryTermsPage] = useState(1)
  const [memoryTermDocument, setMemoryTermDocument] = useState<MemoryTermDocument | null>(null)
  const [isLoadingTerms, setIsLoadingTerms] = useState(false)
  const [deletingTermId, setDeletingTermId] = useState<string | null>(null)
  const [memoryTermsReloadKey, setMemoryTermsReloadKey] = useState(0)
  const [termsError, setTermsError] = useState<string | null>(null)
  const dialog = useAppDialog()
  const memory = draft.memory ?? {
    enabled: true,
    autoRecall: true
  }
  const memoryTermRows = useMemo(
    () => flattenMemoryTermTopics(memoryTermDocument?.topics ?? []),
    [memoryTermDocument]
  )
  const memoryTermTotalCount = memoryTermDocument?.memoryCount ?? 0
  const memoryTermPageCount = Math.max(1, Math.ceil(memoryTermTotalCount / MEMORY_TERMS_PAGE_SIZE))
  const currentMemoryTermsPage = Math.min(memoryTermsPage, memoryTermPageCount)
  const memoryTermStartIndex =
    memoryTermTotalCount === 0 ? 0 : (currentMemoryTermsPage - 1) * MEMORY_TERMS_PAGE_SIZE
  const memoryTermEndIndex = Math.min(
    memoryTermStartIndex + memoryTermRows.length,
    memoryTermTotalCount
  )
  const memoryTermItems = memoryTermRows

  useEffect(() => {
    if (view !== 'terms') {
      return
    }

    let cancelled = false
    let redirecting = false
    setIsLoadingTerms(true)
    setTermsError(null)

    void loadMemoryTermDocument(draft, {
      limit: MEMORY_TERMS_PAGE_SIZE,
      offset: (memoryTermsPage - 1) * MEMORY_TERMS_PAGE_SIZE
    })
      .then((document) => {
        if (!cancelled) {
          if (
            document.memoryCount > 0 &&
            flattenMemoryTermTopics(document.topics).length === 0 &&
            memoryTermsPage > 1
          ) {
            redirecting = true
            setMemoryTermDocument(document)
            setMemoryTermsPage(
              Math.max(1, Math.ceil(document.memoryCount / MEMORY_TERMS_PAGE_SIZE))
            )
            return
          }
          setMemoryTermDocument(document)
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setTermsError(reason instanceof Error ? reason.message : 'Failed to load memory terms.')
        }
      })
      .finally(() => {
        if (!cancelled && !redirecting) {
          setIsLoadingTerms(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [draft, memoryTermsPage, memoryTermsReloadKey, view])

  const handleDeleteMemoryTerm = async (entry: MemoryTermEntry): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: `Forget "${entry.title}" permanently?`,
      message: 'This deletes the memory row from local cognitive memory. It cannot be undone.',
      confirmLabel: 'Forget',
      tone: 'danger'
    })
    if (!confirmed) return

    setDeletingTermId(entry.id)
    setTermsError(null)
    try {
      await deleteMemoryTerm(entry.id)
      setMemoryTermsReloadKey((key) => key + 1)
    } catch (error) {
      setTermsError(error instanceof Error ? error.message : 'Failed to forget memory term.')
    } finally {
      setDeletingTermId(null)
    }
  }

  if (view === 'terms') {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-5 pb-4">
          <button
            type="button"
            className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => {
              setView('overview')
              setMemoryTermsPage(1)
              setMemoryTermDocument(null)
            }}
          >
            ← Memory
          </button>
          <div className="mt-1 text-lg font-semibold" style={{ color: theme.text.primary }}>
            Memory terms
          </div>
          <div className="mt-0.5 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Cognitive memory as a compact indexed list. Each row keeps the topic, type, content, and
            update metadata visible.
          </div>
          {memoryTermDocument ? (
            <div className="mt-0.5 text-xs leading-5" style={{ color: theme.text.muted }}>
              {memoryTermDocument.memoryCount} terms across {memoryTermDocument.topicCount} topics
            </div>
          ) : null}
        </div>

        {isLoadingTerms ? (
          <div className="px-7 text-sm" style={{ color: theme.text.muted }}>
            Loading memory terms...
          </div>
        ) : (
          <>
            {memoryTermRows.length > 0 ? (
              <>
                <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
                  {memoryTermItems.map(({ topic, topicEntryCount, entry }, index) => (
                    <div
                      key={entry.id}
                      className="content-selectable px-7 py-2.5"
                      style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
                    >
                      <div className="flex gap-3">
                        <div
                          className="w-9 shrink-0 pt-0.5 text-xs tabular-nums"
                          style={{ color: theme.text.muted }}
                        >
                          #{memoryTermStartIndex + index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <div
                              className="text-sm font-medium"
                              style={{ color: theme.text.primary }}
                            >
                              {entry.title}
                            </div>
                            <div className="text-xs" style={{ color: theme.text.muted }}>
                              {entry.unitType}
                            </div>
                          </div>
                          <div
                            className="mt-0.5 text-sm leading-5"
                            style={{ color: theme.text.tertiary }}
                          >
                            {entry.content}
                          </div>
                          <div
                            className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5"
                            style={{ color: theme.text.muted }}
                          >
                            <span>{topic}</span>
                            <span>
                              · {topicEntryCount} {topicEntryCount === 1 ? 'term' : 'terms'} in
                              topic
                            </span>
                            {typeof entry.importance === 'number' ? (
                              <span>· importance {entry.importance}</span>
                            ) : null}
                            {typeof entry.activationCount === 'number' ? (
                              <span>· activated {entry.activationCount}</span>
                            ) : null}
                            <span>
                              · updated <time dateTime={entry.updatedAt}>{entry.updatedAt}</time>
                            </span>
                            {entry.lastActivatedAt ? (
                              <span>
                                · last used{' '}
                                <time dateTime={entry.lastActivatedAt}>
                                  {entry.lastActivatedAt}
                                </time>
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 pt-0.5 text-xs font-medium transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
                          style={{ color: theme.text.dangerStrong }}
                          disabled={deletingTermId === entry.id}
                          onClick={() => void handleDeleteMemoryTerm(entry)}
                        >
                          {deletingTermId === entry.id ? 'Forgetting...' : 'Forget'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <ListPagination
                  page={currentMemoryTermsPage}
                  pageCount={memoryTermPageCount}
                  startIndex={memoryTermStartIndex}
                  endIndex={memoryTermEndIndex}
                  totalCount={memoryTermTotalCount}
                  itemLabel={memoryTermTotalCount === 1 ? 'term' : 'terms'}
                  onPageChange={setMemoryTermsPage}
                />
              </>
            ) : (
              <div className="px-7 py-3 text-sm" style={{ color: theme.text.muted }}>
                No memory terms yet.
              </div>
            )}

            {termsError ? (
              <div className="px-7 pb-3 text-sm" style={{ color: theme.text.warning }}>
                {termsError}
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Enable memory
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Pull recalled context into runs and allow explicit thread saves.
            </div>
          </div>
          <div className="shrink-0">
            <SettingSwitch
              checked={memory.enabled === true}
              onChange={() =>
                onChange({ ...draft, memory: { ...memory, enabled: !memory.enabled } })
              }
              ariaLabel="Toggle memory"
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Memory terms
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              View the memory hierarchy grouped by stored topic.
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => {
              setMemoryTermsPage(1)
              setView('terms')
            }}
          >
            View terms →
          </button>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Memory</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Auto-distill memory after runs
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              When off, memory is updated only when you use the remember tool.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={draft.chat?.autoMemoryDistillation !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    autoMemoryDistillation: draft.chat?.autoMemoryDistillation === false
                  }
                })
              }
              ariaLabel="Toggle auto memory distillation"
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Auto Recall
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              When off, new runs start without pulling in saved memories.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={memory.autoRecall !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  memory: {
                    ...memory,
                    autoRecall: memory.autoRecall === false
                  }
                })
              }
              ariaLabel="Toggle automatic memory recall"
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <div className="px-7 py-4 text-sm leading-5" style={{ color: theme.text.tertiary }}>
          Auto-recall and post-run distillation use the tool model configured in Chat settings.
        </div>
      </SettingSection>
    </div>
  )
}
