import { theme } from '@renderer/theme/theme'
import type { SettingsConfig, SkillCatalogEntry } from '../../../shared/yachiyo/protocol.ts'
import { normalizeSkillNames } from '../../../shared/yachiyo/protocol.ts'
import { SettingSwitch } from '../components/primitives'
import { settingsPanelStyle } from '../components/styles'

interface SkillsPaneProps {
  availableSkills: SkillCatalogEntry[]
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function SkillsPane({ availableSkills, draft, onChange }: SkillsPaneProps): React.ReactNode {
  const enabledSkillNames = normalizeSkillNames(draft.skills?.enabled)

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl space-y-4">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Default Skills
          </div>

          <div className="mt-3 space-y-3">
            {availableSkills.length === 0 ? (
              <div
                className="rounded-2xl px-4 py-3 text-sm leading-5"
                style={{
                  background: theme.background.surfaceLight,
                  border: `1px solid ${theme.border.default}`,
                  color: theme.text.tertiary
                }}
              >
                No Skills are currently discoverable from saved workspaces or global sources.
              </div>
            ) : (
              availableSkills.map((skill) => {
                const enabled = enabledSkillNames.includes(skill.name)

                return (
                  <div
                    key={skill.name}
                    className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
                    style={{
                      background: theme.background.surfaceLight,
                      border: `1px solid ${theme.border.default}`
                    }}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                        {skill.name}
                      </div>
                      <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                        {skill.description ??
                          'Available to activate for runs that can see this skill.'}
                      </div>
                    </div>

                    <div className="shrink-0">
                      <SettingSwitch
                        checked={enabled}
                        onChange={() =>
                          onChange({
                            ...draft,
                            skills: {
                              enabled: enabled
                                ? enabledSkillNames.filter((name) => name !== skill.name)
                                : [...enabledSkillNames, skill.name]
                            }
                          })
                        }
                        ariaLabel={`Toggle ${skill.name} skill`}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
