import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, Copy, Ellipsis, RotateCcw, Trash2, X } from 'lucide-react'

import type { ThingRecord } from '@renderer/app/types'
import type { ThingSourceRecord } from '@yachiyo/shared/protocol'
import { formatDate, tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { alpha, theme } from '@renderer/theme/theme'
import { copyTextWithFallback } from '../../chat/lib/messages/copyTextWithFallback'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'

type Translator = ReturnType<typeof useT>

export function ThingColumn({
  thing,
  onOpen,
  onContinue,
  onRestore,
  onOpenThread
}: {
  thing: ThingRecord
  onOpen: () => void
  onContinue: (name: string) => void
  onRestore: (name: string) => void
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
  const t = useT()
  const sourceCount = thing.sources.length

  return (
    <article
      className="flex h-full min-h-0 w-full flex-col rounded-3xl p-4 transition duration-200 hover:-translate-y-0.5 sm:p-5"
      style={{
        background: thing.isInactive ? alpha('surface', 0.5) : alpha('surface', 0.76),
        boxShadow: thing.isInactive ? 'none' : theme.shadow.card,
        opacity: thing.isInactive ? 0.72 : 1
      }}
    >
      <button type="button" className="block w-full shrink-0 text-left" onClick={onOpen}>
        <div className="flex items-start justify-between gap-4">
          <h2
            className="min-w-0 wrap-break-word text-lg font-semibold leading-tight tracking-[-0.03em]"
            style={{ color: theme.text.primary }}
          >
            #{thing.name}
          </h2>
          {thing.isInactive ? <StatusPill tone="muted" label={t('things.inactive')} /> : null}
        </div>

        <div className="mt-2 text-xs font-medium" style={{ color: theme.text.muted }}>
          {t('things.updated', { date: formatDate(new Date(thing.lastUpdatedAt), 'date') })} ·{' '}
          {tPlural('things.sourceCount', sourceCount)}
        </div>

        <p className="mt-4 line-clamp-3 text-sm leading-6" style={{ color: theme.text.secondary }}>
          {thing.summary || t('things.noSummaryYet')}
        </p>
      </button>

      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3">
          <div
            className="text-xs font-semibold uppercase tracking-[0.16em]"
            style={{ color: theme.text.muted }}
          >
            {t('things.sourcePreviews')}
          </div>
        </div>
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto pr-1">
          {thing.sources.length > 0 ? (
            thing.sources.map((source) => (
              <SourcePreview key={source.id} source={source} onOpenThread={onOpenThread} />
            ))
          ) : (
            <div
              className="rounded-2xl px-3 py-3 text-sm"
              style={{ background: alpha('surface', 0.46), color: theme.text.muted }}
            >
              {t('things.noSourcesYet')}
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-wrap gap-2 pt-5">
        <PrimaryButton onClick={() => onContinue(thing.name)}>
          {thing.isInactive ? t('things.restoreAndContinue') : t('things.continue')}
        </PrimaryButton>
        {thing.isInactive ? (
          <SecondaryButton onClick={() => onRestore(thing.name)} icon={<RotateCcw size={14} />}>
            {t('things.restore')}
          </SecondaryButton>
        ) : null}
      </div>
    </article>
  )
}

export function ThingDetailOverlay({
  thing,
  onClose,
  onContinue,
  onRestore,
  onRename,
  onMerge,
  onDelete,
  onRemoveSource,
  onOpenThread,
  mergeTargets
}: {
  thing: ThingRecord
  onClose: () => void
  onContinue: (name: string) => void
  onRestore: (name: string) => void
  onRename: () => void
  onMerge: (target: ThingRecord) => void
  onDelete: () => void
  onRemoveSource: (source: ThingSourceRecord) => void
  onOpenThread: (threadId: string, messageId?: string) => void
  mergeTargets: ThingRecord[]
}): React.JSX.Element {
  const t = useT()
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center p-8"
      style={{ background: alpha('scrim', 0.22), backdropFilter: 'blur(18px)' }}
      onClick={onClose}
    >
      <section
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-4xl p-6"
        style={{ background: theme.background.surfaceFrosted, boxShadow: theme.shadow.overlay }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-5">
          <div className="min-w-0">
            <h2
              className="wrap-break-word text-3xl font-semibold tracking-[-0.04em]"
              style={{ color: theme.text.primary }}
            >
              #{thing.name}
            </h2>
            <div className="mt-2 text-sm font-medium" style={{ color: theme.text.muted }}>
              {t('things.updated', { date: formatDate(new Date(thing.lastUpdatedAt), 'date') })} ·{' '}
              {tPlural('things.sourceCount', thing.sources.length)}
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-6" style={{ color: theme.text.secondary }}>
              {thing.summary || t('things.noSummaryYet')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="rounded-full p-2 transition hover:scale-105"
              style={{ background: theme.background.counterSoft, color: theme.text.primary }}
              onClick={(event) => {
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                setMenuPosition({ top: rect.bottom + 8, left: rect.right - 220 })
              }}
              aria-label={t('things.thingOptions')}
              aria-expanded={menuPosition !== null}
            >
              <Ellipsis size={18} />
            </button>
            <button
              type="button"
              className="rounded-full p-2 transition hover:scale-105"
              style={{ background: theme.background.counterSoft, color: theme.text.primary }}
              onClick={onClose}
              aria-label={t('things.closeThingDetails')}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="mt-5 flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-2">
            <PrimaryButton onClick={() => onContinue(thing.name)}>
              {thing.isInactive ? t('things.restoreAndContinue') : t('things.continue')}
            </PrimaryButton>
            {thing.isInactive ? (
              <SecondaryButton onClick={() => onRestore(thing.name)} icon={<RotateCcw size={14} />}>
                {t('things.restore')}
              </SecondaryButton>
            ) : null}
          </div>
          <div />
        </div>

        <div className="mt-6 min-h-0 overflow-auto">
          <SectionTitle label={t('things.sourcePreviews')} count={thing.sources.length} />
          <div className="mt-3 flex flex-col gap-3">
            {thing.sources.length === 0 ? (
              <EmptyLine>{t('things.noSourcePreviewsYet')}</EmptyLine>
            ) : (
              thing.sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  onOpenThread={onOpenThread}
                  onRemove={() => onRemoveSource(source)}
                />
              ))
            )}
          </div>
        </div>
      </section>
      {menuPosition ? (
        <ThingManagementMenu
          position={menuPosition}
          mergeTargets={mergeTargets}
          onRename={() => {
            setMenuPosition(null)
            onRename()
          }}
          onMerge={(target) => {
            setMenuPosition(null)
            onMerge(target)
          }}
          onDelete={() => {
            setMenuPosition(null)
            onDelete()
          }}
          onClose={() => setMenuPosition(null)}
        />
      ) : null}
    </div>
  )
}

function ThingManagementMenu({
  mergeTargets,
  onClose,
  onDelete,
  onMerge,
  onRename,
  position
}: {
  mergeTargets: ThingRecord[]
  onClose: () => void
  onDelete: () => void
  onMerge: (target: ThingRecord) => void
  onRename: () => void
  position: { top: number; left: number }
}): React.JSX.Element {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [resolvedTop, setResolvedTop] = useState(position.top)
  const menuWidth = 220

  useEffect(() => {
    const handlePointerDown = (): void => onClose()
    const handleEscape = (event: KeyboardEvent): void => {
      if (isDismissEscapeKey(event)) onClose()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const margin = 12
    const menuHeight = el.offsetHeight
    if (position.top + menuHeight > window.innerHeight - margin) {
      setResolvedTop(Math.max(margin, window.innerHeight - menuHeight - margin))
    } else {
      setResolvedTop(position.top)
    }
  }, [position.top, mergeTargets.length])

  return createPortal(
    <div
      ref={menuRef}
      className="no-drag"
      data-no-drag
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'fixed',
        top: resolvedTop,
        left: Math.max(12, Math.min(position.left, window.innerWidth - menuWidth - 12)),
        width: menuWidth,
        padding: 6,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 14,
        boxShadow: theme.shadow.menu,
        zIndex: 100
      }}
    >
      <ThingMenuButton onClick={onRename}>{t('things.renameSlug')}</ThingMenuButton>
      <MenuDivider />
      <div
        className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: theme.text.muted }}
      >
        {t('things.mergeInto')}
      </div>
      {mergeTargets.length > 0 ? (
        mergeTargets.map((target) => (
          <ThingMenuButton key={target.id} onClick={() => onMerge(target)}>
            #{target.name}
          </ThingMenuButton>
        ))
      ) : (
        <div className="px-3 py-2 text-sm" style={{ color: theme.text.muted }}>
          {t('things.noOtherThings')}
        </div>
      )}
      <MenuDivider />
      <ThingMenuButton tone="danger" onClick={onDelete}>
        {t('common.delete')}
      </ThingMenuButton>
    </div>,
    document.body
  )
}

