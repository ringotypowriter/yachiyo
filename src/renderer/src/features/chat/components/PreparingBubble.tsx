import type React from 'react'

export function PreparingBubble(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-6 py-1">
      <div className="max-w-[72%]">
        <div
          className="flex items-center gap-2 py-2"
          style={{ color: '#8e8e93', fontSize: '13px' }}
        >
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: '#c0bdb8',
                  display: 'inline-block',
                  animation: 'yachiyo-preparing-pulse 1.2s ease-in-out infinite',
                  animationDelay: `${i * 0.2}s`
                }}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}
