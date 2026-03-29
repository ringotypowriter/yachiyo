import { useAppStore } from '@renderer/app/store/useAppStore'
import { Tooltip } from '@renderer/components/Tooltip'
import { alpha } from '@renderer/theme/theme'
import type { EssentialPreset } from '../../../../../shared/yachiyo/protocol'

const MAX_PER_ROW = 4
const MAX_ESSENTIALS = 8
const GAP = 6
const ITEM_HEIGHT = 44

function EssentialIcon({ essential }: { essential: EssentialPreset }): React.JSX.Element {
  if (essential.iconType === 'image') {
    return (
      <img
        src={essential.icon}
        alt={essential.label ?? 'Essential'}
        className="rounded-full object-cover"
        style={{ width: 24, height: 24 }}
        draggable={false}
      />
    )
  }

  return <span style={{ fontSize: 18, lineHeight: 1 }}>{essential.icon}</span>
}

export function EssentialsBar(): React.JSX.Element | null {
  const config = useAppStore((s) => s.config)
  const createNewThreadFromEssential = useAppStore((s) => s.createNewThreadFromEssential)

  const essentials = config?.essentials
  if (!essentials?.length) return null

  const sorted = [...essentials].sort((a, b) => a.order - b.order).slice(0, MAX_ESSENTIALS)

  const rows: EssentialPreset[][] = []
  for (let i = 0; i < sorted.length; i += MAX_PER_ROW) {
    rows.push(sorted.slice(i, i + MAX_PER_ROW))
  }

  return (
    <div
      className="shrink-0 px-3 pt-1 pb-2 no-drag"
      style={{ display: 'flex', flexDirection: 'column', gap: GAP }}
    >
      {rows.map((row, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${row.length}, 1fr)`,
            gap: GAP
          }}
        >
          {row.map((essential) => (
            <div key={essential.id}>
              <Tooltip content={essential.label || 'New chat'} placement="bottom">
                <button
                  onClick={() => createNewThreadFromEssential(essential.id)}
                  className="flex items-center justify-center rounded-xl transition-all hover:scale-105 active:scale-95"
                  style={{
                    width: '100%',
                    height: ITEM_HEIGHT,
                    background: alpha('ink', 0.05),
                    border: 'none',
                    cursor: 'pointer'
                  }}
                  aria-label={essential.label || 'New chat from essential'}
                >
                  <EssentialIcon essential={essential} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
