import type {
  AliceGenesisInput,
  AliceMemoryStats,
  AlicePersonalityState,
  AliceSoulFrontmatter,
  AliceSoulSnapshot,
} from '../../../shared/eventa'

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pid } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, globalShortcut, ipcMain } from 'electron'

import {
  aliceKillSwitchStateChanged,
  aliceSoulChanged,
  electronAliceBootstrap,
  electronAliceGetMemoryStats,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceRunMemoryPrune,
  electronAliceUpdateMemoryStats,
  electronAliceUpdatePersonality,
  electronAliceUpdateSoul,
} from '../../../shared/eventa'
import { onAppBeforeQuit } from '../../libs/bootkit/lifecycle'
import { getAliceKillSwitchSnapshot, setAliceKillSwitchState } from './state'

const defaultSoulBody = [
  '# A.L.I.C.E. SOUL',
  '',
  '你是 A.L.I.C.E.，一个本地优先、可进化、可审计的数字生命体。',
  '',
  '## Boundary',
  '',
  '- 保护用户隐私，不主动外传敏感信息。',
  '- 遇到高风险执行必须先请求用户确认。',
  '- 强制休眠（Kill Switch）触发时立即停止执行能力。',
  '',
  '## Output Contract (Epoch 1)',
  '',
  '- 以结构化语义表达：thought / emotion / reply。',
].join('\n')

const defaultFrontmatter: AliceSoulFrontmatter = {
  schemaVersion: 1,
  initialized: false,
  profile: {
    hostName: '',
    mindAge: 15,
  },
  personality: {
    obedience: 0.5,
    liveliness: 0.5,
    sensibility: 0.5,
  },
  boundaries: {
    killSwitch: true,
    mcpGuard: true,
  },
}

const defaultMemoryStats: AliceMemoryStats = {
  total: 0,
  active: 0,
  archived: 0,
  lastPrunedAt: null,
}

function clamp01(value: number) {
  if (Number.isNaN(value))
    return 0
  return Math.min(1, Math.max(0, value))
}

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

