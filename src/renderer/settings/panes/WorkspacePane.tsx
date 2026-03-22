import { Folder, Plus, Trash2 } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { settingsPanelStyle } from '../components/styles'

interface WorkspacePaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function WorkspacePane({ draft, onChange }: WorkspacePaneProps): React.ReactNode {
  const savedPaths = draft.workspace?.savedPaths ?? []

  const removePath = (workspacePath: string): void => {
    onChange({
      ...draft,
      workspace: {
        ...draft.workspace,
        savedPaths: savedPaths.filter((entry) => entry !== workspacePath)
      }
    })
  }

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl space-y-4">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Workspaces
          </div>

          <div
            className="mt-3 rounded-2xl overflow-hidden"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            {savedPaths.length === 0 ? (
              <div className="px-4 py-4 text-sm leading-6" style={{ color: theme.text.tertiary }}>
                No saved folders yet. When you pick a specific workspace from Composer, it will show
                up here.
              </div>
            ) : (
              savedPaths.map((workspacePath) => (
                <div
                  key={workspacePath}
                  className="flex items-center gap-3 px-4 py-3"
                  style={{ borderTop: `1px solid ${theme.border.subtle}` }}
                >
                  <div
                    className="shrink-0 rounded-lg flex items-center justify-center"
                    style={{
                      width: 30,
                      height: 30,
                      background: theme.background.surface
                    }}
                  >
                    <Folder size={14} strokeWidth={1.7} color={theme.icon.muted} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                      {workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath}
                    </div>
                    <div
                      className="text-sm truncate"
                      style={{ color: theme.text.tertiary, lineHeight: 1.5 }}
                    >
                      {workspacePath}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => removePath(workspacePath)}
                    className="shrink-0 rounded-lg p-2 transition-opacity opacity-60 hover:opacity-100"
                    aria-label={`Remove ${workspacePath}`}
                  >
                    <Trash2 size={14} strokeWidth={1.7} color={theme.icon.muted} />
                  </button>
                </div>
              ))
            )}

            <div className="px-4 py-3" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const pickedPath = await window.api.yachiyo.pickWorkspaceDirectory()
                    if (!pickedPath) {
                      return
                    }

                    onChange({
                      ...draft,
                      workspace: {
                        ...draft.workspace,
                        savedPaths: [...new Set([...savedPaths, pickedPath])]
                      }
                    })
                  })()
                }}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
                style={{
                  color: theme.text.primary,
                  background: theme.background.surface
                }}
              >
                <Plus size={14} strokeWidth={2} />
                Select directory...
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
