import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Area,
  ComposedChart,
  Bar,
  Line,
  BarChart as RechartsBarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts'
import { theme, alpha } from '@renderer/theme/theme'
import { SimpleSelect } from '../components/primitives'
import type {
  PerfStatsResponse,
  RunPerfRecord,
  UsageStatsPeriod,
  UsageStatsResponse
} from '../../../shared/yachiyo/protocol.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function cacheHitRate(read: number, cacheAwarePrompt: number): string {
  if (cacheAwarePrompt === 0) return 'N/A'
  return `${Math.round((read / cacheAwarePrompt) * 100)}%`
}

function computeBucketCacheRate(cacheRead: number, cacheAwarePrompt: number): number | null {
  if (cacheAwarePrompt === 0) return null
  return (cacheRead / cacheAwarePrompt) * 100
}

type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all'

function rangeToDate(range: RangeKey): string | undefined {
  if (range === 'all') return undefined
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[range]
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

const PERIOD_OPTIONS: { value: UsageStatsPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' }
]

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All time' }
]

// ---------------------------------------------------------------------------
// Chart theme
// ---------------------------------------------------------------------------

const CHART_COLORS = {
  prompt: alpha('accent', 1),
  promptFill: alpha('accent', 0.55),
  completion: alpha('warning', 1),
  completionFill: alpha('warning', 0.45),
  cacheRead: alpha('success', 1),
  cacheReadFill: alpha('success', 0.55),
  cacheWrite: alpha('ink', 0.3),
  cacheWriteFill: alpha('ink', 0.12),
  cacheRate: alpha('accentStrong', 1),
  grid: alpha('ink', 0.1),
  workspace: alpha('accentStrong', 0.75),
  workspaceFill: alpha('accentStrong', 0.55)
}

