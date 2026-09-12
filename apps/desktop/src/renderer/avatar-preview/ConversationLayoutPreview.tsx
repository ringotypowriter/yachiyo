import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppDialogContext } from '@renderer/components/AppDialogContext'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { THEME_OPTIONS, type ThemeId } from '@renderer/theme/theme'
import { applyThemeAttributes } from '@renderer/theme/themeRuntime'
import { SimpleSelect } from '../settings/components/primitives'
import { buildLayoutPreviewState, type PreviewPhase } from './layoutFixture'

const dialog = {
  alert: async (): Promise<void> => {},
  confirm: async (): Promise<boolean> => false,
  prompt: async (): Promise<string | null> => null
}
const phaseOptions: Array<{ value: PreviewPhase; label: string }> = [
  { value: 'idle', label: 'Idle' },
  { value: 'loading', label: 'Loading' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'speaking', label: 'Speaking' },
  { value: 'working', label: 'Working' },
  { value: 'waiting', label: 'Waiting for you' }
]

export function ConversationLayoutPreview(): React.JSX.Element {
  const [phase, setPhase] = useState<PreviewPhase>('idle')
  const [welcome, setWelcome] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [themeId, setThemeId] = useState<ThemeId>('mizu')
  const [variant, setVariant] = useState<'light' | 'dark'>('light')
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    useAppStore.setState(buildLayoutPreviewState(phase, welcome, new Date().toISOString()))
  }, [phase, welcome])
  useEffect(() => {
    applyThemeAttributes({ themeId, appearance: variant, variant })
  }, [themeId, variant])
  useEffect(() => {
    const answered = (): void => setPhase('speaking')
    window.addEventListener('layout-preview-answer', answered)
    return () => window.removeEventListener('layout-preview-answer', answered)
  }, [])
  useLayoutEffect(() => {
    // Retain the real input layout and editable draft, but make native-action controls inert.
    const disableNativeActions = (): void => {
      panel.current?.querySelectorAll<HTMLElement>('.composer-shell button').forEach((button) => {
        button.inert = true
      })
    }
    disableNativeActions()
    const observer = new MutationObserver(disableNativeActions)
    if (panel.current) observer.observe(panel.current, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return (
    <main id="layout-study" data-narrow={narrow}>
      <header className="layout-study-controls">
        <div className="layout-study-caption">
          <strong>Reading margin study</strong>
          <span>Isolated preview · No provider requests</span>
        </div>
        <SimpleSelect
          value={phase}
          options={phaseOptions}
          onChange={(value) => {
            setWelcome(false)
            setPhase(value)
          }}
          width={152}
        />
        <button onClick={() => setPhase('idle')}>Finish</button>
        <button aria-pressed={welcome} onClick={() => setWelcome(!welcome)}>
          Welcome
        </button>
        <button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>
          Narrow
        </button>
        <SimpleSelect
          value={themeId}
          options={THEME_OPTIONS.map(({ id, label }) => ({ value: id, label }))}
          onChange={setThemeId}
          width={116}
        />
        <button onClick={() => setVariant(variant === 'light' ? 'dark' : 'light')}>
          {variant === 'light' ? 'Dark' : 'Light'}
        </button>
        <a href="./">Motion preview</a>
      </header>
      <div className="layout-study-stage">
        <div ref={panel} className="layout-study-frame">
          <AppDialogContext.Provider value={dialog}>
            <AppMainPanel
              headerPaddingLeft={16}
              isSidebarToggleDisabled={true}
              showSidebarToggle={false}
              onToggleSidebar={() => {}}
              toggleSidebarTitle="Sidebar"
              pendingFindQuery={null}
              onPendingFindQueryApplied={() => {}}
              shortcutsEnabled={false}
            >
              {({ content, contentTopControls }) => (
                <>
                  <div className="layout-study-titlebar" inert>
                    {contentTopControls}
                  </div>
                  {content}
                </>
              )}
            </AppMainPanel>
          </AppDialogContext.Provider>
        </div>
      </div>
      <footer className="layout-study-note">
        The reading area gives 48px to the character. Scroll the answer, try Speaking, or type
        several lines in the input to inspect the tradeoff.
      </footer>
    </main>
  )
}
