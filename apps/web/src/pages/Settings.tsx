import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, UserPlus } from 'lucide-react'
import { api } from '../lib/api'
import { formatDate } from '../lib/utils'
import { register } from '../lib/api'

interface User { id: string; email: string; role: string; createdAt: string }
interface AuditEvent { id: string; actor: string; action: string; target: string; timestamp: string; metadata?: unknown }

export function SettingsPage() {
  const [tab, setTab] = useState<'users' | 'audit'>('users')
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {(['users', 'audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'users' ? 'Users' : 'Audit Log'}
          </button>
        ))}
      </div>
      {tab === 'users' ? <UsersTab /> : <AuditTab />}
    </div>
  )
}

function UsersTab() {
  const qc = useQueryClient()
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/settings/users') })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer')

  const inviteMutation = useMutation({
    mutationFn: () => register(email, password, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEmail(''); setPassword('') },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/settings/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Invite User</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <button onClick={() => inviteMutation.mutate()} disabled={!email || !password || inviteMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
          <UserPlus className="h-4 w-4" />
          {inviteMutation.isPending ? 'Creating…' : 'Create User'}
        </button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
            <th className="text-left px-4 py-2">Email</th>
            <th className="text-left px-4 py-2">Role</th>
            <th className="text-left px-4 py-2">Created</th>
            <th className="text-right px-4 py-2">Action</th>
          </tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2 capitalize">{u.role}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => deleteMutation.mutate(u.id)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AuditTab() {
  const [page, setPage] = useState(1)
  const [actionFilter, setActionFilter] = useState('')

  const { data } = useQuery({
    queryKey: ['audit', page, actionFilter],
    queryFn: () => api.get<{ events: AuditEvent[]; total: number }>(
      `/api/settings/audit?page=${page}&pageSize=50${actionFilter ? `&action=${actionFilter}` : ''}`
    ),
  })

  const events = data?.events ?? []
  const total  = data?.total ?? 0
  const totalPages = Math.ceil(total / 50)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1) }}
          className="bg-input border border-border rounded px-3 py-2 text-sm">
          <option value="">All actions</option>
          <option value="kill_op">kill_op</option>
          <option value="delete_connection">delete_connection</option>
          <option value="sync_replace">sync_replace</option>
          <option value="restore_backup">restore_backup</option>
          <option value="delete_backup">delete_backup</option>
        </select>
        <span className="text-sm text-muted-foreground">{total.toLocaleString()} events</span>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
            <th className="text-left px-4 py-2">Time</th>
            <th className="text-left px-4 py-2">Actor</th>
            <th className="text-left px-4 py-2">Action</th>
            <th className="text-left px-4 py-2">Target</th>
          </tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(e.timestamp)}</td>
                <td className="px-4 py-2 text-xs">{e.actor}</td>
                <td className="px-4 py-2">
                  <span className="bg-secondary text-xs px-1.5 py-0.5 rounded font-mono">{e.action}</span>
                </td>
                <td className="px-4 py-2 text-xs font-mono text-muted-foreground">{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}
            className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
            Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}
            className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
            Next
          </button>
        </div>
      )}
    </div>
  )
}
