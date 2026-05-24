import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Play, Trash2 } from 'lucide-react'
import { api, type Connection, type ExportJob, type SyncJob } from '../lib/api'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function downloadExport(jobId: string, format: string, exportType?: string) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${BASE}/api/export/${jobId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Database exports are tar.gz archives; single-collection exports use the format extension
  const ext = exportType === 'database' ? 'tar.gz' : format
  a.download = `export-${jobId}.${ext}`
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
  const [exportMode, setExportMode] = useState<'collection' | 'database'>('collection')
  const [connId, setConnId] = useState('')
  const [db, setDb] = useState('')
  const [coll, setColl] = useState('')
  const [excludeColls, setExcludeColls] = useState<string[]>([])
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
    mutationFn: () => api.post('/api/export', {
      connectionId: connId,
      exportType: exportMode,
      database: db,
      ...(exportMode === 'collection' ? { collection: coll } : {}),
      query: {},
      format,
      options: exportMode === 'database' ? { excludeCollections: excludeColls } : {},
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['export-jobs', connId] }) },
  })

  const canExport = exportMode === 'collection'
    ? !!(connId && db && coll)
    : !!(connId && db)

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">New Export</h2>

        {/* Export mode toggle */}
        <div className="flex gap-4 mb-4">
          {(['collection', 'database'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" value={m} checked={exportMode === m} onChange={() => { setExportMode(m); setColl(''); setExcludeColls([]) }} />
              {m === 'collection' ? 'Single Collection' : 'Entire Database'}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
            <select value={connId} onChange={(e) => { setConnId(e.target.value); setDb(''); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {/* Export uses Mongo-only export endpoints; hide SQL conns to
                  prevent silent failures. Cross-engine "export" lands later. */}
              {connections.filter((c) => c.dbType === 'mongodb').map((c) =>
                <option key={c.id} value={c.id}>{c.name}</option>
              )}
            </select>
            {connections.some((c) => c.dbType !== 'mongodb') && (
              <p className="text-xs text-muted-foreground mt-1">
                Export currently supports MongoDB only.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Database</label>
            <select value={db} onChange={(e) => { setDb(e.target.value); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!connId}>
              <option value="">Select…</option>
              {databases.map((d) => <option key={d.name}>{d.name}</option>)}
            </select>
          </div>

          {exportMode === 'collection' ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Collection</label>
              <select value={coll} onChange={(e) => setColl(e.target.value)}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!db}>
                <option value="">Select…</option>
                {colls.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Exclude Collections (optional)</label>
              <div className="bg-input border border-border rounded p-2 max-h-32 overflow-y-auto">
                {colls.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{db ? 'Loading…' : 'Select a database first'}</p>
                ) : colls.map((c) => (
                  <label key={c.name} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                    <input type="checkbox" checked={excludeColls.includes(c.name)}
                      onChange={(e) => setExcludeColls(prev => e.target.checked ? [...prev, c.name] : prev.filter(x => x !== c.name))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}

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
          disabled={!canExport || createMutation.isPending}
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
              <th className="text-left py-2">Type</th>
              <th className="text-left py-2">Target</th>
              <th className="text-left py-2">Format</th>
              <th className="text-left py-2">Status</th>
              <th className="text-left py-2">Created</th>
              <th className="text-right py-2">Download</th>
            </tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/30">
                  <td className="py-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${j.exportType === 'database' ? 'bg-blue-500/20 text-blue-400' : 'bg-secondary text-muted-foreground'}`}>
                      {j.exportType === 'database' ? 'Database' : 'Collection'}
                    </span>
                  </td>
                  <td className="py-2">{j.exportType === 'database' ? j.database : `${j.database}.${j.collection}`}</td>
                  <td className="py-2 uppercase text-xs">{j.format}</td>
                  <td className="py-2"><JobStatusBadge status={j.status} /></td>
                  <td className="py-2 text-xs text-muted-foreground">{formatDate(j.createdAt)}</td>
                  <td className="py-2 text-right">
                    {j.status === 'done' && (
                      <button
                        onClick={() => downloadExport(j.id, j.format, j.exportType)}
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
  // Schedule builder state
  const [schedFreq, setSchedFreq] = useState<'none' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly'>('none')
  const [schedMinuteInterval, setSchedMinuteInterval] = useState('30')
  const [schedHour, setSchedHour] = useState('2')
  const [schedMinute, setSchedMinute] = useState('0')
  const [schedDow, setSchedDow] = useState('1') // 0=Sun,1=Mon…
  const [schedDom, setSchedDom] = useState('1')

  // Derive cron expression from builder state
  const schedule = useMemo(() => {
    switch (schedFreq) {
      case 'none':    return ''
      case 'minutes': return `*/${schedMinuteInterval} * * * *`
      case 'hourly':  return `${schedMinute} * * * *`
      case 'daily':   return `${schedMinute} ${schedHour} * * *`
      case 'weekly':  return `${schedMinute} ${schedHour} * * ${schedDow}`
      case 'monthly': return `${schedMinute} ${schedHour} ${schedDom} * *`
    }
  }, [schedFreq, schedMinuteInterval, schedHour, schedMinute, schedDow, schedDom])

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/sync', { sourceConnId: srcId, destConnId: dstId, scope: { all: true }, writeMode, schedule: schedule || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-jobs'] }),
  })

  // Per-job run status: jobId → { status, counts, error }
  const [runStates, setRunStates] = useState<Record<string, { status: 'queued' | 'running' | 'success' | 'partial' | 'failed'; transferred?: number; skipped?: number; error?: string }>>({})

  const pollRun = async (jobId: string) => {
    const maxAttempts = 60 // poll up to 5 min (5s interval)
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000))
      try {
        const runs = await api.get<Array<{ status: string; counts?: { transferred?: number; skipped?: number }; errorReport?: unknown }>>(`/api/sync/${jobId}/runs`)
        const latest = runs[0]
        if (!latest) continue
        if (latest.status === 'running') continue
        setRunStates(prev => ({
          ...prev,
          [jobId]: {
            status: latest.status as 'success' | 'partial' | 'failed',
            transferred: latest.counts?.transferred,
            skipped: latest.counts?.skipped,
            error: latest.status === 'failed' ? JSON.stringify(latest.errorReport) : undefined,
          }
        }))
        return
      } catch { /* network blip, keep polling */ }
    }
  }

  const runMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/sync/${jobId}/run`),
    onSuccess: (_, jobId) => {
      setRunStates(prev => ({ ...prev, [jobId]: { status: 'queued' } }))
      pollRun(jobId)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) => api.delete(`/api/sync/${jobId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-jobs'] }),
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
              {/* Sync currently only handles Mongo↔Mongo. Cross-engine sync
                  lands in a later phase — for now filter to Mongo to prevent
                  silent failures. */}
              {connections.filter((c) => c.dbType === 'mongodb').map((c) =>
                <option key={c.id} value={c.id}>{c.name}</option>
              )}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Destination Connection</label>
            <select value={dstId} onChange={(e) => setDstId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.filter((c) => c.id !== srcId && !c.readOnly && c.dbType === 'mongodb').map((c) =>
                <option key={c.id} value={c.id}>{c.name}</option>
              )}
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
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground mb-1 block">Schedule (optional)</label>
            <div className="space-y-2">
              {/* Frequency picker */}
              <div className="flex flex-wrap gap-2">
                {([
                  { val: 'none',    label: 'No schedule' },
                  { val: 'minutes', label: 'Every N minutes' },
                  { val: 'hourly',  label: 'Every hour' },
                  { val: 'daily',   label: 'Every day' },
                  { val: 'weekly',  label: 'Every week' },
                  { val: 'monthly', label: 'Every month' },
                ] as const).map(({ val, label }) => (
                  <button key={val} type="button"
                    onClick={() => setSchedFreq(val)}
                    className={`px-3 py-1 text-xs rounded border transition-colors ${schedFreq === val ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-primary/50'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Sub-options per frequency */}
              {schedFreq === 'minutes' && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Every</span>
                  <select value={schedMinuteInterval} onChange={e => setSchedMinuteInterval(e.target.value)}
                    className="bg-input border border-border rounded px-2 py-1 text-sm">
                    {[5,10,15,20,30,45].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <span className="text-muted-foreground">minutes</span>
                </div>
              )}

              {schedFreq === 'hourly' && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">At minute</span>
                  <select value={schedMinute} onChange={e => setSchedMinute(e.target.value)}
                    className="bg-input border border-border rounded px-2 py-1 text-sm">
                    {[0,5,10,15,20,30,45].map(n => <option key={n} value={n}>{String(n).padStart(2,'0')}</option>)}
                  </select>
                  <span className="text-muted-foreground">of every hour</span>
                </div>
              )}

              {(schedFreq === 'daily' || schedFreq === 'weekly' || schedFreq === 'monthly') && (
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  {schedFreq === 'weekly' && (
                    <>
                      <span className="text-muted-foreground">Every</span>
                      <select value={schedDow} onChange={e => setSchedDow(e.target.value)}
                        className="bg-input border border-border rounded px-2 py-1 text-sm">
                        {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d,i) => <option key={i} value={i}>{d}</option>)}
                      </select>
                    </>
                  )}
                  {schedFreq === 'monthly' && (
                    <>
                      <span className="text-muted-foreground">On day</span>
                      <select value={schedDom} onChange={e => setSchedDom(e.target.value)}
                        className="bg-input border border-border rounded px-2 py-1 text-sm">
                        {Array.from({length:28},(_,i)=>i+1).map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <span className="text-muted-foreground">of every month</span>
                    </>
                  )}
                  <span className="text-muted-foreground">{schedFreq === 'daily' ? 'Every day' : ''} at</span>
                  <select value={schedHour} onChange={e => setSchedHour(e.target.value)}
                    className="bg-input border border-border rounded px-2 py-1 text-sm">
                    {Array.from({length:24},(_,i)=>i).map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}
                  </select>
                </div>
              )}

              {/* Cron preview */}
              {schedule && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-green-400">✓ {humanCron(schedule)}</span>
                  <span className="text-xs text-muted-foreground font-mono bg-secondary px-1.5 py-0.5 rounded">{schedule}</span>
                </div>
              )}
            </div>
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
              const runState = runStates[j.id]
              const isRunning = runState?.status === 'queued' || runState?.status === 'running'
              return (
                <div key={j.id} className="p-3 bg-secondary/20 rounded space-y-2">
                  {/* Top row: job info + actions */}
                  <div className="flex items-center gap-4">
                    <div className="flex-1 text-sm">
                      <span className="font-medium">{src?.name ?? '?'}</span>
                      <span className="text-muted-foreground mx-2">→</span>
                      <span className="font-medium">{dst?.name ?? '?'}</span>
                      <span className="ml-3 text-xs bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{j.writeMode}</span>
                      {j.schedule && <span className="ml-2 text-xs text-muted-foreground">{humanCron(j.schedule)}</span>}
                    </div>
                    <button onClick={() => runMutation.mutate(j.id)}
                      disabled={isRunning}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                      {isRunning
                        ? <><span className="inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> {runState?.status === 'queued' ? 'Queued…' : 'Running…'}</>
                        : <><Play className="h-3 w-3" /> Run Now</>
                      }
                    </button>
                    <button
                      onClick={() => { if (confirm('Delete this sync job?')) deleteMutation.mutate(j.id) }}
                      disabled={deleteMutation.isPending || isRunning}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-40">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Run result badge */}
                  {runState && !isRunning && (
                    <div className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                      runState.status === 'success' ? 'bg-green-500/10 text-green-400' :
                      runState.status === 'partial' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-destructive/10 text-destructive'
                    }`}>
                      {runState.status === 'success' && '✓ Completed successfully'}
                      {runState.status === 'partial' && '⚠ Completed with some errors'}
                      {runState.status === 'failed' && '✕ Failed'}
                      {runState.transferred !== undefined && (
                        <span className="text-muted-foreground ml-1">
                          · {runState.transferred} written
                          {runState.skipped ? ` · ${runState.skipped} skipped` : ''}
                        </span>
                      )}
                      {runState.error && <span className="ml-1 opacity-70 truncate max-w-xs">{runState.error}</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
