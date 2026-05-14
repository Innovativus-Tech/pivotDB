import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, Database, Table2, Bookmark, Download } from 'lucide-react'
import { api, type Connection, type SavedQuery } from '../lib/api'
import { useConnectionsStore } from '../stores/connections.store'
import { SchemaGraph } from '../components/explore/SchemaGraph'
import { AggregationEditor } from '../components/explore/AggregationEditor'
import { formatBytes } from '../lib/utils'

interface DbInfo { name: string }
interface CollInfo { name: string }

export function ExplorePage() {
  const { activeConnectionId } = useConnectionsStore()
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [selectedColl, setSelectedColl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'documents' | 'schema' | 'aggregate'>('documents')
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('{}')
  const [page, setPage] = useState(0)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table')
  const PAGE_SIZE = 50

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })
  const conn = connections.find((c) => c.id === activeConnectionId)

  const { data: databases = [] } = useQuery({
    queryKey: ['databases', activeConnectionId],
    queryFn: () => api.get<DbInfo[]>(`/api/connections/${activeConnectionId}/explore/databases`),
    enabled: !!activeConnectionId,
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['collections', activeConnectionId, selectedDb],
    queryFn: () => api.get<CollInfo[]>(`/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections`),
    enabled: !!(activeConnectionId && selectedDb),
  })

  const { data: queryResult, isLoading: queryLoading } = useQuery({
    queryKey: ['query', activeConnectionId, selectedDb, selectedColl, filter, page],
    queryFn: async () => {
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(filter) } catch { parsed = {} }
      return api.post<{ docs: Record<string, unknown>[]; total: number }>(
        `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/query`,
        { filter: parsed, limit: PAGE_SIZE, skip: page * PAGE_SIZE }
      )
    },
    enabled: !!(activeConnectionId && selectedDb && selectedColl && activeTab === 'documents'),
  })

  const { data: collStats } = useQuery({
    queryKey: ['collstats', activeConnectionId, selectedDb, selectedColl],
    queryFn: () => api.get<Record<string, unknown>>(
      `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/stats`
    ),
    enabled: !!(activeConnectionId && selectedDb && selectedColl),
  })

  const { data: indexes = [] } = useQuery({
    queryKey: ['indexes', activeConnectionId, selectedDb, selectedColl],
    queryFn: () => api.get<Record<string, unknown>[]>(
      `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/indexes`
    ),
    enabled: !!(activeConnectionId && selectedDb && selectedColl),
  })

  const { data: savedQueries = [] } = useQuery({
    queryKey: ['saved-queries', activeConnectionId],
    queryFn: () => api.get<SavedQuery[]>(`/api/connections/${activeConnectionId}/explore/saved-queries`),
    enabled: !!activeConnectionId,
  })

  const qc = useQueryClient()
  const saveQueryMutation = useMutation({
    mutationFn: (name: string) => api.post(
      `/api/connections/${activeConnectionId}/explore/saved-queries`,
      { name, database: selectedDb, collection: selectedColl, query: JSON.parse(filter || '{}'), isPipeline: false }
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-queries', activeConnectionId] }),
  })

  const toggleDb = (dbName: string) => {
    const next = new Set(expandedDbs)
    if (next.has(dbName)) next.delete(dbName)
    else next.add(dbName)
    setExpandedDbs(next)
    setSelectedDb(dbName)
  }

  const handleExport = () => {
    if (!activeConnectionId || !selectedDb || !selectedColl) return
    api.post<{ id: string }>('/api/export', {
      connectionId: activeConnectionId, database: selectedDb,
      collection: selectedColl, query: {}, format: 'json', options: {},
    }).then(() => alert('Export job queued. Check Move → Export for download link.'))
  }

  if (!activeConnectionId || !conn) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <p className="text-muted-foreground">Select a connection from the Connections page to explore.</p>
      </div>
    )
  }

  const docs = queryResult?.docs ?? []
  const total = queryResult?.total ?? 0
  const columns = docs.length > 0 ? Object.keys(docs[0]).filter((k) => k !== '_id').slice(0, 10) : []
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left panel: DB/collection tree */}
      <aside className="w-56 border-r border-border bg-card overflow-y-auto shrink-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{conn.name}</p>
        </div>
        <div className="py-2">
          {databases.map((db) => (
            <div key={db.name}>
              <button
                onClick={() => toggleDb(db.name)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-secondary/50 transition-colors text-left"
              >
                {expandedDbs.has(db.name) ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{db.name}</span>
              </button>
              {expandedDbs.has(db.name) && collections.map && db.name === selectedDb && collections.map((coll) => (
                <button
                  key={coll.name}
                  onClick={() => { setSelectedColl(coll.name); setPage(0); setActiveTab('documents') }}
                  className={`w-full flex items-center gap-1.5 pl-8 pr-3 py-1.5 text-sm hover:bg-secondary/50 transition-colors text-left ${
                    selectedColl === coll.name && selectedDb === db.name ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                  }`}
                >
                  <Table2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">{coll.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Center panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedColl && selectedDb ? (
          <>
            {/* Toolbar */}
            <div className="border-b border-border px-4 py-2 flex items-center gap-4 bg-card shrink-0">
              <div className="flex gap-1">
                {(['documents', 'schema', 'aggregate'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 text-xs rounded capitalize transition-colors ${
                      activeTab === tab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              {activeTab === 'documents' && (
                <>
                  <button
                    onClick={() => setViewMode(viewMode === 'table' ? 'json' : 'table')}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border"
                  >
                    {viewMode === 'table' ? 'JSON View' : 'Table View'}
                  </button>
                  <button onClick={() => { const name = prompt('Query name:'); if (name) saveQueryMutation.mutate(name) }}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border flex items-center gap-1">
                    <Bookmark className="h-3 w-3" /> Save
                  </button>
                  <button onClick={handleExport}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border flex items-center gap-1">
                    <Download className="h-3 w-3" /> Export
                  </button>
                </>
              )}
            </div>

            {/* Filter bar for documents tab */}
            {activeTab === 'documents' && (
              <div className="border-b border-border px-4 py-2 bg-card shrink-0 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Filter:</span>
                <input
                  className="flex-1 bg-input border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  value={filter}
                  onChange={(e) => { setFilter(e.target.value); setPage(0) }}
                  placeholder="{}"
                />
                <span className="text-xs text-muted-foreground">{total.toLocaleString()} docs</span>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-auto">
              {activeTab === 'documents' && (
                <>
                  {queryLoading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
                  {!queryLoading && viewMode === 'table' && (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card border-b border-border">
                        <tr>
                          {['_id', ...columns].map((col) => (
                            <th key={col} className="text-left px-3 py-2 text-muted-foreground font-medium">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {docs.map((doc, i) => (
                          <tr key={i} className="border-b border-border/30 hover:bg-secondary/20">
                            {['_id', ...columns].map((col) => (
                              <td key={col} className="px-3 py-2 font-mono max-w-[200px] truncate">
                                {JSON.stringify(doc[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!queryLoading && viewMode === 'json' && (
                    <div className="p-4 space-y-2">
                      {docs.map((doc, i) => (
                        <pre key={i} className="text-xs bg-secondary/30 p-3 rounded overflow-x-auto">
                          {JSON.stringify(doc, null, 2)}
                        </pre>
                      ))}
                    </div>
                  )}
                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 py-3 border-t border-border">
                      <button disabled={page === 0} onClick={() => setPage(page - 1)}
                        className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
                        Previous
                      </button>
                      <span className="text-xs text-muted-foreground">
                        Page {page + 1} of {totalPages}
                      </span>
                      <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}
                        className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
                        Next
                      </button>
                    </div>
                  )}
                  {/* Saved queries */}
                  {savedQueries.length > 0 && (
                    <div className="border-t border-border p-4">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">SAVED QUERIES</p>
                      <div className="space-y-1">
                        {savedQueries.map((q) => (
                          <button key={q.id} onClick={() => setFilter(JSON.stringify(q.query))}
                            className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-secondary transition-colors">
                            {q.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {activeTab === 'schema' && (
                <SchemaGraph
                  connectionId={activeConnectionId}
                  database={selectedDb}
                  collection={selectedColl}
                />
              )}
              {activeTab === 'aggregate' && (
                <AggregationEditor
                  connectionId={activeConnectionId}
                  database={selectedDb}
                  collection={selectedColl}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Select a collection from the tree on the left.
          </div>
        )}
      </div>

      {/* Right panel: stats */}
      {selectedColl && selectedDb && (
        <aside className="w-72 border-l border-border bg-card overflow-y-auto shrink-0">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-semibold">{selectedDb}.{selectedColl}</h3>
          </div>
          {collStats && (
            <div className="p-4 space-y-2 border-b border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Stats</p>
              {[
                ['Documents', (collStats['count'] as number)?.toLocaleString()],
                ['Size', formatBytes(collStats['size'] as number)],
                ['Avg Doc', formatBytes(collStats['avgObjSize'] as number)],
                ['Indexes', String(collStats['nindexes'])],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium">{value}</span>
                </div>
              ))}
            </div>
          )}
          <div className="p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Indexes</p>
            <div className="space-y-2">
              {indexes.map((idx, i) => (
                <div key={i} className="text-xs bg-secondary/30 rounded p-2">
                  <p className="font-medium text-foreground">{String(idx['name'])}</p>
                  <p className="text-muted-foreground font-mono mt-0.5">
                    {JSON.stringify(idx['key'])}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}
