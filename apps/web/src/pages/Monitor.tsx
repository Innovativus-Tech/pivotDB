import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { api, type Connection } from '../lib/api'
import { useConnectionsStore } from '../stores/connections.store'
import { GrafanaPanel } from '../components/monitor/GrafanaPanel'
import { CurrentOpsTable } from '../components/monitor/CurrentOpsTable'
import { useCurrentOps } from '../hooks/useCurrentOps'

export function MonitorPage() {
  const { activeConnectionId } = useConnectionsStore()
  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3003'

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  const conn = connections.find((c) => c.id === activeConnectionId)
  const ops  = useCurrentOps(activeConnectionId)

  if (!activeConnectionId || !conn) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <p className="text-muted-foreground">Select a connection from the Connections page to view monitoring.</p>
      </div>
    )
  }

  const vars = { connection_name: conn.name }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Monitor</h1>
          <p className="text-sm text-muted-foreground mt-1">{conn.name} · {conn.topology}</p>
        </div>
        <a
          href={`${grafanaUrl}/d/mongodb-adv-vis?var-connection_name=${encodeURIComponent(conn.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm px-3 py-2 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in Grafana
        </a>
      </div>

      {/* Row 1: Stat panels */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <GrafanaPanel panelId={1} height={120} vars={vars} />
        <GrafanaPanel panelId={2} height={120} vars={vars} />
        <GrafanaPanel panelId={3} height={120} vars={vars} />
        <GrafanaPanel panelId={4} height={120} vars={vars} />
      </div>

      {/* Row 2: Time-series */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GrafanaPanel panelId={5} height={300} vars={vars} />
        <GrafanaPanel panelId={6} height={300} vars={vars} />
      </div>

      {/* Row 3: Time-series */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GrafanaPanel panelId={7} height={300} vars={vars} />
        <GrafanaPanel panelId={8} height={300} vars={vars} />
      </div>

      {/* Row 4: Current Ops */}
      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Current Operations</h2>
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
            Live · {ops.length} active
          </span>
        </div>
        <CurrentOpsTable ops={ops} connectionId={activeConnectionId} />
      </div>

      {/* Row 5: Slow queries */}
      <SlowQueryFeed connectionId={activeConnectionId} />
    </div>
  )
}

function SlowQueryFeed({ connectionId }: { connectionId: string }) {
  const [threshold, setThreshold] = React.useState(100)

  const { data: queries = [] } = useQuery({
    queryKey: ['slowqueries', connectionId, threshold],
    queryFn: () => api.get<Array<Record<string, unknown>>>(`/api/connections/${connectionId}/monitor/slowqueries?thresholdMs=${threshold}`),
    refetchInterval: 10_000,
  })

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Slow Query Feed</h2>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Threshold (ms):</label>
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-20 bg-input border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      {queries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No slow queries above {threshold}ms.</p>
      ) : (
        <div className="space-y-2">
          {queries.slice(0, 20).map((q, i) => (
            <div key={i} className="text-xs bg-secondary/30 rounded p-2 font-mono">
              <span className="text-yellow-400">{String(q['millis'] ?? '?')}ms</span>
              <span className="text-muted-foreground ml-2">{String(q['ns'] ?? '—')}</span>
              <span className="text-foreground ml-2 truncate">{JSON.stringify(q['query'] ?? q['command'])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import React from 'react'
