import type { AliceAuditLogInput, AliceSensoryCacheSnapshot, AliceSystemProbeDegradeReason, AliceSystemProbeSample } from '../../../shared/eventa'

import os from 'node:os'

const defaultTickMs = 60_000
const defaultStaleMs = 90_000
const defaultCpuWindowMs = 1_000

interface CpuSnapshot {
  idle: number
  total: number
}

interface AliceSensoryBusOptions {
  tickMs?: number
  staleMs?: number
  cpuWindowMs?: number
  appendAuditLog: (input: AliceAuditLogInput) => Promise<void>
}

interface AliceSensoryBus {
  start: () => void
  stop: (reason?: 'kill-switch' | 'shutdown' | 'manual') => void
  refreshNow: () => Promise<AliceSystemProbeSample>
  getSnapshot: () => AliceSensoryCacheSnapshot
}

function clampPercent(value: number) {
  if (!Number.isFinite(value))
    return 0
  return Math.max(0, Math.min(100, value))
}

function readCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus()
  let idle = 0
  let total = 0

  for (const cpu of cpus) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.irq + times.idle
  }

  return {
    idle,
    total,
  }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function measureCpuUsage(windowMs: number) {
  const start = readCpuSnapshot()
  await sleep(windowMs)
  const end = readCpuSnapshot()
  const idleDelta = end.idle - start.idle
  const totalDelta = end.total - start.total

  if (totalDelta <= 0)
    return 0

  return clampPercent((1 - idleDelta / totalDelta) * 100)
}

function createEmptySample() {
  const now = new Date()
  return {
    collectedAt: now.getTime(),
    time: {
      iso: now.toISOString(),
      local: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    cpu: {
      usagePercent: 0,
      windowMs: defaultCpuWindowMs,
    },
    memory: {
      freeMB: 0,
      totalMB: 0,
      usagePercent: 0,
    },
    degraded: ['battery-unavailable', 'cpu-unavailable', 'memory-unavailable'],
  } satisfies AliceSystemProbeSample
}

export function createAliceSensoryBus(options: AliceSensoryBusOptions): AliceSensoryBus {
  const tickMs = Math.max(5_000, Math.floor(options.tickMs ?? defaultTickMs))
  const staleMs = Math.max(10_000, Math.floor(options.staleMs ?? defaultStaleMs))
  const cpuWindowMs = Math.max(200, Math.floor(options.cpuWindowMs ?? defaultCpuWindowMs))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let nextTickAt: number | null = null
  let cache: AliceSystemProbeSample = createEmptySample()
  let pendingRefresh: Promise<AliceSystemProbeSample> | null = null

  async function appendWarning(action: string, message: string, payload?: Record<string, unknown>) {
    await options.appendAuditLog({
      level: 'warning',
      category: 'alice.sensory',
      action,
      message,
      payload,
    }).catch(() => {})
  }

  async function sampleOnce() {
    const now = Date.now()
    const degraded = new Set<AliceSystemProbeDegradeReason>()

    const sample: AliceSystemProbeSample = {
      collectedAt: now,
      time: {
        iso: new Date(now).toISOString(),
        local: new Date(now).toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      cpu: {
        usagePercent: 0,
        windowMs: cpuWindowMs,
      },
      memory: {
        freeMB: 0,
        totalMB: 0,
        usagePercent: 0,
      },
    }

    try {
      const total = os.totalmem()
      const free = os.freemem()
      const used = Math.max(0, total - free)
      sample.memory = {
        totalMB: Math.round(total / (1024 * 1024)),
        freeMB: Math.round(free / (1024 * 1024)),
        usagePercent: total > 0 ? clampPercent((used / total) * 100) : 0,
      }
    }
    catch (error) {
      degraded.add('memory-unavailable')
      await appendWarning('sample-memory-failed', 'Failed to sample memory telemetry.', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    try {
      sample.cpu = {
        usagePercent: await measureCpuUsage(cpuWindowMs),
        windowMs: cpuWindowMs,
      }
    }
    catch (error) {
      degraded.add('cpu-unavailable')
      await appendWarning('sample-cpu-failed', 'Failed to sample CPU telemetry.', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    degraded.add('battery-unavailable')
    if (degraded.size > 0)
      sample.degraded = [...degraded]

    cache = sample
    return sample
  }

  async function refreshNow() {
    if (pendingRefresh)
      return await pendingRefresh

    pendingRefresh = sampleOnce().finally(() => {
      pendingRefresh = null
    })
    return await pendingRefresh
  }

  function scheduleTick() {
    nextTickAt = Date.now() + tickMs
  }

  function start() {
    if (running)
      return

    running = true
    scheduleTick()
    void refreshNow()
    timer = setInterval(() => {
      scheduleTick()
      void refreshNow()
    }, tickMs)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    running = false
    nextTickAt = null
  }

  function getSnapshot(): AliceSensoryCacheSnapshot {
    const ageMs = Math.max(0, Date.now() - cache.collectedAt)
    return {
      sample: cache,
      stale: ageMs > staleMs,
      ageMs,
      nextTickAt,
      running,
    }
  }

  return {
    start,
    stop,
    refreshNow,
    getSnapshot,
  }
}
