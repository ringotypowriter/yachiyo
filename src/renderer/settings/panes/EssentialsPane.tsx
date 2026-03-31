import { useCallback, useMemo, useRef } from 'react'
import { ArrowDown, ArrowUp, Plus, Smile, Trash2, Upload } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'
import { SettingSwitch, SimpleSelect } from '../components/primitives'
import type {
  EssentialPreset,
  SettingsConfig,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol'

const MAX_ESSENTIALS = 8

// ---------------------------------------------------------------------------
// Icon display
// ---------------------------------------------------------------------------

function EssentialIconPreview({
  essential,
  size = 40
}: {
  essential: Pick<EssentialPreset, 'icon' | 'iconType'>
  size?: number
}): React.JSX.Element {
  if (essential.iconType === 'image' && essential.icon) {
    return (
      <img
        src={essential.icon}
        alt=""
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
        draggable={false}
      />
    )
  }

  return (
    <div
      className="flex items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: alpha('ink', 0.06),
        fontSize: size * 0.5,
        lineHeight: 1
      }}
    >
      {essential.icon || '?'}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image resize helper
// ---------------------------------------------------------------------------

function resizeImageToDataUrl(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read image'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to decode image'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = maxSize
        canvas.height = maxSize

        const ctx = canvas.getContext('2d')!
        const minDim = Math.min(img.width, img.height)
        const sx = (img.width - minDim) / 2
        const sy = (img.height - minDim) / 2

        ctx.beginPath()
        ctx.arc(maxSize / 2, maxSize / 2, maxSize / 2, 0, Math.PI * 2)
        ctx.closePath()
        ctx.clip()

        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, maxSize, maxSize)
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

// ---------------------------------------------------------------------------
// Essential editor row
// ---------------------------------------------------------------------------

interface EssentialEditorProps {
  essential: EssentialPreset
  config: SettingsConfig
  onUpdate: (updated: EssentialPreset) => void
  onDelete: () => void
  onMoveUp: (() => void) | null
  onMoveDown: (() => void) | null
}

function extractFirstEmoji(text: string): string | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const first = [...segmenter.segment(text.trim())][0]?.segment ?? ''
  return /\p{Extended_Pictographic}/u.test(first) ? first : null
}

function EssentialEditor({
  essential,
  config,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown
}: EssentialEditorProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiInputRef = useRef<HTMLInputElement>(null)

  const modelOptions = config.providers.flatMap((p) =>
    p.modelList.enabled.map((m) => ({ value: `${p.name}::${m}`, label: `${p.name}: ${m}` }))
  )

  const workspaceOptions = config.workspace?.savedPaths ?? []

  const handleImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const dataUrl = await resizeImageToDataUrl(file, 512)
        onUpdate({ ...essential, icon: dataUrl, iconType: 'image' })
      } catch {
        // silently ignore failed uploads
      }
      e.target.value = ''
    },
    [essential, onUpdate]
  )

  const handleEmojiClick = useCallback(() => {
    emojiInputRef.current?.focus()
    void window.api.yachiyo.showEmojiPanel()
  }, [])

  const handleEmojiInputEvent = useCallback(
    (e: React.FormEvent<HTMLInputElement>) => {
      const raw = e.currentTarget.value.trim()
      const emoji = extractFirstEmoji(raw)
      if (emoji) {
        onUpdate({ ...essential, icon: emoji, iconType: 'emoji' })
      }
      e.currentTarget.value = ''
    },
    [essential, onUpdate]
  )

  const modelValue = essential.modelOverride
    ? `${essential.modelOverride.providerName}::${essential.modelOverride.model}`
    : ''

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg" style={{ background: alpha('ink', 0.03) }}>
      <div className="flex items-start gap-4">
        {/* Icon preview + pickers */}
        <div className="flex flex-col items-center gap-1.5 shrink-0">
          <div className="relative">
            <EssentialIconPreview essential={essential} />
            <input
              ref={emojiInputRef}
              type="text"
              tabIndex={-1}
              defaultValue=""
              onInput={handleEmojiInputEvent}
              className="absolute inset-0 opacity-0 cursor-pointer"
              style={{ fontSize: 'inherit', width: '100%', height: '100%' }}
            />
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleEmojiClick}
              className="p-1 rounded opacity-50 hover:opacity-80 transition-opacity"
              style={{ color: theme.icon.default }}
              aria-label="Pick emoji"
            >
              <Smile size={14} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1 rounded opacity-50 hover:opacity-80 transition-opacity"
              style={{ color: theme.icon.default }}
              aria-label="Upload image"
            >
              <Upload size={14} strokeWidth={1.5} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
        </div>

        {/* Fields */}
        <div className="flex-1 min-w-0 flex flex-col gap-2.5">
          <div>
            <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
              Label
            </span>
            <input
              type="text"
              placeholder="e.g. Work, Daily, Code..."
              value={essential.label ?? ''}
              onChange={(e) => onUpdate({ ...essential, label: e.target.value || undefined })}
              className="w-full mt-1 rounded-md px-2.5 py-1.5 text-sm outline-none"
              style={inputStyle()}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
                Model
              </span>
              <div className="mt-1">
                <SimpleSelect
                  value={modelValue}
                  options={[{ value: '', label: 'Default' }, ...modelOptions]}
                  onChange={(val) => {
                    if (!val) {
                      onUpdate({ ...essential, modelOverride: undefined })
                    } else {
                      const [providerName, model] = val.split('::')
                      onUpdate({
                        ...essential,
                        modelOverride: { providerName, model } as ThreadModelOverride
                      })
                    }
                  }}
                  width="100%"
                />
              </div>
            </div>

            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
                Workspace
              </span>
              <div className="mt-1">
                <SimpleSelect
                  value={essential.workspacePath ?? ''}
                  options={[
                    { value: '', label: 'Temporary (auto)' },
                    ...workspaceOptions.map((p) => ({
                      value: p,
                      label: p.split('/').pop() ?? p
                    }))
                  ]}
                  onChange={(val) => onUpdate({ ...essential, workspacePath: val || undefined })}
                  width="100%"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium" style={{ color: theme.text.secondary }}>
                Privacy mode
              </div>
            </div>
            <SettingSwitch
              checked={essential.privacyMode === true}
              onChange={() =>
                onUpdate({ ...essential, privacyMode: essential.privacyMode !== true })
              }
              ariaLabel={`Toggle privacy mode for ${essential.label ?? 'this essential'}`}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1 shrink-0">
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity"
              style={{ color: theme.icon.default }}
              aria-label="Move up"
            >
              <ArrowUp size={14} strokeWidth={1.5} />
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity"
              style={{ color: theme.icon.default }}
              aria-label="Move down"
            >
              <ArrowDown size={14} strokeWidth={1.5} />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity"
            style={{ color: theme.text.dangerStrong }}
            aria-label="Delete essential"
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

