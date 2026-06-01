import { useEffect, useMemo, useState } from 'react'

import { useAppDialog } from '@renderer/components/AppDialogContext'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { ThingRecord } from '@renderer/app/types'
import { alpha, theme } from '@renderer/theme/theme'
import { ThingColumn, ThingDetailOverlay } from './ThingCard'

export interface ThingsPageProps {
  showHeader?: boolean
  onContinueThing?: (name: string) => Promise<void>
  onOpenThread?: (threadId: string, messageId?: string) => void
}

export function ThingsPanelTopControls({
  headerPaddingLeft
}: {
  headerPaddingLeft: number
}): React.JSX.Element {
  const things = useAppStore((s) => s.things)
  const showInactiveThings = useAppStore((s) => s.showInactiveThings)
  const toggleShowInactiveThings = useAppStore((s) => s.toggleShowInactiveThings)
  const activeCount = countActiveThings(things)
  const quoteCount = countSourceQuotes(things)

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-4"
      style={{ paddingLeft: `${headerPaddingLeft}px`, paddingRight: 20 }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" style={{ color: theme.text.primary }}>
          Things
        </div>
        <div className="truncate text-xs font-medium" style={{ color: theme.text.muted }}>
          Context board · {activeCount} active · {quoteCount} source{quoteCount === 1 ? '' : 's'}
        </div>
      </div>
      <InactiveThingsToggleButton
        showInactiveThings={showInactiveThings}
        onClick={toggleShowInactiveThings}
        size="compact"
      />
    </div>
  )
}

export function ThingsPage({
  showHeader = true,
  onContinueThing,
  onOpenThread
}: ThingsPageProps): React.JSX.Element {
  const things = useAppStore((s) => s.things)
  const showInactiveThings = useAppStore((s) => s.showInactiveThings)
  const loadThings = useAppStore((s) => s.loadThings)
  const toggleShowInactiveThings = useAppStore((s) => s.toggleShowInactiveThings)
  const reactivateThing = useAppStore((s) => s.reactivateThing)
  const deleteThing = useAppStore((s) => s.deleteThing)
  const continueThingInNewChat = useAppStore((s) => s.continueThingInNewChat)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const dialog = useAppDialog()
  const [selectedThingId, setSelectedThingId] = useState<string | null>(null)

  useEffect(() => {
    void loadThings({ includeInactive: showInactiveThings })
  }, [loadThings, showInactiveThings])

  const boardThings = useMemo(() => {
    return [...things]
      .filter((thing) => showInactiveThings || !thing.isInactive)
      .sort((a, b) => {
        if (a.isInactive !== b.isInactive) return a.isInactive ? 1 : -1
        return Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt)
      })
  }, [showInactiveThings, things])

  const selectedThing = useMemo<ThingRecord | null>(() => {
    if (!selectedThingId) return null
    return things.find((thing) => thing.id === selectedThingId) ?? null
  }, [selectedThingId, things])

  const activeCount = countActiveThings(things)
  const quoteCount = countSourceQuotes(things)
  const contentPadding = showHeader ? 'px-8 pb-8' : 'px-6 py-6'
  const handleContinue = onContinueThing ?? continueThingInNewChat
  const handleOpenThread = onOpenThread ?? setActiveThread

  async function handleDeleteThing(thing: ThingRecord): Promise<void> {
    const confirmed = await dialog.confirm({
      title: `Delete #${thing.name}?`,
      message:
        'This removes the Thing and its saved source references. Conversations stay untouched.',
      confirmLabel: 'Delete',
      tone: 'danger'
    })
    if (!confirmed) return
    try {
      await deleteThing(thing.name)
      setSelectedThingId(null)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : `Failed to delete #${thing.name}.`
      })
    }
  }

  return (
    <div
      className="relative grid h-full min-h-0 min-w-0 overflow-hidden"
      style={{ gridTemplateRows: showHeader ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)' }}
    >
      {showHeader ? (
        <header className="min-w-0 px-8 pb-5 pt-7">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-6">
            <div className="min-w-0">
              <div
                className="text-xs font-semibold uppercase tracking-[0.18em]"
                style={{ color: theme.text.muted }}
              >
                Context board
              </div>
              <h1
                className="mt-2 text-3xl font-semibold tracking-[-0.03em]"
                style={{ color: theme.text.primary }}
              >
                Things
              </h1>
              <p
                className="mt-2 max-w-2xl text-sm leading-6"
                style={{ color: theme.text.secondary }}
              >
                Durable work context with source-backed evidence. Mention #name to carry a Thing
                into chat.
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <Metric label="Active" value={activeCount} />
              <Metric label="Sources" value={quoteCount} />
              <InactiveThingsToggleButton
                showInactiveThings={showInactiveThings}
                onClick={toggleShowInactiveThings}
              />
            </div>
          </div>
        </header>
      ) : null}

      {boardThings.length === 0 ? (
        <div
          className={`flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden ${contentPadding}`}
        >
          <div className="px-8 py-12 text-center">
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
        </div>
      ) : (
        <div className={`min-h-0 min-w-0 overflow-hidden ${contentPadding}`}>
          <div className="h-full min-h-0 min-w-0 overflow-x-auto overflow-y-hidden">
            <div
              className="grid items-start gap-4 pb-4 pr-8"
              style={{ gridAutoFlow: 'column', gridAutoColumns: '340px' }}
            >
              {boardThings.map((thing) => (
                <ThingColumn
                  key={thing.id}
                  thing={thing}
                  onOpen={() => setSelectedThingId(thing.id)}
                  onContinue={(name) => void handleContinue(name)}
                  onReactivate={(name) => void reactivateThing(name)}
                  onOpenThread={handleOpenThread}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedThing ? (
        <ThingDetailOverlay
          thing={selectedThing}
          onClose={() => setSelectedThingId(null)}
          onContinue={(name) => void handleContinue(name)}
          onReactivate={(name) => void reactivateThing(name)}
          onDelete={() => void handleDeleteThing(selectedThing)}
          onOpenThread={handleOpenThread}
        />
      ) : null}
    </div>
  )
}

function countActiveThings(things: ThingRecord[]): number {
  return things.filter((thing) => !thing.isInactive).length
}

function countSourceQuotes(things: ThingRecord[]): number {
  return things.reduce((count, thing) => count + thing.sourceQuotes.length, 0)
}

function InactiveThingsToggleButton({
  showInactiveThings,
  onClick,
  size = 'regular'
}: {
  showInactiveThings: boolean
  onClick: () => void
  size?: 'compact' | 'regular'
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`no-drag shrink-0 rounded-full font-medium transition hover:scale-[1.01] ${
        size === 'compact' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
      }`}
      style={{
        background: 'transparent',
        color: showInactiveThings ? theme.text.accent : theme.text.secondary
      }}
      onClick={onClick}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
      }}
    >
      {showInactiveThings ? 'Hide inactive' : 'Show inactive'}
    </button>
  )
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-2xl px-4 py-2 text-right" style={{ background: alpha('surface', 0.7) }}>
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
