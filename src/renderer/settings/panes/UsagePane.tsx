import { useCallback, useEffect, useState } from 'react'
import {
  AreaChart,
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
import type { UsageStatsPeriod, UsageStatsResponse } from '../../../shared/yachiyo/protocol.ts'

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
  return `${((read / cacheAwarePrompt) * 100).toFixed(1)}%`
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
  cacheWrite: alpha('warning', 1),
  cacheWriteFill: alpha('warning', 0.45),
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

export function UsagePane(): React.ReactNode {
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
    cacheWrite: b.totalCacheWriteTokens,
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
          {/* Token usage area chart */}
          <ChartSection title="Token Usage">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={areaData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={formatTokens}
                  tick={{ fontSize: 11, fill: theme.text.tertiary }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ stroke: alpha('ink', 0.08), strokeWidth: 1 }}
                  formatter={(value, name) => [
                    formatTokens(Number(value)),
                    name === 'prompt' ? 'Prompt' : 'Completion'
                  ]}
                />
                <Legend
                  formatter={(value: string) => (value === 'prompt' ? 'Prompt' : 'Completion')}
                />
                <Area
                  type="monotone"
                  dataKey="prompt"
                  stroke={CHART_COLORS.prompt}
                  fill={CHART_COLORS.promptFill}
                />
                <Area
                  type="monotone"
                  dataKey="completion"
                  stroke={CHART_COLORS.completion}
                  fill={CHART_COLORS.completionFill}
                />
              </AreaChart>
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
                    return [formatTokens(n), name === 'cacheRead' ? 'Cache Read' : 'Cache Write']
                  }}
                />
                <Legend
                  formatter={(value: string) => {
                    if (value === 'cacheRead') return 'Cache Read'
                    if (value === 'cacheWrite') return 'Cache Write'
                    return 'Hit Rate'
                  }}
                />
                <Bar
                  yAxisId="tokens"
                  dataKey="cacheRead"
                  fill={CHART_COLORS.cacheReadFill}
                  stroke={CHART_COLORS.cacheRead}
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  yAxisId="tokens"
                  dataKey="cacheWrite"
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
                        setWorkspaceFilter(fullPath)
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
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
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
        style={{ color: theme.text.primary }}
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
