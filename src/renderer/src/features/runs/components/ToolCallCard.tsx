import { CheckCircle, Loader, ChevronRight, Clock, XCircle } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'

interface ToolCallCardProps {
  toolCall: ToolCall
}

function StatusBadge({ status }: { status: ToolCall['status'] }) {
  if (status === 'completed') {
    return (
      <span className="flex items-center gap-1 text-xs font-medium" style={{ color: '#2d8a4e' }}>
        <CheckCircle size={12} strokeWidth={1.8} />
        Completed
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs font-medium" style={{ color: '#8e8e93' }}>
        <Loader size={12} strokeWidth={1.8} className="animate-spin" />
        Running
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-xs font-medium" style={{ color: '#d93025' }}>
      <XCircle size={12} strokeWidth={1.8} />
      Failed
    </span>
  )
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm"
      style={{
        background: 'rgba(255,255,255,0.7)',
        border: '1px solid rgba(0,0,0,0.08)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <span className="text-xs font-medium" style={{ color: '#1c1c1e' }}>
        🔧 {toolCall.tool}
      </span>

      <StatusBadge status={toolCall.status} />

      {toolCall.durationSec !== undefined && (
        <span className="flex items-center gap-1 text-xs" style={{ color: '#8e8e93' }}>
          <Clock size={11} strokeWidth={1.5} />
          {toolCall.durationSec} s
        </span>
      )}

      <ChevronRight size={12} strokeWidth={1.5} className="ml-auto opacity-40" color="#1c1c1e" />
    </div>
  )
}
