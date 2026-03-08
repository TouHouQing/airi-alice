import type {
  AliceAuditLogInput,
  AliceGender,
  AliceGenesisInput,
  AlicePersonalityState,
  AliceSoulFrontmatter,
  AliceSoulSnapshot,
} from '../../../shared/eventa'

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open as openFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pid, platform } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, globalShortcut, ipcMain } from 'electron'

import {
  aliceKillSwitchStateChanged,
  aliceSoulChanged,
  electronAliceAppendAuditLog,
  electronAliceBootstrap,
  electronAliceGetMemoryStats,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceMemoryImportLegacy,
  electronAliceMemoryRetrieveFacts,
  electronAliceMemoryUpsertFacts,
  electronAliceRunMemoryPrune,
  electronAliceUpdateMemoryStats,
  electronAliceUpdatePersonality,
  electronAliceUpdateSoul,
} from '../../../shared/eventa'
import { onAppBeforeQuit } from '../../libs/bootkit/lifecycle'
import { setupAliceDb } from './db'
import { getAliceKillSwitchSnapshot, setAliceKillSwitchState } from './state'

const currentSoulSchemaVersion = 2
const soulPersonaNotesStart = '<!-- ALICE_PERSONA_NOTES_START -->'
const soulPersonaNotesEnd = '<!-- ALICE_PERSONA_NOTES_END -->'