const tooltipStyle = {
  backgroundColor: theme.background.canvas,
  border: `1px solid ${alpha('ink', 0.1)}`,
  borderRadius: 8,
  fontSize: 12,
  padding: '8px 12px'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsagePane({ activeSubTab }: { activeSubTab: string }): React.ReactNode {
  if (activeSubTab === 'performance') {
    return <PerformanceContent />
  }
  return <UsageContent />
}

// ---------------------------------------------------------------------------
// Usage Content (original)
// ---------------------------------------------------------------------------

function UsageContent(): React.ReactNode {
  const [period, setPeriod] = useState<UsageStatsPeriod>('day')
  const [range, setRange] = useState<RangeKey>('30d')
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('all')
  const [modelFilter, setModelFilter] = useState<string>('all')
  const [data, setData] = useState<UsageStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      // Model filter encodes "modelId|providerName" to disambiguate same model across providers
      const modelParts = modelFilter !== 'all' ? modelFilter.split('|') : undefined
      const result = await window.api.yachiyo.getUsageStats({
        period,
        from: rangeToDate(range),
        ...(workspaceFilter !== 'all' ? { workspacePath: workspaceFilter } : {}),
        ...(modelParts ? { modelId: modelParts[0], providerName: modelParts[1] } : {})
      })
      setData(result)
    } catch (err) {
      console.error('[usage] failed to fetch stats', err)
    } finally {
      setLoading(false)
    }
  }, [period, range, workspaceFilter, modelFilter])

  useEffect(() => {
    void fetchStats()
  }, [fetchStats])

  // Build filter options from data
  const workspaceOptions = [
    { value: 'all' as const, label: 'All workspaces' },
    ...(data?.byWorkspace ?? []).map((w) => ({
      value: w.workspacePath,
      label: w.workspacePath === '__null__' ? 'No workspace' : w.workspacePath.split('/').pop()!
    }))
  ]

  const modelOptions = [
    { value: 'all' as const, label: 'All models' },
    ...(data?.byModel ?? []).map((m) => ({
      value: `${m.modelId}|${m.providerName}`,
      label: `${m.modelId} (${m.providerName})`
    }))
  ]

  // Prepare chart data
  const areaData = (data?.buckets ?? []).map((b) => ({
    name: b.periodStart,
    prompt: b.totalPromptTokens,
    completion: b.totalCompletionTokens
  }))

  const cacheData = (data?.buckets ?? []).map((b) => ({
    name: b.periodStart,
    cacheRead: b.totalCacheReadTokens,
    uncached: Math.max(0, b.cacheAwarePromptTokens - b.totalCacheReadTokens),
    cacheRate: computeBucketCacheRate(b.totalCacheReadTokens, b.cacheAwarePromptTokens)
  }))

  const workspaceBarData = (data?.byWorkspace ?? []).slice(0, 10).map((w) => ({
    name:
      w.workspacePath === '__null__'
        ? 'No workspace'
        : (w.workspacePath.split('/').pop() ?? w.workspacePath),
    fullPath: w.workspacePath,
    tokens: w.totalPromptTokens + w.totalCompletionTokens,
    runs: w.runCount
  }))

  const topModel = data?.byModel?.[0]

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <SimpleSelect value={period} options={PERIOD_OPTIONS} onChange={setPeriod} width={120} />
        <SimpleSelect value={range} options={RANGE_OPTIONS} onChange={setRange} width={150} />
        <SimpleSelect
          value={workspaceFilter}
          options={workspaceOptions}
          onChange={setWorkspaceFilter}
          width={180}
        />
        <SimpleSelect
          value={modelFilter}
          options={modelOptions}
          onChange={setModelFilter}
          width={180}
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total Runs" value={data ? String(data.totals.runCount) : '—'} />
        <SummaryCard
          label="Total Tokens"
          value={data ? formatTokens(data.totals.promptTokens + data.totals.completionTokens) : '—'}
          sub={
            data
              ? `${formatTokens(data.totals.promptTokens)} in / ${formatTokens(data.totals.completionTokens)} out`
              : undefined
          }
        />
        <SummaryCard
          label="Cache Hit Rate"
          value={
            data
              ? cacheHitRate(data.totals.cacheReadTokens, data.totals.cacheAwarePromptTokens)
              : '—'
          }
          sub={data ? `${formatTokens(data.totals.cacheReadTokens)} read` : undefined}
        />
        <SummaryCard
          label="Top Model"
          value={topModel?.modelId ?? '—'}
          sub={topModel ? `${topModel.runCount} runs` : undefined}
        />
      </div>

      {loading && !data ? (
        <div
          className="flex items-center justify-center py-16 text-sm"
          style={{ color: theme.text.tertiary }}
        >
          Loading usage data...
        </div>
      ) : data && data.totals.runCount === 0 ? (
        <div
          className="flex items-center justify-center py-16 text-sm"
          style={{ color: theme.text.tertiary }}
        >
          No usage data for the selected filters.
        </div>
      ) : (
        <>
          {/* Token usage area chart — dual Y-axes for prompt vs completion */}
          <ChartSection title="Token Usage">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={areaData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="prompt"
                  tickFormatter={formatTokens}
                  tick={{ fontSize: 11, fill: CHART_COLORS.prompt }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <YAxis
                  yAxisId="completion"
                  orientation="right"
                  tickFormatter={formatTokens}
                  tick={{ fontSize: 11, fill: CHART_COLORS.completion }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ fill: alpha('ink', 0.04), stroke: 'none' }}
                  formatter={(value, name) => [
                    formatTokens(Number(value)),
                    name === 'prompt' ? 'Prompt' : 'Completion'
                  ]}
                />
                <Legend
                  formatter={(value: string) => (value === 'prompt' ? 'Prompt' : 'Completion')}
                />
                <Area
                  yAxisId="prompt"
                  type="monotone"
                  dataKey="prompt"
                  stroke={CHART_COLORS.prompt}
                  fill={CHART_COLORS.promptFill}
                />
                <Area
                  yAxisId="completion"
                  type="monotone"
                  dataKey="completion"
                  stroke={CHART_COLORS.completion}
                  fill={CHART_COLORS.completionFill}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Cache performance */}
          <ChartSection title="Cache Performance">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={cacheData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="tokens"
                  tickFormatter={formatTokens}
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                  width={45}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ stroke: alpha('ink', 0.08), strokeWidth: 1 }}
                  formatter={(value, name) => {
                    if (value == null) return ['N/A', String(name)]
                    const n = Number(value)
                    if (name === 'cacheRate') return [`${n.toFixed(1)}%`, 'Hit Rate']
                    if (name === 'cacheRead') return [formatTokens(n), 'Cached']
                    return [formatTokens(n), 'Uncached']
                  }}
                />
                <Legend
                  formatter={(value: string) => {
                    if (value === 'cacheRead') return 'Cached'
                    if (value === 'uncached') return 'Uncached'
                    return 'Hit Rate'
                  }}
                />
                <Bar
                  yAxisId="tokens"
                  dataKey="cacheRead"
                  stackId="prompt"
                  fill={CHART_COLORS.cacheReadFill}
                  stroke={CHART_COLORS.cacheRead}
                />
                <Bar
                  yAxisId="tokens"
                  dataKey="uncached"
                  stackId="prompt"
                  fill={CHART_COLORS.cacheWriteFill}
                  stroke={CHART_COLORS.cacheWrite}
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="cacheRate"
                  stroke={CHART_COLORS.cacheRate}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Workspace breakdown */}
          {workspaceBarData.length > 0 && (
            <ChartSection title="By Workspace">
              <ResponsiveContainer
                width="100%"
                height={Math.max(160, workspaceBarData.length * 36)}
              >
                <RechartsBarChart data={workspaceBarData} layout="vertical" barSize={18}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.grid}
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tickFormatter={formatTokens}
                    tick={{ fontSize: 11, fill: theme.text.tertiary }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: theme.text.secondary }}
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ fill: alpha('ink', 0.04) }}
                    formatter={(value) => [formatTokens(Number(value)), 'Tokens']}
                  />
                  <Bar
                    dataKey="tokens"
                    fill={CHART_COLORS.workspaceFill}
                    stroke={CHART_COLORS.workspace}
                    radius={[0, 4, 4, 0]}
                    cursor="pointer"
                    activeBar={false}
                    onClick={(entry) => {
                      const fullPath = (entry as { fullPath?: string }).fullPath
                      if (fullPath) {
                        setWorkspaceFilter(workspaceFilter === fullPath ? 'all' : fullPath)
                      }
                    }}
                  />
                </RechartsBarChart>
              </ResponsiveContainer>
            </ChartSection>
          )}

          {/* Model breakdown table */}
          {(data?.byModel ?? []).length > 0 && (
            <ChartSection title="By Model">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr
                      style={{
                        borderBottom: `1px solid ${alpha('ink', 0.08)}`,
                        color: theme.text.tertiary
                      }}
                    >
                      <th className="text-left py-2 pr-4 font-medium">Model</th>
                      <th className="text-left py-2 pr-4 font-medium">Provider</th>
                      <th className="text-right py-2 pr-4 font-medium">Runs</th>
                      <th className="text-right py-2 pr-4 font-medium">Prompt</th>
                      <th className="text-right py-2 pr-4 font-medium">Completion</th>
                      <th className="text-right py-2 font-medium">Cache Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.byModel ?? []).map((m) => (
                      <tr
                        key={`${m.modelId}-${m.providerName}`}
                        style={{
                          borderBottom: `1px solid ${alpha('ink', 0.04)}`,
                          color: theme.text.primary
                        }}
                      >
                        <td className="py-2 pr-4">{m.modelId}</td>
                        <td className="py-2 pr-4" style={{ color: theme.text.secondary }}>
                          {m.providerName}
                        </td>
                        <td className="text-right py-2 pr-4">{m.runCount}</td>
                        <td className="text-right py-2 pr-4">
                          {formatTokens(m.totalPromptTokens)}
                        </td>
                        <td className="text-right py-2 pr-4">
                          {formatTokens(m.totalCompletionTokens)}
                        </td>
                        <td className="text-right py-2">
                          {cacheHitRate(m.totalCacheReadTokens, m.cacheAwarePromptTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartSection>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Performance Content
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(2)}ms`
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms.toFixed(0)}ms`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function eventLoopHealthColor(p99Ms: number): string {
  if (p99Ms < 16) return theme.text.success
  if (p99Ms < 50) return theme.text.warning
  return theme.text.danger
}

function PerformanceContent(): React.ReactNode {
  const [data, setData] = useState<PerfStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const result = await window.api.yachiyo.getPerfStats()
      setData(result)
    } catch (err) {
      console.error('[perf] failed to fetch stats', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStats()
    intervalRef.current = setInterval(() => void fetchStats(), 3000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchStats])

  if (loading && !data) {
    return (
      <div
        className="flex items-center justify-center py-16 text-sm h-full"
        style={{ color: theme.text.tertiary }}
      >
        Loading performance data...
      </div>
    )
  }

  if (!data) return null

  const el = data.eventLoop
  const ipcRate = data.ipcEventsLast60s

  // Top IPC event types, sorted by count
  const ipcTypeEntries = Object.entries(data.ipcEventsByType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full">
      {/* Header with uptime */}
      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: theme.text.muted }}>
          Uptime: {formatUptime(data.uptimeSeconds)} — Auto-refreshing every 3s
        </div>
      </div>

      {/* Event Loop Delay */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard
          label="Event Loop p99"
          value={formatMs(el.p99)}
          sub={el.p99 < 16 ? 'Healthy' : el.p99 < 50 ? 'Moderate' : 'Stalled'}
          valueColor={eventLoopHealthColor(el.p99)}
        />
        <SummaryCard label="Event Loop p95" value={formatMs(el.p95)} />
        <SummaryCard label="Event Loop Mean" value={formatMs(el.mean)} />
        <SummaryCard
          label="Event Loop Max"
          value={formatMs(el.max)}
          sub={el.max > 100 ? 'Spike detected' : undefined}
          valueColor={el.max > 100 ? theme.text.warning : undefined}
        />
      </div>

      {/* IPC Stats */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard
          label="IPC Events (60s)"
          value={String(ipcRate)}
          sub={`${(ipcRate / 60).toFixed(1)}/sec avg`}
        />
        <SummaryCard label="Total IPC Events" value={formatTokens(data.ipcEventCount)} />
        <SummaryCard label="Active Runs" value={String(data.activeRunCount)} />
      </div>

      {/* IPC Breakdown */}
      {ipcTypeEntries.length > 0 && (
        <ChartSection title="IPC Events by Type (last 60s)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: `1px solid ${alpha('ink', 0.08)}`,
                    color: theme.text.tertiary
                  }}
                >
                  <th className="text-left py-2 pr-4 font-medium">Event Type</th>
                  <th className="text-right py-2 pr-4 font-medium">Count</th>
                  <th className="text-right py-2 font-medium">Rate (/sec)</th>
                </tr>
              </thead>
              <tbody>
                {ipcTypeEntries.map(([type, count]) => (
                  <tr
                    key={type}
                    style={{
                      borderBottom: `1px solid ${alpha('ink', 0.04)}`,
                      color: theme.text.primary
                    }}
                  >
                    <td className="py-1.5 pr-4 font-mono text-xs">{type}</td>
                    <td className="text-right py-1.5 pr-4">{count}</td>
                    <td className="text-right py-1.5" style={{ color: theme.text.secondary }}>
                      {(count / 60).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartSection>
      )}

      {/* Recent Runs */}
      {data.recentRuns.length > 0 && (
        <ChartSection title="Recent Runs">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: `1px solid ${alpha('ink', 0.08)}`,
                    color: theme.text.tertiary
                  }}
                >
                  <th className="text-left py-2 pr-3 font-medium">Duration</th>
                  <th className="text-right py-2 pr-3 font-medium">Deltas</th>
                  <th className="text-right py-2 pr-3 font-medium">Chars</th>
                  <th className="text-right py-2 pr-3 font-medium">CP Writes</th>
                  <th className="text-right py-2 pr-3 font-medium">CP Total</th>
                  <th className="text-right py-2 pr-3 font-medium">CP Max</th>
                  <th className="text-right py-2 pr-3 font-medium">Tool Writes</th>
                  <th className="text-right py-2 font-medium">Tool Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRuns.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        </ChartSection>
      )}

      {data.recentRuns.length === 0 && (
        <div
          className="flex items-center justify-center py-12 text-sm"
          style={{ color: theme.text.tertiary }}
        >
          No run data yet. Performance records appear after completing a conversation turn.
        </div>
      )}
    </div>
  )
}

function RunRow({ run }: { run: RunPerfRecord }): React.ReactNode {
  const cpAvg =
    run.checkpointWriteCount > 0 ? run.checkpointWriteTotalMs / run.checkpointWriteCount : 0
  const toolAvg = run.toolCallWriteCount > 0 ? run.toolCallWriteTotalMs / run.toolCallWriteCount : 0

  return (
    <tr
      style={{
        borderBottom: `1px solid ${alpha('ink', 0.04)}`,
        color: theme.text.primary
      }}
    >
      <td className="py-1.5 pr-3">{formatDuration(run.durationMs)}</td>
      <td className="text-right py-1.5 pr-3">
        {run.deltaEventCount}
        {run.reasoningDeltaEventCount > 0 && (
          <span style={{ color: theme.text.muted }}> +{run.reasoningDeltaEventCount}r</span>
        )}
      </td>
      <td className="text-right py-1.5 pr-3">{formatTokens(run.textCharsStreamed)}</td>
      <td className="text-right py-1.5 pr-3">{run.checkpointWriteCount}</td>
      <td className="text-right py-1.5 pr-3">
        <span>{formatMs(run.checkpointWriteTotalMs)}</span>
        {run.checkpointWriteCount > 0 && (
          <span style={{ color: theme.text.muted }}> ({formatMs(cpAvg)} avg)</span>
        )}
      </td>
      <td className="text-right py-1.5 pr-3">
        <span
          style={{
            color: run.checkpointWriteMaxMs > 20 ? theme.text.warning : undefined
          }}
        >
          {formatMs(run.checkpointWriteMaxMs)}
        </span>
      </td>
      <td className="text-right py-1.5 pr-3">{run.toolCallWriteCount}</td>
      <td className="text-right py-1.5">
        <span>{formatMs(run.toolCallWriteTotalMs)}</span>
        {run.toolCallWriteCount > 0 && (
          <span style={{ color: theme.text.muted }}> ({formatMs(toolAvg)} avg)</span>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  valueColor
}: {
  label: string
  value: string
  sub?: string
  valueColor?: string
}): React.ReactNode {
  return (
    <div
      className="rounded-lg p-4"
      style={{
        backgroundColor: alpha('surface', 0.6),
        border: `1px solid ${alpha('ink', 0.06)}`
      }}
    >
      <div className="text-xs mb-1" style={{ color: theme.text.tertiary }}>
        {label}
      </div>
      <div
        className="text-lg font-semibold truncate"
        style={{ color: valueColor ?? theme.text.primary }}
        title={value}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs mt-0.5" style={{ color: theme.text.muted }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function ChartSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div>
      <div className="text-sm font-medium mb-3" style={{ color: theme.text.secondary }}>
        {title}
      </div>
      {children}
    </div>
  )
}
