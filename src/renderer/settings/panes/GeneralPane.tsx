import { DEFAULT_SIDEBAR_VISIBILITY } from '../../../shared/yachiyo/protocol.ts'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { PlaceholderPane, SettingSwitch } from '../components/primitives'
import { settingsPanelStyle } from '../components/styles'

interface GeneralPaneProps {
  activeSubTab: string
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function GeneralPane({ activeSubTab, draft, onChange }: GeneralPaneProps): React.ReactNode {
  if (activeSubTab !== 'appearance') {
    return <PlaceholderPane label="Language settings coming soon." />
  }

  const sidebarVisibility = draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: '#8e8e93' }}
          >
            Window layout
          </div>

          <div
            className="mt-3 flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
            style={{
              background: 'rgba(255,255,255,0.78)',
              border: '1px solid rgba(0,0,0,0.06)'
            }}
          >
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold" style={{ color: '#2D2D2B' }}>
                Show sidebar on launch
              </div>
              <div className="text-sm leading-5" style={{ color: '#6b6a66' }}>
                Off starts focused on the conversation.
              </div>
            </div>

            <div className="shrink-0">
              <SettingSwitch
                checked={sidebarVisibility === 'expanded'}
                onChange={() =>
                  onChange({
                    ...draft,
                    general: {
                      ...draft.general,
                      sidebarVisibility: sidebarVisibility === 'expanded' ? 'collapsed' : 'expanded'
                    }
                  })
                }
                ariaLabel="Toggle sidebar visibility on launch"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
