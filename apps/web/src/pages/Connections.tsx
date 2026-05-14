import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Database } from 'lucide-react'
import { api, type Connection } from '../lib/api'
import { ConnectionCard } from '../components/connections/ConnectionCard'
import { AddConnectionModal } from '../components/connections/AddConnectionModal'

export function ConnectionsPage() {
  const [addOpen, setAddOpen] = useState(false)
  const [editConn, setEditConn] = useState<Connection | null>(null)

  const { data: connections = [], isLoading, error } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Connections</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your MongoDB deployments
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Connection
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-48 text-muted-foreground">
          Loading connections…
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {!isLoading && connections.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <Database className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-1">No connections yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Add your first MongoDB connection to get started.
          </p>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Add Connection
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {connections.map((conn) => (
          <ConnectionCard key={conn.id} connection={conn} onEdit={setEditConn} />
        ))}
      </div>

      <AddConnectionModal open={addOpen} onClose={() => setAddOpen(false)} />
      {editConn && (
        <AddConnectionModal
          open
          onClose={() => setEditConn(null)}
          existing={editConn}
        />
      )}
    </div>
  )
}
