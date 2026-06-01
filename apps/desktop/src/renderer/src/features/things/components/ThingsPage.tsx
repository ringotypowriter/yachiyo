import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '@renderer/app/store/useAppStore'
import type { ThingRecord } from '@renderer/app/types'
import { alpha, theme } from '@renderer/theme/theme'
import { ThingCard, ThingSourcePanel } from './ThingCard'

export function ThingsPage(): React.JSX.Element {
  const things = useAppStore((s) => s.things)
  const showInactiveThings = useAppStore((s) => s.showInactiveThings)
  const loadThings = useAppStore((s) => s.loadThings)
  const toggleShowInactiveThings = useAppStore((s) => s.toggleShowInactiveThings)
  const reactivateThing = useAppStore((s) => s.reactivateThing)
  const continueThingInNewChat = useAppStore((s) => s.continueThingInNewChat)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const [selectedThingId, setSelectedThingId] = useState<string | null>(null)

  useEffect(() => {
    void loadThings({ includeInactive: showInactiveThings })
  }, [loadThings, showInactiveThings])

  const visibleThings = useMemo(() => {
    return [...things].sort((a, b) => {
      if (a.isInactive !== b.isInactive) return a.isInactive ? 1 : -1
      return Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt)
    })
  }, [things])

  const selectedThing = useMemo<ThingRecord | null>(() => {
    if (visibleThings.length === 0) return null
    return visibleThings.find((thing) => thing.id === selectedThingId) ?? visibleThings[0]
  }, [selectedThingId, visibleThings])

  const activeCount = things.filter((thing) => !thing.isInactive).length
  const quoteCount = things.reduce((count, thing) => count + thing.sourceQuotes.length, 0)

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div
              className="text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: theme.text.muted }}
            >
              Context index
            </div>
            <h1
              className="mt-2 text-3xl font-semibold tracking-[-0.03em]"
              style={{ color: theme.text.primary }}
            >
              Things
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: theme.text.secondary }}>
              Durable work context with source-backed evidence. Mention a Thing with #name to carry
              it into a chat.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Metric label="Active" value={activeCount} />
            <Metric label="Sources" value={quoteCount} />
            <button
              type="button"
              className="rounded-full border px-4 py-2 text-sm font-medium transition hover:scale-[1.01]"
              style={{
                borderColor: showInactiveThings ? theme.border.accent : theme.border.panel,
                background: showInactiveThings
                  ? theme.background.accentSoft
                  : theme.background.surface,
                color: showInactiveThings ? theme.text.accent : theme.text.secondary
              }}
              onClick={toggleShowInactiveThings}
            >
              {showInactiveThings ? 'Hide inactive' : 'Show inactive'}
            </button>
          </div>
        </header>

        {visibleThings.length === 0 ? (
          <div
            className="rounded-[2rem] border px-8 py-12 text-center"
            style={{
              borderColor: theme.border.subtle,
              background: theme.background.surface,
              boxShadow: theme.shadow.card
            }}
          >
            <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
              No Things yet
            </div>
            <p
              className="mx-auto mt-2 max-w-md text-sm leading-6"
              style={{ color: theme.text.secondary }}
            >
              The daily review will create one when a topic becomes worth carrying forward.
            </p>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="flex flex-col gap-3">
              {visibleThings.map((thing) => (
                <ThingCard
                  key={thing.id}
                  thing={thing}
                  selected={selectedThing?.id === thing.id}
                  onSelect={() => setSelectedThingId(thing.id)}
                  onContinue={(name) => void continueThingInNewChat(name)}
                  onReactivate={(name) => void reactivateThing(name)}
                />
              ))}
            </div>
            <ThingSourcePanel
              thing={selectedThing}
              onContinue={(name) => void continueThingInNewChat(name)}
              onReactivate={(name) => void reactivateThing(name)}
              onOpenThread={(threadId, messageId) => setActiveThread(threadId, messageId)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function ThingsSidebar(): React.JSX.Element {
  const things = useAppStore((s) => s.things)
  const activeCount = things.filter((thing) => !thing.isInactive).length
  const inactiveCount = things.length - activeCount
  return (
    <div className="p-4">
      <div
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: theme.text.muted }}
      >
        Things
      </div>
      <div className="mt-3 space-y-2 text-sm" style={{ color: theme.text.secondary }}>
        <div>{activeCount} active</div>
        <div>{inactiveCount} inactive shown</div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div
      className="rounded-2xl border px-4 py-2 text-right"
      style={{ borderColor: theme.border.subtle, background: alpha('surface', 0.72) }}
    >
      <div className="text-base font-semibold tabular-nums" style={{ color: theme.text.primary }}>
        {value}
      </div>
      <div
        className="text-[11px] font-medium uppercase tracking-wide"
        style={{ color: theme.text.muted }}
      >
        {label}
      </div>
    </div>
  )
}
