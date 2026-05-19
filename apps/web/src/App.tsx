import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/shared/Layout'
import { LoginPage } from './pages/Login'
import { ConnectionsPage } from './pages/Connections'
import { ExplorePage } from './pages/Explore'
import { MonitorPage } from './pages/Monitor'
import { MovePage } from './pages/Move'
import { ProtectPage } from './pages/Protect'
import { SettingsPage } from './pages/Settings'
import { MigratePage } from './pages/Migrate'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token')
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/connections" replace />} />
                <Route path="/connections" element={<ConnectionsPage />} />
                <Route path="/explore" element={<ExplorePage />} />
                <Route path="/monitor" element={<MonitorPage />} />
                <Route path="/move" element={<MovePage />} />
                <Route path="/protect" element={<ProtectPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/migrate" element={<MigratePage />} />
              </Routes>
            </Layout>
          </RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  )
}
