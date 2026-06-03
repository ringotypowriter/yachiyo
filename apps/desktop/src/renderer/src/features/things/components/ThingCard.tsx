import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, Copy, RotateCcw, Trash2, X } from 'lucide-react'

import type { ThingRecord } from '@renderer/app/types'
import type { ThingSourceRecord } from '@yachiyo/shared/protocol'
import { alpha, theme } from '@renderer/theme/theme'
import { copyTextWithFallback } from '../../chat/lib/messages/copyTextWithFallback'

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
          {thing.isInactive ? <StatusPill tone="muted" label="Inactive" /> : null}
        </div>

        <div className="mt-2 text-xs font-medium" style={{ color: theme.text.muted }}>
          Updated {formatDate(thing.lastUpdatedAt)} · {sourceCountLabel(sourceCount)}
        </div>

        <p className="mt-4 line-clamp-3 text-sm leading-6" style={{ color: theme.text.secondary }}>
          {thing.summary || 'No summary yet.'}
        </p>
      </button>

      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3">
          <div
            className="text-xs font-semibold uppercase tracking-[0.16em]"
            style={{ color: theme.text.muted }}
          >
            Source previews
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
              No sources yet.
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-wrap gap-2 pt-5">
        <PrimaryButton onClick={() => onContinue(thing.name)}>
          {thing.isInactive ? 'Restore and continue' : 'Continue'}
        </PrimaryButton>
        {thing.isInactive ? (
          <SecondaryButton onClick={() => onRestore(thing.name)} icon={<RotateCcw size={14} />}>
            Restore
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
  onDelete,
  onRemoveSource,
  onOpenThread
}: {
  thing: ThingRecord
  onClose: () => void
  onContinue: (name: string) => void
  onRestore: (name: string) => void
  onDelete: () => void
  onRemoveSource: (source: ThingSourceRecord) => void
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
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
              Updated {formatDate(thing.lastUpdatedAt)} · {sourceCountLabel(thing.sources.length)}
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-6" style={{ color: theme.text.secondary }}>
              {thing.summary || 'No summary yet.'}
            </p>
          </div>
          <button
            type="button"
            className="rounded-full p-2 transition hover:scale-105"
            style={{ background: theme.background.counterSoft, color: theme.text.primary }}
            onClick={onClose}
            aria-label="Close Thing details"
          >
            <X size={18} />
          </button>
        </header>

        <div className="mt-5 flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-2">
            <PrimaryButton onClick={() => onContinue(thing.name)}>
              {thing.isInactive ? 'Restore and continue' : 'Continue'}
            </PrimaryButton>
            {thing.isInactive ? (
              <SecondaryButton onClick={() => onRestore(thing.name)} icon={<RotateCcw size={14} />}>
                Restore
              </SecondaryButton>
            ) : null}
          </div>
          <SecondaryButton onClick={onDelete} icon={<Trash2 size={14} />} tone="danger">
            Delete
          </SecondaryButton>
        </div>

        <div className="mt-6 min-h-0 overflow-auto">
          <SectionTitle label="Source previews" count={thing.sources.length} />
          <div className="mt-3 flex flex-col gap-3">
            {thing.sources.length === 0 ? (
              <EmptyLine>No source previews saved yet.</EmptyLine>
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
    </div>
  )
}

function SourcePreview({
  source,
  onOpenThread
}: {
  source: ThingSourceRecord
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
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
          <span className="min-w-0 truncate">{sourceConversationTitle(source)}</span>
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
          <span className="min-w-0 truncate">{sourceConversationTitle(source)}</span>
        </span>
        <span className="shrink-0">{formatDate(source.createdAt)}</span>
      </figcaption>
      <p className="mt-3 text-sm leading-6" style={{ color: theme.text.primary }}>
        {source.preview}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton
          onClick={() => onOpenThread(source.threadId, source.messageId)}
          icon={<ArrowUpRight size={14} />}
        >
          Open conversation
        </SecondaryButton>
        <SecondaryButton
          onClick={handleCopy}
          icon={copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy preview'}
        </SecondaryButton>
        <SecondaryButton onClick={onRemove} icon={<Trash2 size={14} />} tone="danger">
          Remove source
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
  source: Pick<ThingSourceRecord, 'threadId' | 'threadTitle'>
): string {
  return source.threadTitle?.trim() || `Conversation ${shortId(source.threadId)}`
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
        background: theme.text.accent,
        color: theme.text.inverse,
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

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function sourceCountLabel(count: number): string {
  return `${count} source${count === 1 ? '' : 's'}`
}
