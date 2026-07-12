import { useEffect, useMemo, useRef, useState } from 'react'

import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { ThingRecord } from '@renderer/app/types'
import { alpha, theme } from '@renderer/theme/theme'
import { ThingColumn, ThingDetailOverlay } from './ThingCard'
import { canScrollInWheelDirection, resolveThingsBoardWheelDelta } from '../lib/thingsBoardWheel'

const THINGS_DAILY_REVIEW_SCHEDULE_ID = 'bundled:things-daily-review'

export interface ThingsPageProps {
  showHeader?: boolean
  onContinueThing?: (name: string) => Promise<void>
  onMergeThing?: (sourceName: string, targetName: string) => Promise<void>
  onOpenThread?: (threadId: string, messageId?: string) => void
  onOpenSettingsRoute?: (route: string) => void
}

export function ThingsPanelTopControls({
  headerPaddingLeft
}: {
  headerPaddingLeft: number
}): React.JSX.Element {
  const t = useT()
  const things = useAppStore((s) => s.things)
  const showInactiveThings = useAppStore((s) => s.showInactiveThings)
  const toggleShowInactiveThings = useAppStore((s) => s.toggleShowInactiveThings)
  const activeCount = countActiveThings(things)
  const sourceCount = countSources(things)

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-4"
      style={{ paddingLeft: `${headerPaddingLeft}px`, paddingRight: 20 }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" style={{ color: theme.text.primary }}>
          {t('things.title')}
        </div>
        <div className="truncate text-xs font-medium" style={{ color: theme.text.muted }}>
          {t('things.activeCount', { count: activeCount })} ·{' '}
          {tPlural('things.sourceCount', sourceCount)}
        </div>
      </div>
      <InactiveThingsToggleButton
        showInactiveThings={showInactiveThings}
        onClick={toggleShowInactiveThings}
      />
    </div>
  )
}

