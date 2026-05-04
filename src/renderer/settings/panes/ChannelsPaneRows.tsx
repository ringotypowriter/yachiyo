import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import { SimpleSelect } from '../components/primitives'
import type {
  ChannelGroupRecord,
  ChannelGroupStatus,
  ChannelUserRecord,
  ChannelUserRole,
  ChannelUserStatus,
  ProviderConfig
} from '../../../shared/yachiyo/protocol.ts'

// ─── memory filter keywords ──────────────────────────────────────────────────

export function MemoryFilterKeywords({
  keywords,
  onChange
}: {
  keywords: string[]
  onChange: (keywords: string[]) => void
}): React.ReactNode {
  const [draft, setDraft] = useState('')

  function addKeyword(): void {
    const trimmed = draft.trim()
    if (!trimmed || keywords.includes(trimmed)) return
    onChange([...keywords, trimmed])
    setDraft('')
  }

  return (
    <div className="px-7 pb-2" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2 py-2.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={imeSafeEnter(() => addKeyword())}
          placeholder="Add keyword..."
          className="flex-1 text-sm min-w-0"
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: 'none',
            background: alpha('ink', 0.04),
            color: theme.text.primary,
            outline: 'none'
          }}
        />
        <button
          type="button"
          onClick={addKeyword}
          className="text-xs font-medium px-2.5 py-1 rounded-md transition-opacity opacity-60 hover:opacity-100"
          style={{
            color: theme.text.accent,
            background: `${theme.text.accent}14`,
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Add
        </button>
      </div>

      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md"
              style={{ background: alpha('ink', 0.06), color: theme.text.secondary }}
            >
              {kw}
              <button
                type="button"
                onClick={() => onChange(keywords.filter((k) => k !== kw))}
                className="opacity-50 hover:opacity-100 transition-opacity"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: 0,
                  lineHeight: 1
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── shared model selector ───────────────────────────────────────────────────

export function ModelSelect({
  value,
  providers,
  onChange
}: {
  value: string
  providers: ProviderConfig[]
  onChange: (value: string) => void
}): React.ReactNode {
  const options: { value: string; label: string }[] = [
    { value: '', label: 'Default (same as chat)' },
    ...providers.flatMap((p) =>
      p.modelList.enabled.map((m) => ({
        value: `${p.name}::${m}`,
        label: `${p.name}: ${m}`
      }))
    )
  ]

  return <SimpleSelect value={value} options={options} onChange={onChange} width="100%" />
}

// ─── status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ChannelUserStatus, string> = {
  allowed: '#34c759',
  pending: '#ff9500',
  blocked: '#ff3b30'
}

const GROUP_STATUS_COLORS: Record<ChannelGroupStatus, string> = {
  approved: '#34c759',
  pending: '#ff9500',
  blocked: '#ff3b30'
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  qq: 'QQ',
  discord: 'Discord'
}

// ─── user row ────────────────────────────────────────────────────────────────

export function ChannelUserRow({
  user,
  busy,
  onStatusChange,
  onRoleChange,
  onLimitChange,
  onLabelChange
}: {
  user: ChannelUserRecord
  busy: boolean
  onStatusChange: (status: ChannelUserStatus) => void
  onRoleChange: (role: ChannelUserRole) => void
  onLimitChange: (value: string) => void
  onLabelChange: (label: string) => void
}): React.ReactNode {
  const [limitDraft, setLimitDraft] = useState(
    user.usageLimitKTokens !== null ? String(user.usageLimitKTokens) : ''
  )
  const [labelDraft, setLabelDraft] = useState(user.label)

  const commitLabel = (): void => {
    const trimmed = labelDraft.trim()
    if (trimmed !== user.label) onLabelChange(trimmed)
  }

  return (
    <div
      className="flex items-center gap-4 px-7 py-3 transition-opacity"
      style={{ borderTop: `1px solid ${theme.border.subtle}`, opacity: busy ? 0.5 : 1 }}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLORS[user.status],
            flexShrink: 0
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: theme.text.primary }}>
            @{user.username}
          </div>
          <input
            type="text"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={imeSafeEnter(commitLabel)}
            placeholder="Label..."
            className="text-xs bg-transparent outline-none w-full"
            style={{ color: theme.text.secondary }}
          />
          <div className="text-xs" style={{ color: theme.text.tertiary }}>
            {user.usedKTokens}k used
            {user.usageLimitKTokens !== null ? ` / ${user.usageLimitKTokens}k limit` : ''}
          </div>
        </div>
      </div>

      <SimpleSelect
        value={user.role}
        options={[
          { value: 'guest', label: 'Guest' },
          { value: 'owner', label: 'Owner' }
        ]}
        onChange={(v) => onRoleChange(v as ChannelUserRole)}
        width={110}
      />

      <div className="flex items-center gap-1 shrink-0">
        <input
          type="text"
          inputMode="numeric"
          placeholder="∞"
          value={limitDraft}
          onChange={(e) => setLimitDraft(e.target.value)}
          onBlur={() => onLimitChange(limitDraft)}
          onKeyDown={imeSafeEnter(() => onLimitChange(limitDraft))}
          className="text-sm text-right"
          style={{
            width: 52,
            padding: '4px 6px',
            borderRadius: 6,
            border: 'none',
            background: alpha('ink', 0.04),
            color: theme.text.primary,
            outline: 'none'
          }}
        />
        <span className="text-xs" style={{ color: theme.text.tertiary }}>
          kT
        </span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {user.status !== 'allowed' && (
          <ActionButton label="Approve" color="#34c759" onClick={() => onStatusChange('allowed')} />
        )}
        {user.status === 'allowed' && (
          <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
        )}
        {user.status === 'blocked' && (
          <ActionButton label="Unblock" color="#ff9500" onClick={() => onStatusChange('pending')} />
        )}
      </div>
    </div>
  )
}

