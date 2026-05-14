import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Play } from 'lucide-react'
import { api, type Connection, type ExportJob, type SyncJob } from '../lib/api'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function downloadExport(jobId: string, format: string) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${BASE}/api/export/${jobId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `export-${jobId}.${format}`
  a.click()
  URL.revokeObjectURL(url)
}
import { JobStatusBadge } from '../components/shared/JobStatusBadge'
import { formatDate, humanCron } from '../lib/utils'

export function MovePage() {
  const [tab, setTab] = useState<'export' | 'sync'>('export')
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Move</h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {(['export', 'sync'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'export' ? <ExportTab /> : <SyncTab />}
    </div>
  )
}

function ExportTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/api/connections') })
  const [connId, setConnId] = useState('')
  const [db, setDb] = useState('')
  const [coll, setColl] = useState('')
  const [format, setFormat] = useState<'csv' | 'json'>('json')

  const { data: databases = [] } = useQuery({
    queryKey: ['databases', connId],
    queryFn: () => api.get<{ name: string }[]>(`/api/connections/${connId}/explore/databases`),
    enabled: !!connId,
  })
  const { data: colls = [] } = useQuery({
    queryKey: ['collections', connId, db],
    queryFn: () => api.get<{ name: string }[]>(`/api/connections/${connId}/explore/databases/${db}/collections`),
    enabled: !!(connId && db),
  })
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ['export-jobs', connId],
    queryFn: () => api.get<ExportJob[]>(`/api/export?connectionId=${connId}`),
    enabled: !!connId,
    refetchInterval: 5000,
  })

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/export', { connectionId: connId, database: db, collection: coll, query: {}, format, options: {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['export-jobs', connId] }) },
  })

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">New Export</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
            <select value={connId} onChange={(e) => { setConnId(e.target.value); setDb(''); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Database</label>
            <select value={db} onChange={(e) => { setDb(e.target.value); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!connId}>
              <option value="">Select…</option>
              {databases.map((d) => <option key={d.name}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Collection</label>
            <select value={coll} onChange={(e) => setColl(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!db}>
              <option value="">Select…</option>
              {colls.map((c) => <option key={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Format</label>
            <div className="flex gap-4 mt-2">
              {(['json', 'csv'] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" value={f} checked={format === f} onChange={() => setFormat(f)} />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={!connId || !db || !coll || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Export'}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Export History</h2>
            <button onClick={() => refetch()} className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-4 w-4" /></button>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase">
              <th className="text-left py-2">Collection</th>
              <th className="text-left py-2">Format</th>
              <th className="text-left py-2">Status</th>
              <th className="text-left py-2">Created</th>
              <th className="text-right py-2">Download</th>
            </tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/30">
                  <td className="py-2">{j.database}.{j.collection}</td>
                  <td className="py-2 uppercase text-xs">{j.format}</td>
                  <td className="py-2"><JobStatusBadge status={j.status} /></td>
                  <td className="py-2 text-xs text-muted-foreground">{formatDate(j.createdAt)}</td>
                  <td className="py-2 text-right">
                    {j.status === 'done' && (
                      <button
                        onClick={() => downloadExport(j.id, j.format)}
                        className="text-primary text-xs hover:underline"
                      >
                        Download
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SyncTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/api/connections') })
  const { data: jobs = [] } = useQuery({ queryKey: ['sync-jobs'], queryFn: () => api.get<SyncJob[]>('/api/sync'), refetchInterval: 10_000 })

  const [srcId, setSrcId] = useState('')
  const [dstId, setDstId] = useState('')
  const [writeMode, setWriteMode] = useState<'insertOnly' | 'upsert' | 'replace'>('upsert')
  const [schedule, setSchedule] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/sync', { sourceConnId: srcId, destConnId: dstId, scope: { all: true }, writeMode, schedule: schedule || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-jobs'] }),
  })

  const runMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/sync/${jobId}/run`),
  })

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">New Sync Job</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Source Connection</label>
            <select value={srcId} onChange={(e) => setSrcId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Destination Connection</label>
            <select value={dstId} onChange={(e) => setDstId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.filter((c) => c.id !== srcId && !c.readOnly).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Write Mode</label>
            <select value={writeMode} onChange={(e) => setWriteMode(e.target.value as typeof writeMode)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="insertOnly">Insert Only</option>
              <option value="upsert">Upsert (match _id)</option>
              <option value="replace">Replace Collection</option>
            </select>
            {writeMode === 'replace' && (
              <p className="text-xs text-red-400 mt-1">⚠ Replace mode drops the destination collection before writing.</p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Schedule (cron, optional)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 2 * * * (2am daily)"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
            {schedule && <p className="text-xs text-muted-foreground mt-0.5">{humanCron(schedule)}</p>}
          </div>
        </div>
        <button onClick={() => createMutation.mutate()}
          disabled={!srcId || !dstId || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
          <RefreshCw className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Save & Schedule'}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="font-semibold mb-4">Sync Jobs</h2>
          <div className="space-y-3">
            {jobs.map((j) => {
              const src = connections.find((c) => c.id === j.sourceConnId)
              const dst = connections.find((c) => c.id === j.destConnId)
              return (
                <div key={j.id} className="flex items-center gap-4 p-3 bg-secondary/20 rounded">
                  <div className="flex-1 text-sm">
                    <span className="font-medium">{src?.name ?? '?'}</span>
                    <span className="text-muted-foreground mx-2">→</span>
                    <span className="font-medium">{dst?.name ?? '?'}</span>
                    <span className="ml-3 text-xs text-muted-foreground">{j.writeMode}</span>
                    {j.schedule && <span className="ml-2 text-xs text-muted-foreground">{humanCron(j.schedule)}</span>}
                  </div>
                  <button onClick={() => runMutation.mutate(j.id)}
                    disabled={runMutation.isPending}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground">
                    <Play className="h-3 w-3" /> Run Now
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
