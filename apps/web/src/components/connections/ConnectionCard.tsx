import { useState } from 'react'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import { Trash2, TestTube2, Edit2, Zap } from 'lucide-react'
import { api, type Connection } from '../../lib/api'
import { ConfirmModal } from '../shared/ConfirmModal'
import { useConnectionsStore } from '../../stores/connections.store'

interface Props {
  connection: Connection
  onEdit: (conn: Connection) => void
}

const topologyColors: Record<string, string> = {
  standalone:  'bg-blue-500/10 text-blue-400',
  replicaSet:  'bg-purple-500/10 text-purple-400',
  sharded:     'bg-orange-500/10 text-orange-400',
}

export function ConnectionCard({ connection, onEdit }: Props) {
  const qc = useQueryClient()
  const { activeConnectionId, setActiveConnection } = useConnectionsStore()
  const [deleting, setDeleting] = useState(false)
  const [testResult, setTestResult] = useState<{ latencyMs: number; serverVersion: string } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/connections/${connection.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      if (activeConnectionId === connection.id) setActiveConnection(null)
    },
  })

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const result = await api.post<{ latencyMs: number; serverVersion: string; topology: string }>(
        `/api/connections/${connection.id}/test`
      )
      setTestResult(result)
    } catch (err) {
      setTestError(String(err))
    } finally {
      setTesting(false)
    }
  }

  const isActive = activeConnectionId === connection.id

  return (
    <>
      <div
        className={`bg-card border rounded-lg p-5 cursor-pointer transition-all hover:border-primary/50 ${
          isActive ? 'border-primary ring-1 ring-primary/30' : 'border-border'
        }`}
        onClick={() => setActiveConnection(connection.id)}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-foreground truncate">{connection.name}</h3>
            <div className="flex flex-wrap gap-1 mt-1">
              <span className={`text-xs px-1.5 py-0.5 rounded ${topologyColors[connection.topology] ?? 'bg-muted text-muted-foreground'}`}>
                {connection.topology}
              </span>
              {connection.readOnly && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400">read-only</span>
              )}
              {connection.tags.map((tag) => (
                <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{tag}</span>
              ))}
            </div>
          </div>
          {isActive && <Zap className="h-4 w-4 text-primary shrink-0 ml-2" />}
        </div>

        {testResult && (
          <p className="text-xs text-green-400 mb-2">
            v{testResult.serverVersion} · {testResult.latencyMs}ms
          </p>
        )}
        {testError && (
          <p className="text-xs text-red-400 mb-2 truncate">{testError}</p>
        )}

        <div className="flex gap-2 mt-3">
          <button
            onClick={(e) => { e.stopPropagation(); handleTest() }}
            disabled={testing}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-50"
          >
            <TestTube2 className="h-3 w-3" />
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(connection) }}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            <Edit2 className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setDeleting(true) }}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors ml-auto"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        </div>
      </div>

      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => { deleteMutation.mutate(); setDeleting(false) }}
        title="Delete connection"
        description="This will permanently delete the connection and cascade-disable all dependent jobs."
        confirmText="Delete"
        requireTyped={connection.name}
        destructive
        loading={deleteMutation.isPending}
      />
    </>
  )
}
