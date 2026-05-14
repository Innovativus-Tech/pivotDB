import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConnectionsStore {
  activeConnectionId: string | null
  setActiveConnection: (id: string | null) => void
}

export const useConnectionsStore = create<ConnectionsStore>()(
  persist(
    (set) => ({
      activeConnectionId: null,
      setActiveConnection: (id) => set({ activeConnectionId: id }),
    }),
    { name: 'connections-store' },
  ),
)

interface AuthStore {
  token: string | null
  user: { email: string; role: string } | null
  setAuth: (token: string, user: { email: string; role: string }) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      token: localStorage.getItem('token'),
      user: null,
      setAuth: (token, user) => {
        localStorage.setItem('token', token)
        set({ token, user })
      },
      clearAuth: () => {
        localStorage.removeItem('token')
        set({ token: null, user: null })
      },
    }),
    { name: 'auth-store' },
  ),
)