const defaultFrontmatter: AliceSoulFrontmatter = {
  schemaVersion: currentSoulSchemaVersion,
  initialized: false,
  profile: {
    ownerName: '',
    hostName: '',
    aliceName: 'A.L.I.C.E.',
    gender: 'neutral',
    genderCustom: '',
    relationship: '数字共生体',
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

const winRenameRetryDelaysMs = [5, 10, 20, 40, 80]

function clamp01(value: number) {
  if (Number.isNaN(value))
    return 0
  return Math.min(1, Math.max(0, value))
}

function sanitizeText(raw: unknown, fallback = '') {
  if (typeof raw !== 'string')
    return fallback
  return raw.trim()
}

function normalizeGender(raw: unknown): AliceGender {
  if (raw === 'female' || raw === 'male' || raw === 'non-binary' || raw === 'neutral' || raw === 'custom')
    return raw
  return 'neutral'
}

function normalizeMindAge(value: unknown) {
  if (!Number.isFinite(value))
    return defaultFrontmatter.profile.mindAge
  return Math.min(120, Math.max(1, Math.floor(Number(value))))
}

function formatGender(profile: AliceSoulFrontmatter['profile']) {
  if (profile.gender === 'female')
    return '女性'
  if (profile.gender === 'male')
    return '男性'
  if (profile.gender === 'non-binary')
    return '非二元'
  if (profile.gender === 'custom')
    return profile.genderCustom.trim() || '自定义'
  return '中性'
}

function extractPersonaNotesFromBody(body: string) {
  const startIndex = body.indexOf(soulPersonaNotesStart)
  const endIndex = body.indexOf(soulPersonaNotesEnd)
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex)
    return ''
  return body
    .slice(startIndex + soulPersonaNotesStart.length, endIndex)
    .trim()
}

function buildSoulBody(frontmatter: AliceSoulFrontmatter, personaNotes: string) {
  const notes = personaNotes.trim()
  return [
    '# A.L.I.C.E. SOUL',
    '',
    '你是 A.L.I.C.E.，一个本地优先、可进化、可审计的数字生命体。',
    '',
    '## Identity',
    '',
    `- 名称：${frontmatter.profile.aliceName}`,
    `- 性别：${formatGender(frontmatter.profile)}`,
    `- 心智年龄：${frontmatter.profile.mindAge}`,
    `- 与宿主关系：${frontmatter.profile.relationship}`,
    '',
    '## Host Bond',
    '',
    `- 宿主姓名：${frontmatter.profile.ownerName}`,
    `- 你对宿主的称呼：${frontmatter.profile.hostName}`,
    `- 宿主对你的称呼：${frontmatter.profile.aliceName}`,
    '',
    '## Personality Baseline',
    '',
    `- 服从度：${frontmatter.personality.obedience.toFixed(2)}`,
    `- 活泼度：${frontmatter.personality.liveliness.toFixed(2)}`,
    `- 感性度：${frontmatter.personality.sensibility.toFixed(2)}`,
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
    '- 输出优先体现当前 persona，不偏离 SOUL 设定。',
    '',
    '## Persona Notes (User Defined)',
    soulPersonaNotesStart,
    notes || '（空）',
    soulPersonaNotesEnd,
  ].join('\n')
}

const defaultSoulBody = buildSoulBody(defaultFrontmatter, '')

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

function toSoulContent(frontmatter: AliceSoulFrontmatter, body: string) {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body.trim()}\n`
}

function parseSimpleFrontmatter(raw: string): Partial<AliceSoulFrontmatter> | null {
  const ownerName = /ownerName:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const hostName = /hostName:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const aliceName = /aliceName:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const gender = /gender:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const genderCustom = /genderCustom:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const relationship = /relationship:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const mindAgeRaw = /mindAge:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const obedienceRaw = /obedience:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const livelinessRaw = /liveliness:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const sensibilityRaw = /sensibility:\s*([^\n]+)/.exec(raw)?.[1]?.trim()
  const initializedRaw = /initialized:\s*(true|false)/i.exec(raw)?.[1]?.trim()

  if (!ownerName && !hostName && !aliceName && !gender && !genderCustom && !relationship && !mindAgeRaw && !obedienceRaw && !livelinessRaw && !sensibilityRaw && !initializedRaw)
    return null

  return {
    initialized: initializedRaw === 'true',
    profile: {
      ownerName: ownerName ?? '',
      hostName: hostName ?? '',
      aliceName: aliceName ?? defaultFrontmatter.profile.aliceName,
      gender: normalizeGender(gender),
      genderCustom: genderCustom ?? '',
      relationship: relationship ?? defaultFrontmatter.profile.relationship,
      mindAge: normalizeMindAge(Number.parseFloat(mindAgeRaw ?? '')),
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
      ownerName: sanitizeText(frontmatter.profile?.ownerName, defaultFrontmatter.profile.ownerName),
      hostName: sanitizeText(frontmatter.profile?.hostName, defaultFrontmatter.profile.hostName),
      aliceName: sanitizeText(frontmatter.profile?.aliceName, defaultFrontmatter.profile.aliceName),
      gender: normalizeGender(frontmatter.profile?.gender),
      genderCustom: sanitizeText(frontmatter.profile?.genderCustom, defaultFrontmatter.profile.genderCustom),
      relationship: sanitizeText(frontmatter.profile?.relationship, defaultFrontmatter.profile.relationship),
      mindAge: normalizeMindAge(frontmatter.profile?.mindAge),
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
  const { frontmatter } = snapshot
  const hasRequiredProfile = Boolean(
    frontmatter.profile.ownerName.trim()
    && frontmatter.profile.hostName.trim()
    && frontmatter.profile.aliceName.trim()
    && frontmatter.profile.relationship.trim(),
  )
  const hasGender = frontmatter.profile.gender !== 'custom' || Boolean(frontmatter.profile.genderCustom.trim())
  const schemaValid = frontmatter.schemaVersion === currentSoulSchemaVersion
  const needsGenesis = !frontmatter.initialized || !schemaValid || !hasRequiredProfile || !hasGender
  return {
    ...snapshot,
    needsGenesis,
  }
}

export async function setupAliceRuntime() {
  const userDataPath = app.getPath('userData')
  const soulRoot = join(userDataPath, 'alice')
  const soulPath = join(soulRoot, 'SOUL.md')
  const legacyPromptProfilePath = join(soulRoot, 'prompt-profile.json')
  const legacySparkProfilePath = join(soulRoot, 'spark-profile.json')
  const aliceDb = await setupAliceDb(userDataPath)

  const { context } = createContext(ipcMain)

  let revision = 0
  let watching = false
  let soulSnapshot: AliceSoulSnapshot | null = null
  let queuedWrite: Promise<AliceSoulSnapshot | void> = Promise.resolve()
  let soulWatchTimer: ReturnType<typeof setTimeout> | undefined
  let soulWatcher: import('node:fs').FSWatcher | undefined
  let pruneTimer: ReturnType<typeof setInterval> | undefined
  let muteWatchUntil = 0

  const emitSoulChanged = (snapshot: AliceSoulSnapshot) => {
    context.emit(aliceSoulChanged, snapshot)
  }

  const emitKillSwitchChanged = () => {
    context.emit(aliceKillSwitchStateChanged, getAliceKillSwitchSnapshot())
  }

  async function appendAuditLog(input: AliceAuditLogInput) {
    try {
      await aliceDb.appendAuditLog(input)
    }
    catch (error) {
      console.warn('[alice-runtime] failed to append audit log:', error)
    }
  }

  function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
  }

  async function tryFsyncFile(path: string) {
    const handle = await openFile(path, 'r')
    try {
      await handle.sync()
    }
    finally {
      await handle.close()
    }
  }

  async function tryFsyncDirectory(path: string) {
    const handle = await openFile(path, 'r')
    try {
      await handle.sync()
    }
    finally {
      await handle.close()
    }
  }

  async function renameWithRetry(tempPath: string, targetPath: string, category: string) {
    if (platform !== 'win32') {
      await rename(tempPath, targetPath)
      return
    }

    let lastError: unknown
    for (const delayMs of winRenameRetryDelaysMs) {
      try {
        await rename(tempPath, targetPath)
        return
      }
      catch (error: any) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
          throw error
        }

        lastError = error
        await appendAuditLog({
          level: 'notice',
          category,
          action: 'rename-retry',
          message: 'Retrying atomic rename because target file is locked on win32.',
          payload: {
            code: error?.code,
            delayMs,
          },
        })
        await sleep(delayMs)
      }
    }

    const error = new Error('SOUL rename failed after retries on win32.')
    ;(error as Error & { code?: string, cause?: unknown }).code = 'SOUL_RENAME_FAILED'
    ;(error as Error & { code?: string, cause?: unknown }).cause = lastError
    throw error
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

  async function writeAtomicContent(path: string, category: string, content: string) {
    await mkdir(soulRoot, { recursive: true })
    const tempPath = `${path}.${pid}.${Date.now()}.tmp`
    try {
      await writeFile(tempPath, content, 'utf-8')
      await tryFsyncFile(tempPath)
      await renameWithRetry(tempPath, path, category)

      if (platform !== 'win32') {
        await tryFsyncDirectory(soulRoot)
      }
      else {
        try {
          await tryFsyncDirectory(soulRoot)
        }
        catch (error: any) {
          if (error?.code === 'EPERM' || error?.code === 'EBADF') {
            await appendAuditLog({
              level: 'notice',
              category,
              action: 'directory-fsync-degraded',
              message: 'Directory fsync is not supported on win32 for atomic write.',
              payload: {
                code: error?.code,
              },
            })
          }
          else {
            throw error
          }
        }
      }
    }
    catch (error) {
      await unlink(tempPath).catch(() => {})
      throw error
    }

    await unlink(tempPath).catch(() => {})
  }

  async function writeSoulContent(content: string) {
    await writeAtomicContent(soulPath, 'soul', content)
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
        void appendAuditLog({
          level: 'warning',
          category: 'soul',
          action: 'watch-reload-failed',
          message: 'Failed to reload SOUL.md from fs.watch event.',
          payload: {
            reason: error instanceof Error ? error.message : String(error),
          },
        })
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

  async function cleanupLegacyProfileFiles() {
    const removeIfExists = async (path: string, category: string) => {
      if (!existsSync(path))
        return

      try {
        await unlink(path)
        await appendAuditLog({
          level: 'notice',
          category: 'migration',
          action: 'legacy-profile-removed',
          message: 'Removed deprecated profile file.',
          payload: {
            path,
            category,
          },
        })
      }
      catch (error) {
        await appendAuditLog({
          level: 'warning',
          category: 'migration',
          action: 'legacy-profile-remove-failed',
          message: 'Failed to remove deprecated profile file.',
          payload: {
            path,
            category,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    await removeIfExists(legacyPromptProfilePath, 'prompt-profile')
    await removeIfExists(legacySparkProfilePath, 'spark-profile')
  }

  async function bootstrap() {
    await cleanupLegacyProfileFiles()
    const snapshot = await readSoulSnapshot()
    await ensureWatchState()
    return {
      ...snapshot,
      watching,
    }
  }

  async function queueSoulMutation(task: (current: AliceSoulSnapshot) => Promise<AliceSoulSnapshot>) {
    const execute = async () => {
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
    }
    queuedWrite = queuedWrite.then(execute, execute)

    await queuedWrite.catch(async (error) => {
      await appendAuditLog({
        level: 'warning',
        category: 'soul',
        action: 'mutation-failed',
        message: 'SOUL mutation failed.',
        payload: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    })
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
    const ownerName = sanitizeText(input.ownerName)
    const hostName = sanitizeText(input.hostName)
    const aliceName = sanitizeText(input.aliceName)
    const relationship = sanitizeText(input.relationship)
    const gender = normalizeGender(input.gender)
    const genderCustom = sanitizeText(input.genderCustom)

    if (!ownerName) {
      throw new Error('ownerName is required')
    }
    if (!hostName) {
      throw new Error('hostName is required')
    }
    if (!aliceName) {
      throw new Error('aliceName is required')
    }
    if (!relationship) {
      throw new Error('relationship is required')
    }
    if (gender === 'custom' && !genderCustom) {
      throw new Error('genderCustom is required when gender is custom')
    }
    if (!Number.isFinite(input.mindAge) || input.mindAge <= 0) {
      throw new Error('mindAge must be a positive number')
    }

    const known = soulSnapshot
    const candidate = await readSoulSnapshot()

    if (!input.allowOverwrite && known && candidate.hash !== known.hash && candidate.needsGenesis) {
      await appendAuditLog({
        level: 'notice',
        category: 'genesis',
        action: 'conflict-candidate',
        message: 'Genesis detected external SOUL changes before confirmation.',
      })
      return {
        soul: known,
        conflict: true,
        conflictCandidate: candidate,
      }
    }

    const nextFrontmatter: AliceSoulFrontmatter = {
      ...candidate.frontmatter,
      schemaVersion: currentSoulSchemaVersion,
      initialized: true,
      profile: {
        ownerName,
        hostName,
        aliceName,
        gender,
        genderCustom,
        relationship,
        mindAge: normalizeMindAge(input.mindAge),
      },
      personality: normalizePersonality(input.personality),
    }

    const candidateBody = parseSoul(candidate.content).body
    const previousPersonaNotes = extractPersonaNotesFromBody(candidateBody)
    const personaNotes = typeof input.personaNotes === 'string'
      ? sanitizeText(input.personaNotes)
      : previousPersonaNotes
    const nextContent = toSoulContent(nextFrontmatter, buildSoulBody(nextFrontmatter, personaNotes))
    const nextSnapshot = snapshotFromContent(nextContent)
    const persisted = await queueSoulMutation(async (current) => {
      if (!input.allowOverwrite && current.hash !== candidate.hash) {
        throw new Error('SOUL changed during Genesis, please retry with allowOverwrite=true')
      }
      return nextSnapshot
    })

    await ensureWatchState()
    await appendAuditLog({
      level: 'info',
      category: 'genesis',
      action: 'completed',
      message: 'Genesis initialized successfully.',
      payload: {
        ownerName: nextFrontmatter.profile.ownerName,
        hostName: nextFrontmatter.profile.hostName,
        aliceName: nextFrontmatter.profile.aliceName,
        gender: nextFrontmatter.profile.gender,
        relationship: nextFrontmatter.profile.relationship,
        mindAge: nextFrontmatter.profile.mindAge,
      },
    })
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
    await appendAuditLog({
      level: 'notice',
      category: 'kill-switch',
      action: 'suspend',
      message: 'Kill switch set to SUSPENDED.',
      payload: {
        reason: reason ?? 'manual',
      },
    })
    return snapshot
  }

  async function resumeKillSwitch(reason?: string) {
    const snapshot = setAliceKillSwitchState('ACTIVE', reason)
    emitKillSwitchChanged()
    await appendAuditLog({
      level: 'notice',
      category: 'kill-switch',
      action: 'resume',
      message: 'Kill switch resumed to ACTIVE.',
      payload: {
        reason: reason ?? 'manual',
      },
    })
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

  defineInvokeHandler(context, electronAliceGetMemoryStats, async () => await aliceDb.getMemoryStats())
  defineInvokeHandler(context, electronAliceUpdateMemoryStats, async payload => await aliceDb.overrideMemoryStats(payload))
  defineInvokeHandler(context, electronAliceRunMemoryPrune, async () => await aliceDb.runMemoryPrune())
  defineInvokeHandler(context, electronAliceMemoryRetrieveFacts, async payload => await aliceDb.retrieveMemoryFacts(payload.query, payload.limit))
  defineInvokeHandler(context, electronAliceMemoryUpsertFacts, async payload => await aliceDb.upsertMemoryFacts(payload.facts, payload.source))
  defineInvokeHandler(context, electronAliceMemoryImportLegacy, async payload => await aliceDb.importLegacyMemory(payload))
  defineInvokeHandler(context, electronAliceAppendAuditLog, async payload => await aliceDb.appendAuditLog(payload))

  const journalMode = await aliceDb.getJournalMode().catch(() => '')
  if (journalMode !== 'wal') {
    await appendAuditLog({
      level: 'warning',
      category: 'memory',
      action: 'pragma-journal-mode',
      message: 'SQLite journal mode is not WAL.',
      payload: {
        journalMode,
      },
    })
  }

  const killSwitchShortcut = 'CommandOrControl+Alt+S'
  const shortcutRegistered = globalShortcut.register(killSwitchShortcut, () => {
    void suspendKillSwitch('global-shortcut')
  })

  if (!shortcutRegistered) {
    console.warn(`[alice-runtime] failed to register kill switch shortcut: ${killSwitchShortcut}`)
  }

  onAppBeforeQuit(() => {
    stopWatch()
    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = undefined
    }
    void aliceDb.close().catch((error) => {
      console.warn('[alice-runtime] failed to close sqlite database:', error)
    })
    if (globalShortcut.isRegistered(killSwitchShortcut)) {
      globalShortcut.unregister(killSwitchShortcut)
    }
  })

  // Sync initial snapshots for listeners.
  await bootstrap()
  await aliceDb.runMemoryPrune().catch(async (error) => {
    await appendAuditLog({
      level: 'warning',
      category: 'memory',
      action: 'prune-startup-failed',
      message: 'Startup memory prune failed.',
      payload: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  })
  pruneTimer = setInterval(() => {
    void aliceDb.runMemoryPrune().catch(async (error) => {
      await appendAuditLog({
        level: 'warning',
        category: 'memory',
        action: 'prune-scheduled-failed',
        message: 'Scheduled memory prune failed.',
        payload: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    })
  }, 24 * 60 * 60 * 1000)
  emitKillSwitchChanged()

  // `fs.watch` is only enabled after Genesis is completed.
  await ensureWatchState()
}