interface EssentialsPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

let nextTempId = 0
function tempId(): string {
  return `essential-${Date.now()}-${++nextTempId}`
}

export function EssentialsPane({ draft, onChange }: EssentialsPaneProps): React.ReactNode {
  const essentials = useMemo(() => draft.essentials ?? [], [draft.essentials])

  const updateEssential = useCallback(
    (index: number, updated: EssentialPreset) => {
      const next = [...essentials]
      next[index] = updated
      onChange({ ...draft, essentials: next })
    },
    [draft, essentials, onChange]
  )

  const deleteEssential = useCallback(
    (index: number) => {
      const next = essentials.filter((_, i) => i !== index)
      // re-sequence orders
      next.forEach((e, i) => (e.order = i))
      onChange({ ...draft, essentials: next })
    },
    [draft, essentials, onChange]
  )

  const addEssential = useCallback(() => {
    const newEssential: EssentialPreset = {
      id: tempId(),
      icon: '',
      iconType: 'emoji',
      privacyMode: false,
      order: essentials.length
    }
    onChange({ ...draft, essentials: [...essentials, newEssential] })
  }, [draft, essentials, onChange])

  const moveEssential = useCallback(
    (index: number, direction: -1 | 1) => {
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= essentials.length) return
      const next = [...essentials]
      ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
      next.forEach((e, i) => (e.order = i))
      onChange({ ...draft, essentials: next })
    },
    [draft, essentials, onChange]
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div
        className="flex items-center justify-end px-7 py-3"
        style={{ borderTop: `1px solid ${theme.border.subtle}` }}
      >
        <button
          type="button"
          onClick={addEssential}
          disabled={essentials.length >= MAX_ESSENTIALS}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: alpha('accent', 0.1),
            color: theme.text.accent,
            border: 'none',
            cursor: 'pointer'
          }}
        >
          <Plus size={12} strokeWidth={2} />
          Add ({essentials.length}/{MAX_ESSENTIALS})
        </button>
      </div>

      <div className="px-7 pb-5 flex flex-col gap-3">
        {essentials.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-10 rounded-lg"
            style={{ background: alpha('ink', 0.02) }}
          >
            <span className="text-sm" style={{ color: theme.text.muted }}>
              No essentials configured
            </span>
            <span className="text-xs mt-1" style={{ color: theme.text.tertiary }}>
              Add preset chat shortcuts for quick access
            </span>
          </div>
        ) : (
          essentials.map((essential, index) => (
            <EssentialEditor
              key={essential.id}
              essential={essential}
              config={draft}
              onUpdate={(updated) => updateEssential(index, updated)}
              onDelete={() => deleteEssential(index)}
              onMoveUp={index > 0 ? () => moveEssential(index, -1) : null}
              onMoveDown={index < essentials.length - 1 ? () => moveEssential(index, 1) : null}
            />
          ))
        )}
      </div>
    </div>
  )
}
