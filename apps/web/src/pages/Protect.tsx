import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Play, Trash2 } from 'lucide-react'
import { api, type Connection, type BackupJob, type S3Destination } from '../lib/api'
import { formatDate, humanCron } from '../lib/utils'

export function ProtectPage() {
  const [tab, setTab] = useState<'destinations' | 'jobs' | 'catalog'>('destinations')
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Protect</h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {(['destinations', 'jobs', 'catalog'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'destinations' ? 'S3 Destinations' : t === 'jobs' ? 'Backup Jobs' : 'Catalog'}
          </button>
        ))}
      </div>
      {tab === 'destinations' && <DestinationsTab />}
      {tab === 'jobs' && <BackupJobsTab />}
      {tab === 'catalog' && <CatalogTab />}
    </div>
  )
}

function DestinationsTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/api/connections') })
  const { data: destinations = [] } = useQuery({ queryKey: ['s3-destinations'], queryFn: () => api.get<S3Destination[]>('/api/backup/destinations') })
  const [connId, setConnId] = useState('')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [prefix, setPrefix] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/backup/destinations', {
      connectionId: connId, bucket, region, prefix,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['s3-destinations'] }); setBucket(''); setRegion('us-east-1'); setPrefix(''); setAccessKey(''); setSecretKey('') },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/backup/destinations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['s3-destinations'] }),
  })

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Add S3 Destination</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
            <select value={connId} onChange={(e) => setConnId(e.target.value)} className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">S3 Bucket</label>
            <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-backup-bucket"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Region</label>
            <input value={region} onChange={(e) => setRegion(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Prefix (optional)</label>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="backups/"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">AWS Access Key ID</label>
            <input value={accessKey} onChange={(e) => setAccessKey(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">AWS Secret Access Key</label>
            <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <button onClick={() => createMutation.mutate()} disabled={!connId || !bucket || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
          <Plus className="h-4 w-4" />
          {createMutation.isPending ? 'Saving…' : 'Save Destination'}
        </button>
      </div>

      {destinations.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="font-semibold mb-4">Destinations</h2>
          <div className="space-y-2">
            {destinations.map((d) => (
              <div key={d.id} className="flex items-center gap-4 p-3 bg-secondary/20 rounded text-sm">
                <div className="flex-1">
                  <span className="font-medium font-mono">s3://{d.bucket}/{d.prefix}</span>
                  <span className="text-muted-foreground text-xs ml-2">{d.region}</span>
                </div>
                <button onClick={() => deleteMutation.mutate(d.id)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BackupJobsTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/api/connections') })
  const { data: destinations = [] } = useQuery({ queryKey: ['s3-destinations'], queryFn: () => api.get<S3Destination[]>('/api/backup/destinations') })
  const { data: jobs = [] } = useQuery({ queryKey: ['backup-jobs'], queryFn: () => api.get<BackupJob[]>('/api/backup/jobs'), refetchInterval: 10_000 })
  const [connId, setConnId] = useState('')
  const [destId, setDestId] = useState('')
  const [schedule, setSchedule] = useState('0 2 * * *')
  const [keepN, setKeepN] = useState('14')

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/backup/jobs', {
      connectionId: connId, s3DestId: destId, schedule,
      scope: { all: true }, retentionPolicy: { keepN: parseInt(keepN) }, enabled: true,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-jobs'] }),
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/backup/jobs/${id}/run`),
  })

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Create Backup Job</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
            <select value={connId} onChange={(e) => setConnId(e.target.value)} className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">S3 Destination</label>
            <select value={destId} onChange={(e) => setDestId(e.target.value)} className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>s3://{d.bucket}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Schedule (cron)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
            <p className="text-xs text-muted-foreground mt-0.5">{humanCron(schedule)}</p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Keep last N backups</label>
            <input type="number" value={keepN} onChange={(e) => setKeepN(e.target.value)} min={1}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <button onClick={() => createMutation.mutate()} disabled={!connId || !destId || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
          <Plus className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Create Backup Job'}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="font-semibold mb-4">Backup Jobs</h2>
          <div className="space-y-3">
            {jobs.map((j) => {
              const conn = connections.find((c) => c.id === j.connectionId)
              return (
                <div key={j.id} className="flex items-center gap-4 p-3 bg-secondary/20 rounded text-sm">
                  <div className="flex-1">
                    <span className="font-medium">{conn?.name ?? j.connectionId}</span>
                    <span className="text-muted-foreground text-xs ml-3">{humanCron(j.schedule)}</span>
                  </div>
                  <button onClick={() => runMutation.mutate(j.id)} disabled={runMutation.isPending}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:border-primary/50">
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

function CatalogTab() {
  const { data: jobs = [] } = useQuery({ queryKey: ['backup-jobs'], queryFn: () => api.get<BackupJob[]>('/api/backup/jobs') })
  const [selectedJob, setSelectedJob] = useState('')

  const { data: catalog = [] } = useQuery({
    queryKey: ['catalog', selectedJob],
    queryFn: () => api.get<Array<{ Key: string; Size: number; LastModified: string }>>(`/api/backup/jobs/${selectedJob}/catalog`),
    enabled: !!selectedJob,
  })

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Filter by job</label>
        <select value={selectedJob} onChange={(e) => setSelectedJob(e.target.value)}
          className="bg-input border border-border rounded px-3 py-2 text-sm">
          <option value="">All jobs</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.connectionId}</option>)}
        </select>
      </div>

      {catalog.length === 0 ? (
        <p className="text-sm text-muted-foreground">No backups found.</p>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
              <th className="text-left px-4 py-2">Key</th>
              <th className="text-left px-4 py-2">Size</th>
              <th className="text-left px-4 py-2">Date</th>
            </tr></thead>
            <tbody>
              {catalog.map((item, i) => (
                <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                  <td className="px-4 py-2 font-mono text-xs truncate max-w-xs">{item.Key}</td>
                  <td className="px-4 py-2 text-xs">{Math.round(item.Size / 1024)}KB</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(item.LastModified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
