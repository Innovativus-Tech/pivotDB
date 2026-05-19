import { NavLink, useLocation } from 'react-router-dom'
import { Database, Search, BarChart3, ArrowLeftRight, Shield, Settings, LogOut, GitMerge } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/connections.store'
import { api, type AlertRule } from '../../lib/api'
import React from 'react'

const navItems = [
  { to: '/connections',  icon: Database,        label: 'Connections' },
  { to: '/explore',      icon: Search,          label: 'Explore'     },
  { to: '/monitor',      icon: BarChart3,       label: 'Monitor'     },
  { to: '/move',         icon: ArrowLeftRight,  label: 'Move'        },
  { to: '/migrate',      icon: GitMerge,        label: 'Migrate'     },
  { to: '/protect',      icon: Shield,          label: 'Protect'     },
  { to: '/settings',     icon: Settings,        label: 'Settings'    },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { clearAuth, user, token } = useAuthStore()

  const { data: active } = useQuery({
    queryKey: ['alerts-active'],
    queryFn: () => api.get<{ count: number; rules: AlertRule[] }>('/api/alerts/active'),
    refetchInterval: 30_000,
    enabled: !!token,
  })
  const activeCount = active?.count ?? 0

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-16 lg:w-56 flex flex-col border-r border-border bg-card shrink-0">
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-border">
          <Database className="h-5 w-5 text-primary shrink-0" />
          <span className="ml-3 font-semibold text-sm hidden lg:block text-foreground">
            MongoDB Visualizer
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 space-y-1 px-2">
          {navItems.map(({ to, icon: Icon, label }) => {
            const active = location.pathname.startsWith(to)
            const showAlertBadge = label === 'Monitor' && activeCount > 0
            return (
              <NavLink
                key={to}
                to={to}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <div className="relative shrink-0">
                  <Icon className="h-4 w-4" />
                  {showAlertBadge && (
                    <span
                      title={`${activeCount} alert${activeCount === 1 ? '' : 's'} firing`}
                      className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center"
                    >
                      {activeCount > 9 ? '9+' : activeCount}
                    </span>
                  )}
                </div>
                <span className="hidden lg:block flex-1">{label}</span>
                {showAlertBadge && (
                  <span className="hidden lg:inline-flex relative h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* User */}
        <div className="px-3 py-4 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center text-xs text-primary font-medium shrink-0">
              {user?.email?.[0]?.toUpperCase() ?? 'U'}
            </div>
            <div className="hidden lg:block flex-1 min-w-0">
              <p className="text-xs text-foreground truncate">{user?.email ?? 'User'}</p>
              <p className="text-xs text-muted-foreground capitalize">{user?.role ?? 'viewer'}</p>
            </div>
            <button onClick={clearAuth} className="hidden lg:flex text-muted-foreground hover:text-foreground transition-colors">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
