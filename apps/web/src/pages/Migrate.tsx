import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, AlertTriangle, XCircle, Play, ChevronRight } from 'lucide-react'
import { api, type Connection, type MigrationJob, type MigrationRun } from '../lib/api'
import { JobStatusBadge } from '../components/shared/JobStatusBadge'
import { formatDate } from '../lib/utils'

const STEPS = ['Source & Dest', 'Scope', 'Options', 'Preflight', 'Run'] as const
type Step = 0 | 1 | 2 | 3 | 4

interface PreflightCheck {
  label: string
  status: 'ok' | 'warn' | 'error'
  message: string
}

interface PreflightResult {
  ok: boolean
  checks: PreflightCheck[]
}

interface MigrationOptions {
  dropDestination: boolean
  dropAllDestination: boolean
  preserveUsers: boolean
  oplog: boolean
  gzip: boolean
  numParallelCollections: number
}

export function MigratePage() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  // Step state
  const [step, setStep] = useState<Step>(0)

  // Step 1: Source / dest
  const [srcId, setSrcId] = useState('')
  const [dstId, setDstId] = useState('')
  const [migName, setMigName] = useState('')

  useEffect(() => {
    const src = connections.find((c) => c.id === srcId)
    const dst = connections.find((c) => c.id === dstId)
    if (src && dst) {
      const date = new Date().toISOString().slice(0, 10)
      setMigName(`${src.name} → ${dst.name} ${date}`)
    }
  }, [srcId, dstId, connections])

  // Step 2: Scope
  const [allDbs, setAllDbs] = useState(true)
  const [selectedDbs, setSelectedDbs] = useState<string[]>([])

  const { data: sourceDbs = [] } = useQuery({
    queryKey: ['databases', srcId],
    queryFn: () => api.get<{ name: string }[]>(`/api/connections/${srcId}/explore/databases`),
    enabled: !!srcId && !allDbs,
  })

  // Step 3: Options
  const [opts, setOpts] = useState<MigrationOptions>({
    dropDestination: false,
    dropAllDestination: false,
    preserveUsers: false,
    oplog: false,
    gzip: true,
    numParallelCollections: 4,
  })

  // Step 4: Preflight
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)

  const runPreflight = async () => {
    setPreflightLoading(true)
    try {
      const result = await api.post<PreflightResult>('/api/migration/preflight', {
        sourceConnId: srcId,
        destConnId: dstId,
      })
      setPreflight(result)
    } catch (err) {
      setPreflight({ ok: false, checks: [{ label: 'API call', status: 'error', message: String(err) }] })
    } finally {
      setPreflightLoading(false)
    }
  }

  // Step 5: Running + confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: () => api.post<MigrationJob>('/api/migration', {
      name: migName,
      sourceConnId: srcId,
      destConnId: dstId,
      scope: allDbs ? { all: true } : { databases: selectedDbs },
      options: opts,
    }),
    onSuccess: (job) => {
      setActiveJobId(job.id)
      setStep(4)
      qc.invalidateQueries({ queryKey: ['migration-jobs'] })
    },
  })

  const startMigration = () => {
    if (opts.dropDestination || opts.dropAllDestination) {
      setConfirmOpen(true)
    } else {
      createMutation.mutate()
    }
  }

  const { data: activeJob, refetch: refetchJob } = useQuery({
    queryKey: ['migration-job', activeJobId],
    queryFn: () => api.get<MigrationJob & { runs: MigrationRun[] }>(`/api/migration/${activeJobId}`),
    enabled: !!activeJobId,
    refetchInterval: (data) => {
      const status = data?.state?.data?.status
      return status === 'running' || status === 'pending' ? 2000 : false
    },
  })

  const activeRun = activeJob?.runs?.[0]
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [activeRun?.logLines])

  // History
  const { data: history = [] } = useQuery({
    queryKey: ['migration-jobs'],
    queryFn: () => api.get<MigrationJob[]>('/api/migration'),
    refetchInterval: 10_000,
  })

  const phaseOrder = ['dump', 'restore', 'cleanup', 'done']

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Migrate</h1>
      <p className="text-sm text-muted-foreground mb-6">Copy databases between MongoDB connections using mongodump + mongorestore.</p>

      {/* Stepper */}
      <div className="flex items-center gap-1 mb-8 text-sm">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-1">
            <button
              onClick={() => { if (i < step || i === step) setStep(i as Step) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                i === step ? 'bg-primary text-primary-foreground' :
                i < step ? 'bg-primary/20 text-primary hover:bg-primary/30' :
                'text-muted-foreground'
              }`}
            >
              {i + 1}. {label}
            </button>
            {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {/* Step 1: Source & Dest */}
      {step === 0 && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <h2 className="font-semibold">Step 1: Source & Destination</h2>
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
          </div>
          {srcId && dstId && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary/20 rounded p-3">
              <span className="font-medium text-foreground">{connections.find(c => c.id === srcId)?.name}</span>
              <ArrowRight className="h-4 w-4" />
              <span className="font-medium text-foreground">{connections.find(c => c.id === dstId)?.name}</span>
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Migration Name</label>
            <input value={migName} onChange={(e) => setMigName(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <button onClick={() => setStep(1)} disabled={!srcId || !dstId || !migName}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
            Next: Scope
          </button>
        </div>
      )}

      {/* Step 2: Scope */}
      {step === 1 && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <h2 className="font-semibold">Step 2: Scope</h2>
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              onClick={() => setAllDbs(!allDbs)}
              className={`w-10 h-6 rounded-full transition-colors cursor-pointer ${allDbs ? 'bg-primary' : 'bg-secondary'} relative`}
            >
              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${allDbs ? 'left-5' : 'left-1'}`} />
            </div>
            <span className="text-sm">Migrate all databases</span>
          </label>
          {!allDbs && (
            <div>
              <label className="text-xs text-muted-foreground mb-2 block">Select databases to migrate</label>
              {sourceDbs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading databases from source…</p>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto border border-border rounded p-2">
                  {sourceDbs.map((d) => (
                    <label key={d.name} className="flex items-center gap-2 text-sm cursor-pointer py-0.5">
                      <input type="checkbox" checked={selectedDbs.includes(d.name)}
                        onChange={(e) => setSelectedDbs(prev => e.target.checked ? [...prev, d.name] : prev.filter(x => x !== d.name))} />
                      {d.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => setStep(0)} className="px-4 py-2 text-sm border border-border rounded hover:border-primary/50">Back</button>
            <button onClick={() => setStep(2)}
              disabled={!allDbs && selectedDbs.length === 0}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
              Next: Options
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Options */}
      {step === 2 && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-5">
          <h2 className="font-semibold">Step 3: Options</h2>

          <div className="space-y-3">
            {/* Drop destination — red toggle */}
            <div className={`flex items-center justify-between p-3 rounded border ${opts.dropDestination ? 'border-destructive/40 bg-destructive/5' : 'border-border'}`}>
              <div>
                <p className="text-sm font-medium">Drop Destination</p>
                <p className="text-xs text-muted-foreground">Drop only the in-scope databases on destination before restoring. Destructive!</p>
              </div>
              <div onClick={() => setOpts(o => ({ ...o, dropDestination: !o.dropDestination, dropAllDestination: false }))}
                className={`w-10 h-6 rounded-full transition-colors cursor-pointer relative ${opts.dropDestination ? 'bg-destructive' : 'bg-secondary'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${opts.dropDestination ? 'left-5' : 'left-1'}`} />
              </div>
            </div>

            {/* Drop ALL destination — red toggle (wipes entire destination even on scoped migrations) */}
            <div className={`flex items-center justify-between p-3 rounded border ${opts.dropAllDestination ? 'border-destructive/40 bg-destructive/5' : 'border-border'}`}>
              <div>
                <p className="text-sm font-medium">Drop All Destination <span className="text-xs bg-destructive/20 text-destructive px-1.5 py-0.5 rounded ml-1">Nuclear</span></p>
                <p className="text-xs text-muted-foreground">Wipe ALL databases on destination before restoring — even if you're only migrating specific databases. Use when you want a clean slate.</p>
              </div>
              <div onClick={() => setOpts(o => ({ ...o, dropAllDestination: !o.dropAllDestination, dropDestination: false }))}
                className={`w-10 h-6 rounded-full transition-colors cursor-pointer relative ${opts.dropAllDestination ? 'bg-destructive' : 'bg-secondary'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${opts.dropAllDestination ? 'left-5' : 'left-1'}`} />
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded border border-border">
              <div>
                <p className="text-sm font-medium">Oplog</p>
                <p className="text-xs text-muted-foreground">Use --oplog for point-in-time snapshot (replica sets only)</p>
              </div>
              <div onClick={() => setOpts(o => ({ ...o, oplog: !o.oplog }))}
                className={`w-10 h-6 rounded-full transition-colors cursor-pointer relative ${opts.oplog ? 'bg-primary' : 'bg-secondary'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${opts.oplog ? 'left-5' : 'left-1'}`} />
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded border border-border">
              <div>
                <p className="text-sm font-medium">Gzip</p>
                <p className="text-xs text-muted-foreground">Compress dump files with gzip</p>
              </div>
              <div onClick={() => setOpts(o => ({ ...o, gzip: !o.gzip }))}
                className={`w-10 h-6 rounded-full transition-colors cursor-pointer relative ${opts.gzip ? 'bg-primary' : 'bg-secondary'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${opts.gzip ? 'left-5' : 'left-1'}`} />
              </div>
            </div>

            <div className="p-3 rounded border border-border">
              <p className="text-sm font-medium mb-2">Parallel Collections: {opts.numParallelCollections}</p>
              <input type="range" min={1} max={16} value={opts.numParallelCollections}
                onChange={(e) => setOpts(o => ({ ...o, numParallelCollections: parseInt(e.target.value) }))}
                className="w-full" />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>1</span><span>16</span>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="px-4 py-2 text-sm border border-border rounded hover:border-primary/50">Back</button>
            <button onClick={() => { setStep(3); runPreflight() }}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">
              Next: Preflight
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Preflight */}
      {step === 3 && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <h2 className="font-semibold">Step 4: Preflight</h2>
          {preflightLoading && <p className="text-sm text-muted-foreground">Running checks…</p>}
          {preflight && (
            <div className="space-y-2">
              {preflight.checks.map((check, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded bg-secondary/20">
                  {check.status === 'ok' && <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />}
                  {check.status === 'warn' && <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />}
                  {check.status === 'error' && <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                  <div>
                    <p className="text-sm font-medium">{check.label}</p>
                    <p className="text-xs text-muted-foreground">{check.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => setStep(2)} className="px-4 py-2 text-sm border border-border rounded hover:border-primary/50">Back</button>
            <button onClick={() => runPreflight()} disabled={preflightLoading}
              className="px-4 py-2 text-sm border border-border rounded hover:border-primary/50 disabled:opacity-50">
              Re-run Checks
            </button>
            <button onClick={startMigration}
              disabled={!preflight?.ok || createMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
              <Play className="h-4 w-4" />
              {createMutation.isPending ? 'Starting…' : 'Start Migration'}
            </button>
          </div>
          {createMutation.isError && (
            <p className="text-sm text-destructive">{(createMutation.error as Error).message}</p>
          )}
        </div>
      )}

      {/* Step 5: Live progress */}
      {step === 4 && activeJobId && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Migration in Progress</h2>
            {activeJob && <JobStatusBadge status={activeJob.status} />}
          </div>

          {/* Phase indicator */}
          <div className="flex items-center gap-2">
            {phaseOrder.slice(0, 3).map((phase, i) => {
              const current = activeRun?.phase
              const isDone = current === 'done' || (current && phaseOrder.indexOf(current) > i)
              const isActive = current === phase
              return (
                <div key={phase} className="flex items-center gap-2">
                  <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                    isDone ? 'bg-green-500/20 text-green-400' :
                    isActive ? 'bg-primary/20 text-primary' :
                    'bg-secondary text-muted-foreground'
                  }`}>
                    {phase.toUpperCase()}
                  </div>
                  {i < 2 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                </div>
              )
            })}
          </div>

          {/* Log terminal */}
          {activeRun && (
            <div ref={logRef} className="bg-black/80 rounded p-3 h-48 overflow-y-auto font-mono text-xs text-green-400 space-y-0.5">
              {activeRun.logLines.length === 0 ? (
                <p className="text-muted-foreground">Waiting for output…</p>
              ) : (
                activeRun.logLines.map((line, i) => <p key={i}>{line}</p>)
              )}
            </div>
          )}

          {/* Result */}
          {activeJob?.status === 'done' && (
            <div className="flex items-center gap-2 p-3 rounded bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Migration completed successfully.
            </div>
          )}
          {activeJob?.status === 'failed' && (
            <div className="p-3 rounded bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              <p className="font-medium">Migration failed</p>
              {!!activeRun?.errorReport && (
                <p className="text-xs mt-1 opacity-80">{JSON.stringify(activeRun.errorReport as object)}</p>
              )}
            </div>
          )}

          <button onClick={() => refetchJob()}
            className="text-xs text-muted-foreground hover:text-foreground">Refresh</button>
        </div>
      )}

      {/* Confirm modal for dropDestination / dropAllDestination */}
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="font-semibold text-lg mb-2 text-destructive">⚠ Destructive Operation</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {opts.dropAllDestination
                ? <><strong>"Drop All Destination"</strong> is enabled. <strong>Every database</strong> on the destination (except system DBs) will be <strong>permanently deleted</strong> before the migration starts — including databases not in your migration scope. This cannot be undone.</>
                : <><strong>"Drop Destination"</strong> is enabled. The in-scope databases on the destination will be <strong>permanently deleted</strong> before restoring. This cannot be undone.</>
              }
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm border border-border rounded hover:border-primary/50">Cancel</button>
              <button onClick={() => { setConfirmOpen(false); createMutation.mutate() }}
                className="px-4 py-2 bg-destructive text-destructive-foreground text-sm rounded hover:bg-destructive/90">
                Yes, Drop & Migrate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="mt-8 bg-card border border-border rounded-lg p-5">
          <h2 className="font-semibold mb-4">Migration History</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                <th className="text-left py-2">Name</th>
                <th className="text-left py-2">Source</th>
                <th className="text-left py-2">Destination</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2">Created</th>
                <th className="text-right py-2">View</th>
              </tr>
            </thead>
            <tbody>
              {history.map((j) => (
                <tr key={j.id} className="border-b border-border/30">
                  <td className="py-2 font-medium">{j.name}</td>
                  <td className="py-2 text-muted-foreground text-xs">{j.source?.name ?? j.sourceConnId}</td>
                  <td className="py-2 text-muted-foreground text-xs">{j.destination?.name ?? j.destConnId}</td>
                  <td className="py-2"><JobStatusBadge status={j.status} /></td>
                  <td className="py-2 text-xs text-muted-foreground">{formatDate(j.createdAt)}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => { setActiveJobId(j.id); setStep(4) }}
                      className="text-primary text-xs hover:underline">
                      View
                    </button>
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