export function ThingsPage({
  showHeader = true,
  onContinueThing,
  onMergeThing,
  onOpenThread,
  onOpenSettingsRoute
}: ThingsPageProps): React.JSX.Element {
  const things = useAppStore((s) => s.things)
  const showInactiveThings = useAppStore((s) => s.showInactiveThings)
  const loadThings = useAppStore((s) => s.loadThings)
  const restoreThing = useAppStore((s) => s.restoreThing)
  const renameThing = useAppStore((s) => s.renameThing)
  const deleteThing = useAppStore((s) => s.deleteThing)
  const removeThingSource = useAppStore((s) => s.removeThingSource)
  const continueThingInNewChat = useAppStore((s) => s.continueThingInNewChat)
  const mergeThingInNewChat = useAppStore((s) => s.mergeThingInNewChat)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const t = useT()
  const dialog = useAppDialog()
  const [selectedThingId, setSelectedThingId] = useState<string | null>(null)
  const [isDailyReviewEnabled, setIsDailyReviewEnabled] = useState<boolean | null>(null)
  const boardScrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadThings({ includeInactive: showInactiveThings })
  }, [loadThings, showInactiveThings])

  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo
      .listSchedules()
      .then((schedules) => {
        if (cancelled) return
        const dailyReviewSchedule = schedules.find(
          (schedule) => schedule.id === THINGS_DAILY_REVIEW_SCHEDULE_ID
        )
        setIsDailyReviewEnabled(dailyReviewSchedule?.enabled === true)
      })
      .catch(() => {
        if (!cancelled) setIsDailyReviewEnabled(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

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
  const sourceCount = countSources(things)
  const contentPadding = showHeader
    ? 'px-4 pb-6 sm:px-6 lg:px-8 lg:pb-8'
    : 'px-4 py-5 sm:px-6 sm:py-6'
  const handleContinue = onContinueThing ?? continueThingInNewChat
  const handleMerge = onMergeThing ?? mergeThingInNewChat
  const handleOpenThread = onOpenThread ?? setActiveThread

  function handleBoardWheel(event: React.WheelEvent<HTMLDivElement>): void {
    const scroller = boardScrollerRef.current
    if (!scroller || canNestedVerticalScrollerHandleWheel(scroller, event.target, event.deltaY)) {
      return
    }

    const horizontalDelta = resolveThingsBoardWheelDelta({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      horizontal: {
        scrollOffset: scroller.scrollLeft,
        viewportSize: scroller.clientWidth,
        contentSize: scroller.scrollWidth
      }
    })
    if (horizontalDelta === null) return

    event.preventDefault()
    scroller.scrollLeft += horizontalDelta
  }

  async function handleRenameThing(thing: ThingRecord): Promise<void> {
    const nextName = await dialog.prompt({
      title: t('things.renameThing'),
      initialValue: thing.name,
      confirmLabel: t('common.rename')
    })
    if (nextName === null) return

    const trimmedName = nextName.trim()
    if (normalizeThingSlug(trimmedName) === thing.name) return

    try {
      await renameThing(thing.name, trimmedName)
    } catch (error) {
      await dialog.alert({
        title:
          error instanceof Error ? error.message : t('things.renameFailed', { name: thing.name })
      })
    }
  }

  async function handleMergeThing(source: ThingRecord, target: ThingRecord): Promise<void> {
    const confirmed = await dialog.confirm({
      title: t('things.mergeConfirmTitle', { source: source.name, target: target.name }),
      message: t('things.mergeConfirmMessage'),
      confirmLabel: t('things.merge')
    })
    if (!confirmed) return

    try {
      await handleMerge(source.name, target.name)
      setSelectedThingId(null)
    } catch (error) {
      await dialog.alert({
        title:
          error instanceof Error ? error.message : t('things.mergeFailed', { name: source.name })
      })
    }
  }

  async function handleDeleteThing(thing: ThingRecord): Promise<void> {
    const confirmed = await dialog.confirm({
      title: t('things.deleteConfirmTitle', { name: thing.name }),
      message: t('things.deleteConfirmMessage'),
      confirmLabel: t('common.delete'),
      tone: 'danger'
    })
    if (!confirmed) return
    try {
      await deleteThing(thing.name)
      setSelectedThingId(null)
    } catch (error) {
      await dialog.alert({
        title:
          error instanceof Error ? error.message : t('things.deleteFailed', { name: thing.name })
      })
    }
  }

  async function handleRemoveSource(thing: ThingRecord, sourceId: string): Promise<void> {
    const confirmed = await dialog.confirm({
      title: t('things.removeSourceConfirmTitle'),
      message: t('things.removeSourceConfirmMessage', { name: thing.name }),
      confirmLabel: t('things.removeSource'),
      tone: 'danger'
    })
    if (!confirmed) return
    try {
      await removeThingSource({ name: thing.name, sourceId })
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('things.removeSourceFailed')
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
                {t('things.contextBoard')}
              </div>
              <h1
                className="mt-2 text-3xl font-semibold tracking-[-0.03em]"
                style={{ color: theme.text.primary }}
              >
                {t('things.title')}
              </h1>
              <p
                className="mt-2 max-w-2xl text-sm leading-6"
                style={{ color: theme.text.secondary }}
              >
                {t('things.pageDescription')}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <Metric label={t('things.activeMetric')} value={activeCount} />
              <Metric label={t('things.sourcesMetric')} value={sourceCount} />
            </div>
          </div>
        </header>
      ) : null}

      {boardThings.length === 0 ? (
        <div
          className={`flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden ${contentPadding}`}
        >
          <div className="px-6 py-12 text-center">
            <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
              {t('things.noThingsYet')}
            </div>
            <p
              className="mx-auto mt-2 max-w-md text-sm leading-6"
              style={{ color: theme.text.secondary }}
            >
              {t('things.emptyStateHint')}
            </p>
            {isDailyReviewEnabled === false && onOpenSettingsRoute ? (
              <button
                type="button"
                className="mt-4 rounded-full px-3 py-1.5 text-sm font-semibold transition hover:scale-[1.01]"
                style={{ color: theme.text.accent, background: theme.background.accentSoft }}
                onClick={() => onOpenSettingsRoute('schedules/list')}
              >
                {t('things.turnOnDailyReview')}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={`min-h-0 min-w-0 overflow-hidden ${contentPadding}`}>
          <div
            ref={boardScrollerRef}
            className="h-full min-h-0 min-w-0 overflow-x-auto overflow-y-hidden"
            onWheel={handleBoardWheel}
          >
            <div
              className="grid h-full min-h-0 items-stretch gap-3 pb-4 pr-4 sm:gap-4 sm:pr-6"
              style={{
                gridAutoFlow: 'column',
                gridAutoColumns: 'clamp(280px, 30vw, 360px)',
                gridTemplateRows: 'minmax(0, 1fr)'
              }}
            >
              {boardThings.map((thing) => (
                <ThingColumn
                  key={thing.id}
                  thing={thing}
                  onOpen={() => setSelectedThingId(thing.id)}
                  onContinue={(name) => void handleContinue(name)}
                  onRestore={(name) => void restoreThing(name)}
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
          onRestore={(name) => void restoreThing(name)}
          onRename={() => void handleRenameThing(selectedThing)}
          onMerge={(target) => void handleMergeThing(selectedThing, target)}
          onDelete={() => void handleDeleteThing(selectedThing)}
          onRemoveSource={(source) => void handleRemoveSource(selectedThing, source.id)}
          onOpenThread={handleOpenThread}
          mergeTargets={boardThings.filter((thing) => thing.id !== selectedThing.id)}
        />
      ) : null}
    </div>
  )
}

function countActiveThings(things: ThingRecord[]): number {
  return things.filter((thing) => !thing.isInactive).length
}

function countSources(things: ThingRecord[]): number {
  return things.reduce((count, thing) => count + thing.sources.length, 0)
}

function canNestedVerticalScrollerHandleWheel(
  boardScroller: HTMLDivElement,
  target: EventTarget,
  deltaY: number
): boolean {
  if (!(target instanceof Element)) return false

  let element: Element | null = target
  while (element && element !== boardScroller) {
    if (element instanceof HTMLElement) {
      const overflowY = window.getComputedStyle(element).overflowY
      const canScrollVertically =
        overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      if (
        canScrollVertically &&
        canScrollInWheelDirection(
          {
            scrollOffset: element.scrollTop,
            viewportSize: element.clientHeight,
            contentSize: element.scrollHeight
          },
          deltaY
        )
      ) {
        return true
      }
    }
    element = element.parentElement
  }

  return false
}

function normalizeThingSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function InactiveThingsToggleButton({
  showInactiveThings,
  onClick
}: {
  showInactiveThings: boolean
  onClick: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={showInactiveThings}
      className="no-drag inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-xs font-medium transition hover:scale-[1.01]"
      style={{ color: showInactiveThings ? theme.text.primary : theme.text.secondary }}
      onClick={onClick}
    >
      <span
        className="relative inline-flex shrink-0 rounded-full p-0.5 transition"
        style={{
          width: 30,
          height: 17,
          background: showInactiveThings ? theme.text.accent : alpha('ink', 0.14)
        }}
      >
        <span
          className="block rounded-full transition-transform"
          style={{
            width: 13,
            height: 13,
            background: theme.text.inverse,
            transform: showInactiveThings ? 'translateX(13px)' : 'translateX(0)'
          }}
        />
      </span>
      {showInactiveThings ? t('things.hideInactive') : t('things.showInactive')}
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
