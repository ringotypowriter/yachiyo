import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, Copy, MessageCircle, Quote, RotateCcw, Sparkles } from 'lucide-react'

import type { ThingRecord } from '@renderer/app/types'
import type { ThingSourceQuoteRecord } from '@yachiyo/shared/protocol'
import { alpha, theme } from '@renderer/theme/theme'
import { copyTextWithFallback } from '../../chat/lib/copyTextWithFallback'

export function ThingCard({
  thing,
  selected,
  onSelect,
  onContinue,
  onReactivate
}: {
  thing: ThingRecord
  selected: boolean
  onSelect: () => void
  onContinue: (name: string) => void
  onReactivate: (name: string) => void
}): React.JSX.Element {
  const sourceCount = thing.sourceQuotes.length
  const chatCount = thing.includedChats.length

  return (
    <article
      className="group rounded-[1.75rem] border p-5 text-left transition duration-200 hover:-translate-y-0.5"
      style={{
        background: selected ? theme.background.accentSoft : theme.background.surface,
        borderColor: selected ? theme.border.accent : theme.border.subtle,
        boxShadow: selected ? theme.shadow.card : 'none'
      }}
    >
      <button type="button" className="block w-full text-left" onClick={onSelect}>
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                className="truncate text-lg font-semibold tracking-[-0.02em]"
                style={{ color: theme.text.primary }}
              >
                #{thing.name}
              </h2>
              {thing.isInactive ? <StatusPill tone="muted" label="Inactive" /> : null}
            </div>
            <p
              className="mt-2 line-clamp-2 text-sm leading-6"
              style={{ color: theme.text.secondary }}
            >
              {thing.summary || 'No summary yet.'}
            </p>
          </div>
          <div
            className="shrink-0 text-right text-xs tabular-nums"
            style={{ color: theme.text.muted }}
          >
            {thing.isInactive
              ? 'No updates in 3 days'
              : `Updated ${formatDate(thing.lastUpdatedAt)}`}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ContextChip
            icon={<MessageCircle size={13} />}
            label={`${chatCount} chat${chatCount === 1 ? '' : 's'}`}
          />
          <ContextChip
            icon={<Quote size={13} />}
            label={`${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
          />
        </div>
      </button>

      <div className="mt-4 flex flex-wrap gap-2">
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

export function ThingSourcePanel({
  thing,
  onContinue,
  onReactivate,
  onOpenThread
}: {
  thing: ThingRecord | null
  onContinue: (name: string) => void
  onReactivate: (name: string) => void
  onOpenThread: (threadId: string, messageId?: string) => void
}): React.JSX.Element {
  if (!thing) {
    return (
      <aside
        className="rounded-[2rem] border p-6"
        style={{ borderColor: theme.border.subtle, background: theme.background.surface }}
      >
        <div className="text-sm" style={{ color: theme.text.secondary }}>
          Select a Thing to inspect its sources.
        </div>
      </aside>
    )
  }

  return (
    <aside className="lg:sticky lg:top-7 lg:self-start">
      <div
        className="overflow-hidden rounded-[2rem] border"
        style={{
          borderColor: theme.border.subtle,
          background: theme.background.surface,
          boxShadow: theme.shadow.card
        }}
      >
        <div className="border-b p-5" style={{ borderColor: theme.border.subtle }}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div
                className="text-xs font-semibold uppercase tracking-[0.18em]"
                style={{ color: theme.text.muted }}
              >
                Source view
              </div>
              <h2
                className="mt-2 truncate text-xl font-semibold tracking-[-0.03em]"
                style={{ color: theme.text.primary }}
              >
                #{thing.name}
              </h2>
            </div>
            {thing.isInactive ? (
              <StatusPill tone="muted" label="Inactive" />
            ) : (
              <StatusPill tone="accent" label="Active" />
            )}
          </div>
          <p className="mt-3 text-sm leading-6" style={{ color: theme.text.secondary }}>
            {thing.summary || 'No summary yet.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
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
        </div>

        <div className="max-h-[calc(100vh-17rem)] overflow-auto p-5">
          <SectionTitle label="Included chats" count={thing.includedChats.length} />
          <div className="mt-3 flex flex-col gap-2">
            {thing.includedChats.length === 0 ? (
              <EmptyLine>No linked chats yet.</EmptyLine>
            ) : (
              thing.includedChats.map((chat) => (
                <button
                  type="button"
                  key={`${chat.thingId}:${chat.threadId}`}
                  className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-3 text-left text-sm transition hover:translate-x-0.5"
                  style={{
                    borderColor: theme.border.subtle,
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

          <div className="mt-6">
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
          </div>
        </div>
      </div>
    </aside>
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
    <figure
      className="rounded-3xl border p-4"
      style={{ borderColor: theme.border.subtle, background: alpha('surface', 0.72) }}
    >
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
      <Sparkles size={14} />
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
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-medium transition hover:scale-[1.02]"
      style={{
        borderColor: theme.border.subtle,
        background: theme.background.surfaceSoft,
        color: theme.text.primary
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
      className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
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
      className="rounded-2xl border border-dashed px-3 py-4 text-sm"
      style={{ borderColor: theme.border.subtle, color: theme.text.muted }}
    >
      {children}
    </div>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
