import { useState } from 'react'
import { Settings2, Cpu, MessageSquare, Brain, Monitor, Info } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type TabId = 'general' | 'providers' | 'chat' | 'memory' | 'ui' | 'about'

interface Tab {
  id: TabId
  label: string
  icon: LucideIcon
}

const TABS: Tab[] = [
  { id: 'general',   label: 'General',       icon: Settings2     },
  { id: 'providers', label: 'Providers',      icon: Cpu           },
  { id: 'chat',      label: 'Chat',           icon: MessageSquare },
  { id: 'memory',    label: 'Memory',         icon: Brain         },
  { id: 'ui',        label: 'User Interface', icon: Monitor       },
  { id: 'about',     label: 'About',          icon: Info          },
]

function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  const active = TABS.find((t) => t.id === activeTab)!
  const ActiveIcon = active.icon

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────── */}
      <div
        className="flex flex-col shrink-0"
        style={{ width: '210px', background: '#e8e6e1', borderRight: '1px solid rgba(0,0,0,0.08)' }}
      >
        {/* Traffic-lights zone + title */}
        <div
          className="drag-region shrink-0 flex items-end pb-2"
          style={{ height: '52px', paddingLeft: '16px' }}
        >
          <span className="font-bold text-lg" style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}>
            Settings
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-1 overflow-y-auto no-drag">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm text-left mb-0.5 transition-all"
              style={
                activeTab === id
                  ? {
                      background: 'rgba(255,255,255,0.75)',
                      color: '#1c1c1e',
                      fontWeight: 500,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                    }
                  : { color: '#3a3a3c' }
              }
            >
              <Icon
                size={16}
                strokeWidth={1.5}
                style={{ opacity: activeTab === id ? 1 : 0.65, flexShrink: 0 }}
              />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Content area ────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0" style={{ background: '#f5f4f0' }}>
        {/* Header */}
        <div
          className="shrink-0 flex items-center gap-2.5 drag-region"
          style={{ height: '52px', padding: '0 28px', borderBottom: '1px solid rgba(0,0,0,0.07)' }}
        >
          <ActiveIcon size={20} strokeWidth={1.5} style={{ color: '#1c1c1e', opacity: 0.75 }} />
          <span
            className="font-semibold text-xl"
            style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}
          >
            {active.label}
          </span>
        </div>

        {/* Body — empty placeholder */}
        <div className="flex-1 overflow-y-auto flex items-center justify-center">
          <div className="flex flex-col items-center gap-2.5" style={{ opacity: 0.4 }}>
            <div
              className="flex items-center justify-center rounded-full"
              style={{ width: 40, height: 40, border: '2px dashed #8e8e93' }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="#8e8e93"
                strokeWidth="1.5"
              >
                <path d="M8 4v8M4 8h8" />
              </svg>
            </div>
            <span className="text-sm" style={{ color: '#8e8e93' }}>
              Content coming soon
            </span>
          </div>
        </div>

        {/* Footer */}
        <div
          className="shrink-0 no-drag flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}
        >
          <span className="text-xs" style={{ color: '#8e8e93' }}>
            All changes saved
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.close()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(0,0,0,0.15)',
                color: '#1c1c1e',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
            <button
              disabled
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background: '#8e8e93',
                color: '#fff',
                opacity: 0.4,
                border: '1px solid transparent',
                cursor: 'not-allowed',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsApp
