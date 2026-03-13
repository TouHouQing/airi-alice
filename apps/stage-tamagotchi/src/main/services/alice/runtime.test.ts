import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  aliceDialogueResponded,
  electronAliceAppendConversationTurn,
  electronAliceBootstrap,
  electronAliceDeleteCardScope,
  electronAliceGetSensorySnapshot,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceUpdatePersonality,
  electronAliceUpdateSoul,
} from '../../../shared/eventa'
import { setAliceKillSwitchState } from './state'

const invokeHandlers = new Map<unknown, (payload?: any) => Promise<any>>()
const sandboxDirs: string[] = []
const contextEmitMock = vi.fn()
const metaStore = new Map<string, string>()

const dbStub = {
  dbPath: '',
  close: vi.fn().mockResolvedValue(undefined),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
  appendConversationTurn: vi.fn().mockResolvedValue(undefined),
  getMemoryStats: vi.fn().mockResolvedValue({
    total: 0,
    active: 0,
    archived: 0,
    lastPrunedAt: null,
  }),
  upsertMemoryFacts: vi.fn().mockResolvedValue(undefined),
  retrieveMemoryFacts: vi.fn().mockResolvedValue([]),
  runMemoryPrune: vi.fn().mockResolvedValue({
    total: 0,
    active: 0,
    archived: 0,
    lastPrunedAt: null,
  }),
  importLegacyMemory: vi.fn().mockResolvedValue({
    migrated: false,
    importedFacts: 0,
    importedArchive: 0,
    marker: 'legacy_memory_migrated_v1',
  }),
  overrideMemoryStats: vi.fn().mockResolvedValue({
    total: 0,
    active: 0,
    archived: 0,
    lastPrunedAt: null,
  }),
  getJournalMode: vi.fn().mockResolvedValue('wal'),
  getMetaValue: vi.fn(async (key: string) => metaStore.get(key)),
  setMetaValue: vi.fn(async (key: string, value: string) => {
    metaStore.set(key, value)
  }),
}

vi.mock('@moeru/eventa', () => ({
  defineEventa: (name: string) => ({ name }),
  defineInvokeEventa: (name: string) => ({ name }),
  defineInvokeHandler: (_context: unknown, event: unknown, handler: (payload?: any) => Promise<any>) => {
    invokeHandlers.set(event, handler)
  },
}))

vi.mock('@moeru/eventa/adapters/electron/main', () => ({
  createContext: () => ({
    context: {
      emit: contextEmitMock,
    },
  }),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/airi-runtime-should-not-be-used'),
  },
  globalShortcut: {
    register: vi.fn(() => true),
    isRegistered: vi.fn(() => false),
    unregister: vi.fn(),
  },
  ipcMain: {},
}))

