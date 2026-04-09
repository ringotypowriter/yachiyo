import { FolderOpen, Search } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { theme, alpha } from '@renderer/theme/theme'
import type { SettingsConfig, SkillCatalogEntry } from '../../../shared/yachiyo/protocol.ts'
import { normalizeSkillNames } from '../../../shared/yachiyo/protocol.ts'
import { SettingRow, SettingSection, SettingSwitch } from '../components/primitives'
import { filterSkills } from './skillsPaneModel'

interface SkillsPaneProps {
  availableSkills: SkillCatalogEntry[]
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

function isSkillEnabled(
  skill: SkillCatalogEntry,
  enabledNames: string[],
  disabledNames: string[]
): boolean {
  if (skill.autoEnabled) {
    return !disabledNames.includes(skill.name)
  }
  return enabledNames.includes(skill.name)
}

export function SkillsPane({ availableSkills, draft, onChange }: SkillsPaneProps): React.ReactNode {
  const enabledSkillNames = normalizeSkillNames(draft.skills?.enabled)
  const disabledSkillNames = normalizeSkillNames(draft.skills?.disabled)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const filteredSkills = useMemo(
    () => filterSkills(availableSkills, deferredQuery),
    [availableSkills, deferredQuery]
  )

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        {availableSkills.length > 0 ? (
          <div
            className="flex items-center gap-2 px-7 py-3"
            style={{ borderTop: `1px solid ${theme.border.subtle}` }}
          >
            <label
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2"
              style={{ background: alpha('ink', 0.04) }}
            >
              <Search size={14} strokeWidth={1.75} color={theme.icon.placeholder} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: theme.text.primary }}
              />
            </label>
            <button
              onClick={() => window.api.yachiyo.openSkillsFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
              style={{ color: theme.text.secondary }}
              title="Open skills folder"
            >
              <FolderOpen size={12} strokeWidth={1.75} />
              Open Folder
            </button>
          </div>
        ) : null}

        {availableSkills.length === 0 ? (
          <div
            className="px-7 pb-4 text-sm leading-5"
            style={{
              color: theme.text.tertiary,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            No Skills are currently discoverable from saved workspaces or global sources.
          </div>
        ) : filteredSkills.length === 0 ? (
          <div
            className="px-7 pb-4 text-sm leading-5"
            style={{
              color: theme.text.tertiary,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            No skills match &ldquo;{query.trim()}&rdquo;.
          </div>
        ) : (
          filteredSkills.map((skill) => {
            const enabled = isSkillEnabled(skill, enabledSkillNames, disabledSkillNames)
            return (
              <SettingRow key={skill.name}>
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                    {skill.name}
                  </div>
                  <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                    {skill.description ?? 'Available to activate for runs that can see this skill.'}
                  </div>
                </div>
                <div className="shrink-0">
                  <SettingSwitch
                    checked={enabled}
                    onChange={() => {
                      const nextSkills = { ...draft.skills }
                      if (skill.autoEnabled) {
                        nextSkills.disabled = enabled
                          ? [...disabledSkillNames, skill.name]
                          : disabledSkillNames.filter((n) => n !== skill.name)
                      } else {
                        nextSkills.enabled = enabled
                          ? enabledSkillNames.filter((n) => n !== skill.name)
                          : [...enabledSkillNames, skill.name]
                      }
                      onChange({ ...draft, skills: nextSkills })
                    }}
                    ariaLabel={`Toggle ${skill.name} skill`}
                  />
                </div>
              </SettingRow>
            )
          })
        )}
      </SettingSection>
    </div>
  )
}