export function ChannelGroupRow({
  group,
  busy,
  clearError,
  onStatusChange,
  onLabelChange,
  onClearMessages
}: {
  group: ChannelGroupRecord
  busy: boolean
  clearError: string | null
  onStatusChange: (status: ChannelGroupStatus) => void
  onLabelChange: (label: string) => void
  onClearMessages: () => void
}): React.ReactNode {
  const [labelDraft, setLabelDraft] = useState(group.label)

  const commitLabel = (): void => {
    const trimmed = labelDraft.trim()
    if (trimmed !== group.label) onLabelChange(trimmed)
  }

  return (
    <div
      className="flex items-center gap-4 px-7 py-3 transition-opacity"
      style={{ borderTop: `1px solid ${theme.border.subtle}`, opacity: busy ? 0.5 : 1 }}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: GROUP_STATUS_COLORS[group.status],
            flexShrink: 0
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: theme.text.primary }}>
            {group.name}
          </div>
          <input
            type="text"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={imeSafeEnter(commitLabel)}
            placeholder="Label..."
            className="text-xs bg-transparent outline-none w-full"
            style={{ color: theme.text.secondary }}
          />
          {clearError ? (
            <div className="text-xs truncate" style={{ color: '#c25151' }}>
              {clearError}
            </div>
          ) : null}
        </div>
      </div>

      <span
        className="text-xs px-2 py-0.5 rounded shrink-0"
        style={{ background: alpha('ink', 0.06), color: theme.text.tertiary }}
      >
        {PLATFORM_LABELS[group.platform] ?? group.platform}
      </span>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          disabled={busy}
          onClick={onClearMessages}
          className="text-xs font-medium px-2.5 py-1 rounded-md transition-opacity inline-flex items-center gap-1.5"
          style={{
            color: theme.text.tertiary,
            background: `${theme.text.tertiary}14`,
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.55 : 0.75
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : null}
          {busy ? 'Clearing...' : 'Clear Messages'}
        </button>
        {group.status === 'pending' && (
          <>
            <ActionButton
              label="Approve"
              color="#34c759"
              onClick={() => onStatusChange('approved')}
            />
            <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
          </>
        )}
        {group.status === 'approved' && (
          <>
            <ActionButton
              label="Disable"
              color="#ff9500"
              onClick={() => onStatusChange('pending')}
            />
            <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
          </>
        )}
        {group.status === 'blocked' && (
          <ActionButton label="Unblock" color="#ff9500" onClick={() => onStatusChange('pending')} />
        )}
      </div>
    </div>
  )
}

function ActionButton({
  label,
  color,
  onClick
}: {
  label: string
  color: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium px-2.5 py-1 rounded-md transition-opacity opacity-75 hover:opacity-100"
      style={{ color, background: `${color}14`, border: 'none', cursor: 'pointer' }}
    >
      {label}
    </button>
  )
}

// ─── styled slider ────────────────────────────────────────────────────────────

export function SettingSlider({
  min,
  max,
  step,
  value,
  onChange,
  'aria-label': ariaLabel
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  'aria-label': string
}): React.ReactNode {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', width: 112, height: 20 }}>
      {/* track */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 99,
          background: alpha('ink', 0.08),
          pointerEvents: 'none'
        }}
      />
      {/* fill */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          width: `${pct}%`,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 99,
          background: theme.text.accent,
          pointerEvents: 'none'
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={ariaLabel}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'pointer',
          margin: 0
        }}
      />
    </div>
  )
}