vi.mock('../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

vi.mock('./db', () => ({
  setupAliceDb: vi.fn(async () => dbStub),
}))

const { setupAliceRuntime } = await import('./runtime')

async function createSandboxPath() {
  const dir = await mkdtemp(join(tmpdir(), 'alice-runtime-test-'))
  sandboxDirs.push(dir)
  return dir
}

function getDialogueRespondedEvents() {
  return contextEmitMock.mock.calls
    .filter(([event]) => event === aliceDialogueResponded)
    .map(([, payload]) => payload)
}

describe('alice runtime sandbox + genesis lifecycle', () => {
  beforeEach(() => {
    invokeHandlers.clear()
    vi.clearAllMocks()
    contextEmitMock.mockReset()
    metaStore.clear()
  })

  afterEach(async () => {
    while (sandboxDirs.length > 0) {
      const dir = sandboxDirs.pop()
      if (!dir)
        continue
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses userDataPathOverride and enables fs.watch only after genesis', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const bootstrap = invokeHandlers.get(electronAliceBootstrap)
    const getSoul = invokeHandlers.get(electronAliceGetSoul)
    const initializeGenesis = invokeHandlers.get(electronAliceInitializeGenesis)

    expect(bootstrap).toBeTypeOf('function')
    expect(getSoul).toBeTypeOf('function')
    expect(initializeGenesis).toBeTypeOf('function')

    const boot = await bootstrap!({ cardId: 'default' })
    expect(boot.soulPath.startsWith(sandboxPath)).toBe(true)
    expect(existsSync(join(sandboxPath, 'alicizations', 'cards', 'default', 'SOUL.md'))).toBe(true)
    expect(boot.needsGenesis).toBe(true)
    expect(boot.watching).toBe(false)

    await initializeGenesis!({
      ownerName: '测试主人',
      hostName: '主人',
      aliceName: 'A.L.I.C.E.',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.6,
        liveliness: 0.5,
        sensibility: 0.7,
      },
      personaNotes: '请保持克制和诚实。',
      allowOverwrite: true,
    })

    const afterGenesis = await getSoul!({ cardId: 'default' })
    expect(afterGenesis.soulPath.startsWith(sandboxPath)).toBe(true)
    expect(afterGenesis.needsGenesis).toBe(false)
    expect(afterGenesis.watching).toBe(true)
  })

  it('stops and resumes sensory polling with kill switch state', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const getSensorySnapshot = invokeHandlers.get(electronAliceGetSensorySnapshot)
    const suspend = invokeHandlers.get(electronAliceKillSwitchSuspend)
    const resume = invokeHandlers.get(electronAliceKillSwitchResume)

    expect(getSensorySnapshot).toBeTypeOf('function')
    expect(suspend).toBeTypeOf('function')
    expect(resume).toBeTypeOf('function')

    const activeSnapshot = await getSensorySnapshot!({ cardId: 'default' })
    expect(activeSnapshot.running).toBe(true)

    await suspend!({ cardId: 'default', reason: 'test' })
    const suspendedSnapshot = await getSensorySnapshot!({ cardId: 'default' })
    expect(suspendedSnapshot.running).toBe(false)

    await resume!({ cardId: 'default', reason: 'test' })
    const resumedSnapshot = await getSensorySnapshot!({ cardId: 'default' })
    expect(resumedSnapshot.running).toBe(true)
  })

  it('keeps SOUL personality baseline body lines in sync after updatePersonality', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const initializeGenesis = invokeHandlers.get(electronAliceInitializeGenesis)
    const updatePersonality = invokeHandlers.get(electronAliceUpdatePersonality)
    const getSoul = invokeHandlers.get(electronAliceGetSoul)

    expect(initializeGenesis).toBeTypeOf('function')
    expect(updatePersonality).toBeTypeOf('function')
    expect(getSoul).toBeTypeOf('function')

    await initializeGenesis!({
      ownerName: '测试主人',
      hostName: '主人',
      aliceName: 'A.L.I.C.E.',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.6,
        liveliness: 0.5,
        sensibility: 0.7,
      },
      personaNotes: '请保持克制和诚实。',
      allowOverwrite: true,
    })

    await updatePersonality!({
      reason: 'test-drift',
      deltas: {
        obedience: -0.2,
        liveliness: -0.3,
        sensibility: -0.1,
      },
    })

    const nextSoul = await getSoul!({ cardId: 'default' })
    expect(nextSoul.content).toContain(`- 服从度：${nextSoul.frontmatter.personality.obedience.toFixed(2)}`)
    expect(nextSoul.content).toContain(`- 活泼度：${nextSoul.frontmatter.personality.liveliness.toFixed(2)}`)
    expect(nextSoul.content).toContain(`- 感性度：${nextSoul.frontmatter.personality.sensibility.toFixed(2)}`)
  })

  it('enforces personality baseline sync when updateSoul writes conflicting body text', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const initializeGenesis = invokeHandlers.get(electronAliceInitializeGenesis)
    const updateSoul = invokeHandlers.get(electronAliceUpdateSoul)
    const getSoul = invokeHandlers.get(electronAliceGetSoul)
    expect(initializeGenesis).toBeTypeOf('function')
    expect(updateSoul).toBeTypeOf('function')
    expect(getSoul).toBeTypeOf('function')

    await initializeGenesis!({
      ownerName: '测试主人',
      hostName: '主人',
      aliceName: 'A.L.I.C.E.',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.11,
        liveliness: 0.22,
        sensibility: 0.33,
      },
      personaNotes: '请保持克制和诚实。',
      allowOverwrite: true,
    })

    const currentSoul = await getSoul!({ cardId: 'default' })
    const nextContent = currentSoul.content
      .replace(/- 服从度：[0-9.]+/u, '- 服从度：0.99')
      .replace(/- 活泼度：[0-9.]+/u, '- 活泼度：0.99')
      .replace(/- 感性度：[0-9.]+/u, '- 感性度：0.99')

    await updateSoul!({
      cardId: 'default',
      content: nextContent,
    })

    const synced = await getSoul!({ cardId: 'default' })
    expect(synced.content).toContain(`- 服从度：${synced.frontmatter.personality.obedience.toFixed(2)}`)
    expect(synced.content).toContain(`- 活泼度：${synced.frontmatter.personality.liveliness.toFixed(2)}`)
    expect(synced.content).toContain(`- 感性度：${synced.frontmatter.personality.sensibility.toFixed(2)}`)
  })

  it('isolates SOUL state across card scopes', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const initializeGenesis = invokeHandlers.get(electronAliceInitializeGenesis)
    const getSoul = invokeHandlers.get(electronAliceGetSoul)
    expect(initializeGenesis).toBeTypeOf('function')
    expect(getSoul).toBeTypeOf('function')

    await initializeGenesis!({
      cardId: 'card-a',
      ownerName: '主人A',
      hostName: 'A',
      aliceName: 'Alice-A',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.6,
        liveliness: 0.5,
        sensibility: 0.7,
      },
      personaNotes: 'A notes',
      allowOverwrite: true,
    })

    await initializeGenesis!({
      cardId: 'card-b',
      ownerName: '主人B',
      hostName: 'B',
      aliceName: 'Alice-B',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.3,
        liveliness: 0.2,
        sensibility: 0.4,
      },
      personaNotes: 'B notes',
      allowOverwrite: true,
    })

    const soulA = await getSoul!({ cardId: 'card-a' })
    const soulB = await getSoul!({ cardId: 'card-b' })

    expect(soulA.frontmatter.profile.aliceName).toBe('Alice-A')
    expect(soulB.frontmatter.profile.aliceName).toBe('Alice-B')
    expect(soulA.soulPath).toContain('/alicizations/cards/card-a/')
    expect(soulB.soulPath).toContain('/alicizations/cards/card-b/')
  })

  it('deletes card scoped filesystem data when delete scope is invoked', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const initializeGenesis = invokeHandlers.get(electronAliceInitializeGenesis)
    const deleteCardScope = invokeHandlers.get(electronAliceDeleteCardScope)
    const getSoul = invokeHandlers.get(electronAliceGetSoul)
    expect(initializeGenesis).toBeTypeOf('function')
    expect(deleteCardScope).toBeTypeOf('function')
    expect(getSoul).toBeTypeOf('function')

    await initializeGenesis!({
      cardId: 'card-to-delete',
      ownerName: '删除测试',
      hostName: '删除测试',
      aliceName: 'Delete-Me',
      gender: 'female',
      relationship: '伙伴',
      mindAge: 18,
      personality: {
        obedience: 0.4,
        liveliness: 0.4,
        sensibility: 0.4,
      },
      personaNotes: 'to be deleted',
      allowOverwrite: true,
    })

    const scopedRoot = join(sandboxPath, 'alicizations', 'cards', 'card-to-delete')
    expect(existsSync(scopedRoot)).toBe(true)

    await deleteCardScope!({ cardId: 'card-to-delete' })
    expect(existsSync(scopedRoot)).toBe(false)

    const defaultSoul = await getSoul!({ cardId: 'default' })
    expect(defaultSoul.soulPath).toContain('/alicizations/cards/default/')
  })

  it('emits alice.dialogue.responded only after turn persistence succeeds', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const appendConversationTurn = invokeHandlers.get(electronAliceAppendConversationTurn)
    expect(appendConversationTurn).toBeTypeOf('function')

    await appendConversationTurn!({
      cardId: 'default',
      turnId: 'turn-test-1',
      sessionId: 'session-test',
      userText: '你好',
      assistantText: '你好，我在。',
      structured: {
        thought: 'respond politely',
        emotion: 'happy',
        reply: '你好，我在。',
        parsePath: 'json',
      },
      createdAt: Date.now(),
    })

    expect(dbStub.appendConversationTurn).toBeCalledTimes(1)
    expect(contextEmitMock).toBeCalledWith(aliceDialogueResponded, expect.objectContaining({
      cardId: 'default',
      turnId: 'turn-test-1',
      sessionId: 'session-test',
      isFallback: false,
    }))
  })

  it('normalizes unsupported emotion to neutral and preserves rawEmotion in dialogue event', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const appendConversationTurn = invokeHandlers.get(electronAliceAppendConversationTurn)
    expect(appendConversationTurn).toBeTypeOf('function')

    await appendConversationTurn!({
      cardId: 'default',
      turnId: 'turn-test-unsupported-emotion',
      sessionId: 'session-test',
      assistantText: '我在这里。',
      structured: {
        thought: 'stay calm',
        emotion: 'super-excited',
        reply: '我在这里。',
        parsePath: 'json',
      },
      createdAt: Date.now(),
    })

    const events = getDialogueRespondedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.structured.emotion).toBe('neutral')
    expect(events[0]?.structured.rawEmotion).toBe('super-excited')
  })

  it('does not emit alice.dialogue.responded when persistence fails', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const appendConversationTurn = invokeHandlers.get(electronAliceAppendConversationTurn)
    expect(appendConversationTurn).toBeTypeOf('function')

    dbStub.appendConversationTurn.mockRejectedValueOnce(new Error('sqlite write failed'))

    await expect(appendConversationTurn!({
      cardId: 'default',
      turnId: 'turn-test-db-fail',
      sessionId: 'session-test',
      assistantText: '不会写成功',
      structured: {
        thought: '',
        emotion: 'neutral',
        reply: '不会写成功',
        parsePath: 'json',
      },
      createdAt: Date.now(),
    })).rejects.toThrow('sqlite write failed')

    expect(getDialogueRespondedEvents()).toHaveLength(0)
  })

  it('does not emit alice.dialogue.responded when kill switch is already suspended', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const appendConversationTurn = invokeHandlers.get(electronAliceAppendConversationTurn)
    const suspend = invokeHandlers.get(electronAliceKillSwitchSuspend)
    expect(appendConversationTurn).toBeTypeOf('function')
    expect(suspend).toBeTypeOf('function')

    await suspend!({ cardId: 'default', reason: 'unit-test' })

    await appendConversationTurn!({
      cardId: 'default',
      turnId: 'turn-test-suspended',
      sessionId: 'session-test',
      assistantText: '被中断',
      structured: {
        thought: '',
        emotion: 'neutral',
        reply: '被中断',
        parsePath: 'json',
      },
      createdAt: Date.now(),
    })

    expect(dbStub.appendConversationTurn).not.toBeCalled()
    expect(getDialogueRespondedEvents()).toHaveLength(0)
  })

  it('drops dialogue event when kill switch aborts between persistence and emit', async () => {
    const sandboxPath = await createSandboxPath()
    await setupAliceRuntime({
      userDataPathOverride: sandboxPath,
    })

    const appendConversationTurn = invokeHandlers.get(electronAliceAppendConversationTurn)
    expect(appendConversationTurn).toBeTypeOf('function')

    dbStub.appendConversationTurn.mockImplementationOnce(async () => {
      setAliceKillSwitchState('SUSPENDED', 'race-test')
    })

    await appendConversationTurn!({
      cardId: 'default',
      turnId: 'turn-test-race',
      sessionId: 'session-test',
      assistantText: '竞态中断',
      structured: {
        thought: '',
        emotion: 'happy',
        reply: '竞态中断',
        parsePath: 'json',
      },
      createdAt: Date.now(),
    })

    expect(getDialogueRespondedEvents()).toHaveLength(0)
    setAliceKillSwitchState('ACTIVE', 'race-test-cleanup')
  })
})
