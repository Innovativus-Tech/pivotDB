const BASE = import.meta.env.VITE_API_URL ?? ''

function getToken(): string | null {
  return localStorage.getItem('token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const hasBody = init.body !== undefined && init.body !== null
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    localStorage.removeItem('token')
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(err.error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  put:    <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
}

// Auth helpers
export async function login(email: string, password: string) {
  const res = await api.post<{ token: string; user: { email: string; role: string } }>(
    '/api/connections/auth/login', { email, password }
  )
  localStorage.setItem('token', res.token)
  return res
}

export async function register(email: string, password: string, role = 'admin') {
  return api.post('/api/connections/auth/register', { email, password, role })
}

// Connection types
export interface Connection {
  id: string
  name: string
  topology: string
  tags: string[]
  readOnly: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ExportJob {
  id: string
  connectionId: string
  database: string
  collection: string
  format: string
  status: string
  fileKey?: string
  createdAt: string
}

export interface SyncJob {
  id: string
  sourceConnId: string
  destConnId: string
  scope: unknown
  writeMode: string
  schedule?: string
  enabled: boolean
  createdAt: string
}

export interface BackupJob {
  id: string
  connectionId: string
  s3DestId: string
  schedule: string
  scope: unknown
  retentionPolicy: unknown
  enabled: boolean
  createdAt: string
}

export interface S3Destination {
  id: string
  connectionId: string
  bucket: string
  region: string
  prefix: string
  verifiedAt?: string
  createdAt: string
}

export interface AlertRule {
  id: string
  connectionId: string
  metric: string
  condition: { operator: string; threshold: number }
  durationSec: number
  channels: Array<{ type: string; target: string }>
  enabled: boolean
}

export interface SavedQuery {
  id: string
  name: string
  database: string
  collection: string
  query: unknown
  isPipeline: boolean
  createdAt: string
}