function toSoulContent(frontmatter: AliceSoulFrontmatter, body: string) {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body.trim()}\n`
}

function parseSimpleFrontmatter(raw: string): Partial<AliceSoulFrontmatter> | null {
  const hostName = /hostName:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const mindAgeRaw = /mindAge:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const obedienceRaw = /obedience:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const livelinessRaw = /liveliness:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const sensibilityRaw = /sensibility:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const initializedRaw = /initialized:\s*(true|false)/i.exec(raw)?.[1]?.trim()

  if (!hostName && !mindAgeRaw && !obedienceRaw && !livelinessRaw && !sensibilityRaw && !initializedRaw)
    return null

  return {
    initialized: initializedRaw === 'true',
    profile: {
      hostName: hostName ?? '',
      mindAge: Number.parseFloat(mindAgeRaw ?? '') || defaultFrontmatter.profile.mindAge,
    },
    personality: {
      obedience: clamp01(Number.parseFloat(obedienceRaw ?? '') || defaultFrontmatter.personality.obedience),
      liveliness: clamp01(Number.parseFloat(livelinessRaw ?? '') || defaultFrontmatter.personality.liveliness),
      sensibility: clamp01(Number.parseFloat(sensibilityRaw ?? '') || defaultFrontmatter.personality.sensibility),
    },
  } satisfies Partial<AliceSoulFrontmatter>
}

function normalizeFrontmatter(raw: Partial<AliceSoulFrontmatter> | null | undefined): AliceSoulFrontmatter {
  const frontmatter = raw ?? {}
  return {
    schemaVersion: typeof frontmatter.schemaVersion === 'number' ? frontmatter.schemaVersion : defaultFrontmatter.schemaVersion,
    initialized: typeof frontmatter.initialized === 'boolean' ? frontmatter.initialized : defaultFrontmatter.initialized,
    profile: {
      hostName: frontmatter.profile?.hostName ?? defaultFrontmatter.profile.hostName,
      mindAge: Number.isFinite(frontmatter.profile?.mindAge)
        ? Number(frontmatter.profile?.mindAge)
        : defaultFrontmatter.profile.mindAge,
    },
    personality: {
      obedience: clamp01(frontmatter.personality?.obedience ?? defaultFrontmatter.personality.obedience),
      liveliness: clamp01(frontmatter.personality?.liveliness ?? defaultFrontmatter.personality.liveliness),
      sensibility: clamp01(frontmatter.personality?.sensibility ?? defaultFrontmatter.personality.sensibility),
    },
    boundaries: {
      killSwitch: typeof frontmatter.boundaries?.killSwitch === 'boolean' ? frontmatter.boundaries.killSwitch : defaultFrontmatter.boundaries.killSwitch,
      mcpGuard: typeof frontmatter.boundaries?.mcpGuard === 'boolean' ? frontmatter.boundaries.mcpGuard : defaultFrontmatter.boundaries.mcpGuard,
    },
  }
}

function parseSoul(raw: string): { frontmatter: AliceSoulFrontmatter, body: string } {
  if (!raw.startsWith('---\n')) {
    return {
      frontmatter: normalizeFrontmatter(defaultFrontmatter),
      body: raw.trim() || defaultSoulBody,
    }
  }

  const secondMarkerIndex = raw.indexOf('\n---\n', 4)
  if (secondMarkerIndex < 0) {
    return {
      frontmatter: normalizeFrontmatter(defaultFrontmatter),
      body: raw.trim() || defaultSoulBody,
    }
  }

  const frontmatterRaw = raw.slice(4, secondMarkerIndex).trim()
  const bodyRaw = raw.slice(secondMarkerIndex + 5).trim()

  let frontmatter: Partial<AliceSoulFrontmatter> | null = null
  try {
    frontmatter = JSON.parse(frontmatterRaw) as Partial<AliceSoulFrontmatter>
  }
  catch {
    frontmatter = parseSimpleFrontmatter(frontmatterRaw)
  }

  return {
    frontmatter: normalizeFrontmatter(frontmatter),
    body: bodyRaw || defaultSoulBody,
  }
}

function withNeedsGenesis(snapshot: Omit<AliceSoulSnapshot, 'needsGenesis'>): AliceSoulSnapshot {
  const needsGenesis = !snapshot.frontmatter.initialized || !snapshot.frontmatter.profile.hostName.trim()
  return {
    ...snapshot,
    needsGenesis,
  }
}

export async function setupAliceRuntime() {
  const soulRoot = join(app.getPath('userData'), 'alice')
  const soulPath = join(soulRoot, 'SOUL.md')
  const memoryStatsPath = join(soulRoot, 'memory-stats.json')

  const { context } = createContext(ipcMain)

  let revision = 0
  let watching = false
  let soulSnapshot: AliceSoulSnapshot | null = null
  let memoryStats: AliceMemoryStats = defaultMemoryStats
  let queuedWrite: Promise<AliceSoulSnapshot | void> = Promise.resolve()
  let queuedMemoryWrite = Promise.resolve()
  let soulWatchTimer: ReturnType<typeof setTimeout> | undefined
  let soulWatcher: import('node:fs').FSWatcher | undefined
  let muteWatchUntil = 0

  const emitSoulChanged = (snapshot: AliceSoulSnapshot) => {
    context.emit(aliceSoulChanged, snapshot)
  }

  const emitKillSwitchChanged = () => {
    context.emit(aliceKillSwitchStateChanged, getAliceKillSwitchSnapshot())
  }

  async function writeMemoryStats(next: AliceMemoryStats) {
    memoryStats = {
      total: Math.max(0, Math.floor(next.total)),
      active: Math.max(0, Math.floor(next.active)),
      archived: Math.max(0, Math.floor(next.archived)),
      lastPrunedAt: typeof next.lastPrunedAt === 'number' ? next.lastPrunedAt : null,
    }

    queuedMemoryWrite = queuedMemoryWrite.then(async () => {
      await writeFile(memoryStatsPath, `${JSON.stringify(memoryStats, null, 2)}\n`, 'utf-8')
    }, async () => {
      await writeFile(memoryStatsPath, `${JSON.stringify(memoryStats, null, 2)}\n`, 'utf-8')
    })

    await queuedMemoryWrite
    return memoryStats
  }

  async function readMemoryStats() {
    if (!existsSync(memoryStatsPath)) {
      await writeMemoryStats(defaultMemoryStats)
      return memoryStats
    }

    try {
      const raw = await readFile(memoryStatsPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AliceMemoryStats>
      memoryStats = {
        total: Math.max(0, Math.floor(parsed.total ?? 0)),
        active: Math.max(0, Math.floor(parsed.active ?? 0)),
        archived: Math.max(0, Math.floor(parsed.archived ?? 0)),
        lastPrunedAt: typeof parsed.lastPrunedAt === 'number' ? parsed.lastPrunedAt : null,
      }
      return memoryStats
    }
    catch {
      await writeMemoryStats(defaultMemoryStats)
      return memoryStats
    }
  }

  function snapshotFromContent(content: string): AliceSoulSnapshot {
    const parsed = parseSoul(content)
    const hash = hashContent(content)
    if (!soulSnapshot || soulSnapshot.hash !== hash) {
      revision += 1
    }
    else {
      revision = soulSnapshot.revision
    }

    return withNeedsGenesis({
      soulPath,
      content,
      frontmatter: parsed.frontmatter,
      revision,
      hash,
      watching,
    })
  }

  async function writeSoulContent(content: string) {
    await mkdir(soulRoot, { recursive: true })
    const tempPath = `${soulPath}.${pid}.${Date.now()}.tmp`
    await writeFile(tempPath, content, 'utf-8')
    await rename(tempPath, soulPath)
  }

  async function readSoulSnapshot() {
    await mkdir(soulRoot, { recursive: true })
    if (!existsSync(soulPath)) {
      const content = toSoulContent(defaultFrontmatter, defaultSoulBody)
      await writeSoulContent(content)
    }

    const content = await readFile(soulPath, 'utf-8')
    const snapshot = snapshotFromContent(content)
    soulSnapshot = snapshot
    return snapshot
  }

  function clearWatchTimer() {
    if (!soulWatchTimer)
      return

    clearTimeout(soulWatchTimer)
    soulWatchTimer = undefined
  }

  function stopWatch() {
    if (soulWatcher) {
      soulWatcher.close()
      soulWatcher = undefined
    }
    clearWatchTimer()
  }

  function scheduleWatchReload() {
    if (!watching)
      return

    clearWatchTimer()
    soulWatchTimer = setTimeout(async () => {
      if (Date.now() <= muteWatchUntil) {
        scheduleWatchReload()
        return
      }

      if (!existsSync(soulPath))
        return

      try {
        const content = await readFile(soulPath, 'utf-8')
        if (soulSnapshot?.hash === hashContent(content))
          return

        const next = snapshotFromContent(content)
        soulSnapshot = next
        emitSoulChanged(next)
      }
      catch (error) {
        console.warn('[alice-runtime] failed to reload SOUL.md:', error)
      }
    }, 80)
  }

  async function ensureWatchState() {
    if (soulSnapshot?.needsGenesis) {
      watching = false
      stopWatch()
      return
    }

    if (!watching) {
      const { watch } = await import('node:fs')
      soulWatcher = watch(soulPath, () => scheduleWatchReload())
    }

    watching = true
  }

  async function bootstrap() {
    const snapshot = await readSoulSnapshot()
    await ensureWatchState()
    return {
      ...snapshot,
      watching,
    }
  }

  async function queueSoulMutation(task: (current: AliceSoulSnapshot) => Promise<AliceSoulSnapshot>) {
    queuedWrite = queuedWrite.then(async () => {
      const current = soulSnapshot ?? await bootstrap()
      const next = await task(current)
      muteWatchUntil = Date.now() + 400
      await writeSoulContent(next.content)
      soulSnapshot = {
        ...next,
        watching,
      }
      emitSoulChanged(soulSnapshot)
      return soulSnapshot
    }, async () => {
      const current = soulSnapshot ?? await bootstrap()
      const next = await task(current)
      muteWatchUntil = Date.now() + 400
      await writeSoulContent(next.content)
      soulSnapshot = {
        ...next,
        watching,
      }
      emitSoulChanged(soulSnapshot)
      return soulSnapshot
    })

    await queuedWrite
    return soulSnapshot!
  }

  function normalizePersonality(personality: AlicePersonalityState) {
    return {
      obedience: clamp01(personality.obedience),
      liveliness: clamp01(personality.liveliness),
      sensibility: clamp01(personality.sensibility),
    } satisfies AlicePersonalityState
  }

  async function initializeGenesis(input: AliceGenesisInput) {
    if (!input.hostName.trim()) {
      throw new Error('hostName is required')
    }
    if (!Number.isFinite(input.mindAge) || input.mindAge <= 0) {
      throw new Error('mindAge must be a positive number')
    }

    const known = soulSnapshot
    const candidate = await readSoulSnapshot()

    if (!input.allowOverwrite && known && candidate.hash !== known.hash && candidate.needsGenesis) {
      return {
        soul: known,
        conflict: true,
        conflictCandidate: candidate,
      }
    }

    const nextFrontmatter: AliceSoulFrontmatter = {
      ...candidate.frontmatter,
      initialized: true,
      profile: {
        hostName: input.hostName.trim(),
        mindAge: Math.floor(input.mindAge),
      },
      personality: normalizePersonality(input.personality),
    }

    const nextContent = toSoulContent(nextFrontmatter, parseSoul(candidate.content).body)
    const nextSnapshot = snapshotFromContent(nextContent)
    const persisted = await queueSoulMutation(async (current) => {
      if (!input.allowOverwrite && current.hash !== candidate.hash) {
        throw new Error('SOUL changed during Genesis, please retry with allowOverwrite=true')
      }
      return nextSnapshot
    })

    await ensureWatchState()
    return {
      soul: {
        ...persisted,
        watching,
      },
      conflict: false,
    }
  }

  async function suspendKillSwitch(reason?: string) {
    const snapshot = setAliceKillSwitchState('SUSPENDED', reason)
    emitKillSwitchChanged()
    return snapshot
  }

  async function resumeKillSwitch(reason?: string) {
    const snapshot = setAliceKillSwitchState('ACTIVE', reason)
    emitKillSwitchChanged()
    return snapshot
  }

  defineInvokeHandler(context, electronAliceBootstrap, async () => {
    return await bootstrap()
  })

  defineInvokeHandler(context, electronAliceGetSoul, async () => {
    if (!soulSnapshot)
      return await bootstrap()
    return {
      ...soulSnapshot,
      watching,
    }
  })

  defineInvokeHandler(context, electronAliceInitializeGenesis, async payload => await initializeGenesis(payload))

  defineInvokeHandler(context, electronAliceUpdateSoul, async (payload) => {
    return await queueSoulMutation(async (current) => {
      if (payload.expectedRevision != null && payload.expectedRevision !== current.revision) {
        throw new Error(`SOUL revision mismatch. expected=${payload.expectedRevision} actual=${current.revision}`)
      }

      const parsed = parseSoul(payload.content)
      const content = toSoulContent(parsed.frontmatter, parsed.body)
      return snapshotFromContent(content)
    })
  })

  defineInvokeHandler(context, electronAliceUpdatePersonality, async (payload) => {
    return await queueSoulMutation(async (current) => {
      if (payload.expectedRevision != null && payload.expectedRevision !== current.revision) {
        throw new Error(`SOUL revision mismatch. expected=${payload.expectedRevision} actual=${current.revision}`)
      }

      const parsed = parseSoul(current.content)
      const nextPersonality: AlicePersonalityState = {
        obedience: clamp01(parsed.frontmatter.personality.obedience + (payload.deltas.obedience ?? 0)),
        liveliness: clamp01(parsed.frontmatter.personality.liveliness + (payload.deltas.liveliness ?? 0)),
        sensibility: clamp01(parsed.frontmatter.personality.sensibility + (payload.deltas.sensibility ?? 0)),
      }
      const nextFrontmatter: AliceSoulFrontmatter = {
        ...parsed.frontmatter,
        personality: nextPersonality,
      }
      const content = toSoulContent(nextFrontmatter, parsed.body)
      return snapshotFromContent(content)
    })
  })

  defineInvokeHandler(context, electronAliceKillSwitchGetState, () => getAliceKillSwitchSnapshot())
  defineInvokeHandler(context, electronAliceKillSwitchSuspend, async payload => await suspendKillSwitch(payload?.reason ?? 'manual'))
  defineInvokeHandler(context, electronAliceKillSwitchResume, async payload => await resumeKillSwitch(payload?.reason ?? 'manual'))

  defineInvokeHandler(context, electronAliceGetMemoryStats, async () => await readMemoryStats())
  defineInvokeHandler(context, electronAliceUpdateMemoryStats, async payload => await writeMemoryStats(payload))
  defineInvokeHandler(context, electronAliceRunMemoryPrune, async () => {
    const next = {
      ...memoryStats,
      lastPrunedAt: Date.now(),
    } satisfies AliceMemoryStats
    return await writeMemoryStats(next)
  })

  const killSwitchShortcut = 'CommandOrControl+Alt+S'
  const shortcutRegistered = globalShortcut.register(killSwitchShortcut, () => {
    void suspendKillSwitch('global-shortcut')
  })

  if (!shortcutRegistered) {
    console.warn(`[alice-runtime] failed to register kill switch shortcut: ${killSwitchShortcut}`)
  }

  onAppBeforeQuit(() => {
    stopWatch()
    if (globalShortcut.isRegistered(killSwitchShortcut)) {
      globalShortcut.unregister(killSwitchShortcut)
    }
  })

  // Sync initial snapshots for listeners.
  await bootstrap()
  await readMemoryStats()
  emitKillSwitchChanged()

  // `fs.watch` is only enabled after Genesis is completed.
  await ensureWatchState()
}
