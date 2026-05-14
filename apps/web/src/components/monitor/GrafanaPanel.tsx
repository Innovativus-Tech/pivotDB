interface GrafanaPanelProps {
  panelId: number
  height?: number
  vars?: Record<string, string>
}

export function GrafanaPanel({ panelId, height = 300, vars = {} }: GrafanaPanelProps) {
  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3003'
  const varString  = Object.entries(vars).map(([k, v]) => `var-${k}=${encodeURIComponent(v)}`).join('&')
  const src = `${grafanaUrl}/d-solo/mongodb-adv-vis?orgId=1&panelId=${panelId}&theme=dark&refresh=5s${varString ? '&' + varString : ''}`

  return (
    <iframe
      src={src}
      width="100%"
      height={height}
      frameBorder={0}
      style={{ borderRadius: 8 }}
      title={`Grafana panel ${panelId}`}
    />
  )
}
