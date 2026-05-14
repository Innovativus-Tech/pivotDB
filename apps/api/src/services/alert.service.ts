import { prisma } from '../lib/prisma.js';
import { metricsService } from './metrics.service.js';

interface AlertCondition { operator: 'gt' | 'lt' | 'gte' | 'lte'; threshold: number }
interface AlertChannel { type: 'email' | 'webhook'; target: string }

function evaluate(value: number, condition: AlertCondition): boolean {
  switch (condition.operator) {
    case 'gt':  return value > condition.threshold;
    case 'lt':  return value < condition.threshold;
    case 'gte': return value >= condition.threshold;
    case 'lte': return value <= condition.threshold;
  }
}

async function getMetricValue(metric: string, connectionId: string): Promise<number | null> {
  // Query Prometheus for the latest value
  const prometheusUrl = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
  try {
    const res = await fetch(
      `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(metric + '{connection_id="' + connectionId + '"}')}`,
    );
    const data = await res.json() as { data?: { result?: Array<{ value: [number, string] }> } };
    const result = data?.data?.result?.[0];
    if (result) return parseFloat(result.value[1]);
  } catch { /* prometheus unavailable */ }
  return null;
}

async function dispatch(channel: AlertChannel, message: string) {
  if (channel.type === 'webhook') {
    await fetch(channel.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).catch((err) => console.error('[alert] webhook failed:', err));
  }
  // Email dispatch would go here with SMTP configuration
}

export async function evaluateAlerts() {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });

  for (const rule of rules) {
    const condition = rule.condition as unknown as AlertCondition;
    const channels  = rule.channels  as unknown as AlertChannel[];
    const value = await getMetricValue(rule.metric, rule.connectionId);
    if (value === null) continue;

    if (evaluate(value, condition)) {
      const existing = await prisma.alertEvent.findFirst({
        where: { ruleId: rule.id, resolvedAt: null },
      });
      if (!existing) {
        const event = await prisma.alertEvent.create({ data: { ruleId: rule.id } });
        for (const ch of channels) {
          await dispatch(ch, `Alert: ${rule.metric} = ${value} (${condition.operator} ${condition.threshold})`);
        }
        console.log(`[alert] Fired event ${event.id} for rule ${rule.id}`);
      }
    } else {
      await prisma.alertEvent.updateMany({
        where: { ruleId: rule.id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
    }
  }
}