function ThingMenuButton({
  children,
  onClick,
  tone = 'normal'
}: {
  children: React.ReactNode
  onClick: () => void
  tone?: 'normal' | 'danger'
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
      style={{ color: tone === 'danger' ? theme.text.dangerStrong : theme.text.primary }}
      onClick={onClick}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function MenuDivider(): React.JSX.Element {
  return <div style={{ height: 1, margin: '4px 8px', background: theme.border.default }} />
}

function SourcePreview({
  source,
  onOpenThread
}: {
  source: ThingSourceRecord
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <button
      type="button"
      className="shrink-0 rounded-2xl px-3 py-2 text-left transition hover:translate-x-1"
      style={{ background: theme.background.surfaceSoft }}
      onClick={() => onOpenThread(source.threadId, source.messageId)}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = theme.background.surfaceSoft
      }}
    >
      <div
        className="flex items-center justify-between gap-2 text-[11px] font-semibold leading-4"
        style={{ color: theme.text.primary }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <SourceThreadIcon icon={source.threadIcon} />
          <span className="min-w-0 truncate">{sourceConversationTitle(t, source)}</span>
        </span>
        <ArrowUpRight size={12} className="shrink-0" />
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-4" style={{ color: theme.text.secondary }}>
        {source.preview}
      </p>
    </button>
  )
}

function SourceCard({
  source,
  onRemove,
  onOpenThread
}: {
  source: ThingSourceRecord
  onRemove: () => void
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
  const t = useT()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 1400)
    return () => window.clearTimeout(timer)
  }, [copyState])

  async function handleCopy(): Promise<void> {
    try {
      await copyTextWithFallback(source.preview)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <figure className="rounded-3xl p-4" style={{ background: alpha('surface', 0.72) }}>
      <figcaption
        className="flex items-center justify-between gap-3 text-xs"
        style={{ color: theme.text.muted }}
      >
        <span
          className="flex min-w-0 items-center gap-1.5 font-semibold"
          style={{ color: theme.text.primary }}
        >
          <SourceThreadIcon icon={source.threadIcon} />
          <span className="min-w-0 truncate">{sourceConversationTitle(t, source)}</span>
        </span>
        <span className="shrink-0">{formatDate(new Date(source.createdAt), 'date')}</span>
      </figcaption>
      <p className="mt-3 text-sm leading-6" style={{ color: theme.text.primary }}>
        {source.preview}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton
          onClick={() => onOpenThread(source.threadId, source.messageId)}
          icon={<ArrowUpRight size={14} />}
        >
          {t('things.openConversation')}
        </SecondaryButton>
        <SecondaryButton
          onClick={handleCopy}
          icon={copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        >
          {copyState === 'copied'
            ? t('common.copied')
            : copyState === 'failed'
              ? t('things.copyFailed')
              : t('things.copyPreview')}
        </SecondaryButton>
        <SecondaryButton onClick={onRemove} icon={<Trash2 size={14} />} tone="danger">
          {t('things.removeSource')}
        </SecondaryButton>
      </div>
    </figure>
  )
}

function SourceThreadIcon({ icon }: { icon?: string }): React.JSX.Element | null {
  if (!icon) return null
  return <span className="shrink-0 leading-none">{icon}</span>
}

function sourceConversationTitle(
  t: Translator,
  source: Pick<ThingSourceRecord, 'threadId' | 'threadTitle'>
): string {
  return (
    source.threadTitle?.trim() || t('things.conversationFallback', { id: shortId(source.threadId) })
  )
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function SectionTitle({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div
        className="text-xs font-semibold uppercase tracking-[0.18em]"
        style={{ color: theme.text.muted }}
      >
        {label}
      </div>
      <div
        className="rounded-full px-2 py-0.5 text-xs tabular-nums"
        style={{ background: theme.background.counterSoft, color: theme.text.muted }}
      >
        {count}
      </div>
    </div>
  )
}

function PrimaryButton({
  children,
  onClick
}: {
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition hover:scale-[1.02]"
      style={{
        background: theme.background.accentFill,
        color: theme.text.onAccentFill,
        boxShadow: theme.shadow.button
      }}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  icon,
  tone = 'normal',
  onClick
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  tone?: 'normal' | 'danger'
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition hover:scale-[1.02]"
      style={{
        background: tone === 'danger' ? theme.background.dangerSoft : theme.background.surfaceSoft,
        color: tone === 'danger' ? theme.text.dangerStrong : theme.text.primary
      }}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}

function StatusPill({
  tone,
  label
}: {
  tone: 'accent' | 'muted'
  label: string
}): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{
        background: tone === 'accent' ? theme.background.accentSoft : theme.background.counterSoft,
        color: tone === 'accent' ? theme.text.accent : theme.text.muted
      }}
    >
      {label}
    </span>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="rounded-2xl px-3 py-4 text-sm"
      style={{ background: alpha('surface', 0.52), color: theme.text.muted }}
    >
      {children}
    </div>
  )
}
