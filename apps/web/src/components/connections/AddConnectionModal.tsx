import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, TestTube2, Plus } from 'lucide-react'
import { api, type Connection } from '../../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  existing?: Connection
}

export function AddConnectionModal({ open, onClose, existing }: Props) {
  const qc = useQueryClient()
  const isEdit = !!existing

  const [name, setName]         = useState(existing?.name ?? '')
  const [uri, setUri]           = useState('')
  const [tags, setTags]         = useState(existing?.tags.join(', ') ?? '')
  const [readOnly, setReadOnly] = useState(existing?.readOnly ?? false)
  const [testResult, setTestResult] = useState<{ latencyMs: number; serverVersion: string; topology: string } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const createMutation = useMutation({
    mutationFn: (data: { name: string; uri: string; tags: string[]; readOnly: boolean }) =>
      api.post<Connection>('/api/connections', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
  })

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; tags: string[]; readOnly: boolean }) =>
      api.put<Connection>(`/api/connections/${existing!.id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
  })

  const handleTest = async () => {
    if (!uri) return
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      // Create temp test by posting to a test endpoint directly
      const result = await api.post<{ latencyMs: number; serverVersion: string; topology: string }>(
        '/api/connections', { name: '__test__', uri, tags: [], readOnly: false, _testOnly: true }
      ).catch(async () => {
        // Fallback: try direct validation
        throw new Error('Could not reach server')
      })
      setTestResult(result)
    } catch (err) {
      setTestError(String(err))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    if (isEdit) {
      updateMutation.mutate({ name, tags: tagList, readOnly })
    } else {
      createMutation.mutate({ name, uri, tags: tagList, readOnly })
    }
  }

  if (!open) return null

  const isPending = createMutation.isPending || updateMutation.isPending
  const error = createMutation.error || updateMutation.error

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-lg p-6 w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{isEdit ? 'Edit Connection' : 'Add Connection'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Friendly Name *</label>
            <input
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production Atlas"
            />
          </div>

          {!isEdit && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">MongoDB URI *</label>
              <input
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="mongodb://user:pass@host:27017/db"
                type="password"
              />
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Tags (comma-separated)</label>
            <input
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="production, us-east-1"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="readOnly"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor="readOnly" className="text-sm text-muted-foreground">Read-only mode</label>
          </div>

          {!isEdit && (
            <div>
              {testResult && (
                <p className="text-xs text-green-400 mb-2">
                  Connected: MongoDB v{testResult.serverVersion} · {testResult.topology} · {testResult.latencyMs}ms
                </p>
              )}
              {testError && <p className="text-xs text-red-400 mb-2">{testError}</p>}
              <button
                onClick={handleTest}
                disabled={!uri || testing}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-50"
              >
                <TestTube2 className="h-3.5 w-3.5" />
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error.message}</p>}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name || (!isEdit && !uri) || isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            {isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Connection'}
          </button>
        </div>
      </div>
    </div>
  )
}
