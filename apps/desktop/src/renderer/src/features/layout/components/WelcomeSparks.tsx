import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { Tooltip } from '@renderer/components/Tooltip'
import { WELCOME_SPARKS } from '@renderer/features/layout/lib/welcomeSparks'

type SparksFade = 'none' | 'left' | 'right' | 'both'

export function WelcomeSparks(): React.JSX.Element {
  const dialog = useAppDialog()
  const startSparkChat = useAppStore((s) => s.startSparkChat)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [fade, setFade] = useState<SparksFade>('none')

  const updateFade = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const maxScroll = el.scrollWidth - el.clientWidth
    if (maxScroll <= 1) {
      setFade('none')
      return
    }
    const atStart = el.scrollLeft <= 1
    const atEnd = el.scrollLeft >= maxScroll - 1
    setFade(atStart ? 'right' : atEnd ? 'left' : 'both')
  }, [])

  useEffect(() => {
    updateFade()
    const el = scrollerRef.current
    if (!el) return
    const observer = new ResizeObserver(updateFade)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateFade])

  function handleWheel(event: React.WheelEvent<HTMLDivElement>): void {
    const el = scrollerRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    el.scrollLeft += event.deltaY
  }

  async function handleLaunch(sparkId: string, prompt: string): Promise<void> {
    if (launchingId) return
    setLaunchingId(sparkId)
    try {
      await startSparkChat(prompt)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to start the chat.'
      })
    } finally {
      setLaunchingId(null)
    }
  }

  return (
    <div
      ref={scrollerRef}
      className="welcome-sparks"
      data-fade={fade}
      onScroll={updateFade}
      onWheel={handleWheel}
    >
      {WELCOME_SPARKS.map((spark, index) => {
        const Icon = spark.icon
        const isLaunching = launchingId === spark.id
        return (
          <motion.div
            key={spark.id}
            initial={{ opacity: 0, y: 7 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, delay: 0.14 + index * 0.06, ease: 'easeOut' }}
          >
            <Tooltip content={spark.hint}>
              <button
                type="button"
                className={`welcome-sparks__button ${
                  isLaunching ? 'welcome-sparks__button--launching' : ''
                }`}
                disabled={launchingId !== null}
                onClick={() => void handleLaunch(spark.id, spark.prompt)}
              >
                <Icon className="welcome-sparks__icon" size={13} strokeWidth={2} />
                <span>{spark.label}</span>
              </button>
            </Tooltip>
          </motion.div>
        )
      })}
    </div>
  )
}
