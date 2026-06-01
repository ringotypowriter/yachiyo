import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, Copy, Quote, RotateCcw, X } from 'lucide-react'

import type { ThingRecord } from '@renderer/app/types'
import type { ThingSourceQuoteRecord } from '@yachiyo/shared/protocol'
import { alpha, theme } from '@renderer/theme/theme'
import { copyTextWithFallback } from '../../chat/lib/copyTextWithFallback'

export function ThingColumn({
  thing,
  onOpen,
  onContinue,
  onReactivate
}: {
  thing: ThingRecord
  onOpen: () => void
  onContinue: (name: string) => void
  onReactivate: (name: string) => void
}): React.JSX.Element {
  const sourceCount = thing.sourceQuotes.length

  return (
    <article
      className="flex h-105 w-85 flex-col rounded-[1.75rem] p-5 transition duration-200 hover:-translate-y-0.5"
      style={{
        background: thing.isInactive ? alpha('surface', 0.5) : alpha('surface', 0.76),
        boxShadow: thing.isInactive ? 'none' : theme.shadow.card,
        opacity: thing.isInactive ? 0.72 : 1
      }}
    >
      <button type="button" className="block shrink-0 text-left" onClick={onOpen}>
        <div className="flex items-start justify-between gap-4">
          <h2
            className="min-w-0 wrap-break-word text-lg font-semibold leading-tight tracking-[-0.03em]"
            style={{ color: theme.text.primary }}
          >
            #{thing.name}
          </h2>
          {thing.isInactive ? <StatusPill tone="muted" label="Inactive" /> : null}
        </div>

        <p className="mt-4 line-clamp-3 text-sm leading-6" style={{ color: theme.text.secondary }}>
          {thing.summary || 'No summary yet.'}
        </p>
      </button>

      <div className="mt-5 flex min-h-0 shrink-0 flex-col">
        <div className="flex items-center justify-between gap-3">
          <div
            className="text-xs font-semibold uppercase tracking-[0.16em]"
            style={{ color: theme.text.muted }}
          >
            Sources
          </div>
          <ContextChip
            icon={<Quote size={13} />}
            label={`${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
          />
        </div>
        <div className="mt-3 grid h-37.5 auto-rows-max grid-cols-1 gap-2 overflow-hidden">
          {thing.sourceQuotes.length > 0 ? (
            thing.sourceQuotes.slice(0, 4).map((source) => (
              <button
                type="button"
                key={source.id}
                className="rounded-2xl px-3 py-2 text-left text-xs leading-5 transition hover:translate-x-0.5"
                style={{ background: theme.background.surfaceSoft, color: theme.text.secondary }}
                onClick={onOpen}
              >
                <span className="line-clamp-2">“{source.quote}”</span>
              </button>
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
        <PrimaryButton onClick={() => onContinue(thing.name)}>Continue</PrimaryButton>
        {thing.isInactive ? (
          <SecondaryButton onClick={() => onReactivate(thing.name)} icon={<RotateCcw size={14} />}>
            Reactivate
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
  onReactivate,
  onOpenThread
}: {
  thing: ThingRecord
  onClose: () => void
  onContinue: (name: string) => void
  onReactivate: (name: string) => void
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
            <div
              className="text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: theme.text.muted }}
            >
              Evidence
            </div>
            <h2
              className="mt-2 wrap-break-word text-3xl font-semibold tracking-[-0.04em]"
              style={{ color: theme.text.primary }}
            >
              #{thing.name}
            </h2>
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

        <div className="mt-5 flex shrink-0 flex-wrap gap-2">
          <PrimaryButton onClick={() => onContinue(thing.name)}>Continue</PrimaryButton>
          {thing.isInactive ? (
            <SecondaryButton
              onClick={() => onReactivate(thing.name)}
              icon={<RotateCcw size={14} />}
            >
              Reactivate
            </SecondaryButton>
          ) : null}
        </div>

        <div className="mt-6 grid min-h-0 gap-6 overflow-auto lg:grid-cols-[280px_minmax(0,1fr)]">
          <section>
            <SectionTitle label="Included chats" count={thing.includedChats.length} />
            <div className="mt-3 flex flex-col gap-2">
              {thing.includedChats.length === 0 ? (
                <EmptyLine>No linked chats yet.</EmptyLine>
              ) : (
                thing.includedChats.map((chat) => (
                  <button
                    type="button"
                    key={`${chat.thingId}:${chat.threadId}`}
                    className="flex items-center justify-between gap-3 rounded-2xl px-3 py-3 text-left text-sm transition hover:translate-x-0.5"
                    style={{
                      background: theme.background.surfaceSoft,
                      color: theme.text.secondary
                    }}
                    onClick={() => onOpenThread(chat.threadId)}
                  >
                    <span className="min-w-0 truncate">{chat.threadTitle ?? chat.threadId}</span>
                    <ArrowUpRight size={14} className="shrink-0" />
                  </button>
                ))
              )}
            </div>
          </section>

          <section>
            <SectionTitle label="Source quotes" count={thing.sourceQuotes.length} />
            <div className="mt-3 flex flex-col gap-3">
              {thing.sourceQuotes.length === 0 ? (
                <EmptyLine>No source quotes saved yet.</EmptyLine>
              ) : (
                thing.sourceQuotes.map((quote) => (
                  <SourceQuoteCard key={quote.id} quote={quote} onOpenThread={onOpenThread} />
                ))
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}

function SourceQuoteCard({
  quote,
  onOpenThread
}: {
  quote: ThingSourceQuoteRecord
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
      await copyTextWithFallback(quote.quote)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <figure className="rounded-3xl p-4" style={{ background: alpha('surface', 0.72) }}>
      <blockquote className="text-sm leading-6" style={{ color: theme.text.primary }}>
        “{quote.quote}”
      </blockquote>
      <figcaption
        className="mt-3 flex items-center justify-between gap-3 text-xs"
        style={{ color: theme.text.muted }}
      >
        <span className="min-w-0 truncate">{quote.threadTitle ?? quote.threadId}</span>
        <span className="shrink-0">{formatDate(quote.createdAt)}</span>
      </figcaption>
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton
          onClick={() => onOpenThread(quote.threadId, quote.messageId)}
          icon={<ArrowUpRight size={14} />}
        >
          Open source
        </SecondaryButton>
        <SecondaryButton
          onClick={handleCopy}
          icon={copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy quote'}
        </SecondaryButton>
      </div>
    </figure>
  )
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

function ContextChip({ icon, label }: { icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: theme.background.counterSoft, color: theme.text.secondary }}
    >
      {icon}
      {label}
    </span>
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
  onClick
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition hover:scale-[1.02]"
      style={{ background: theme.background.surfaceSoft, color: theme.text.primary }}
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
