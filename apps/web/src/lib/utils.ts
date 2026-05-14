import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(date))
}

export function humanCron(expr: string): string {
  const parts = expr.trim().split(' ')
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts
  if (min === '0' && dom === '*' && month === '*' && dow === '*') {
    return `Every day at ${hour}:00`
  }
  if (min === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every hour'
  }
  return expr
}
