import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  abortActiveTurns: vi.fn(async () => ({ aborted: 1, ids: ['chat:session-1:turn-1'] })),
  cleanupMessages: vi.fn(),
  resetContexts: vi.fn(),
  resetStream: vi.fn(),
}))

vi.mock('../chat', () => ({
  useChatOrchestratorStore: () => ({
    abortActiveTurns: mocks.abortActiveTurns,
  }),
}))

vi.mock('./session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: 'session-1',
    cleanupMessages: mocks.cleanupMessages,
  }),
}))

vi.mock('./context-store', () => ({
  useChatContextStore: () => ({
    resetContexts: mocks.resetContexts,
  }),
}))

vi.mock('./stream-store', () => ({
  useChatStreamStore: () => ({
    resetStream: mocks.resetStream,
  }),
}))

describe('chat maintenance cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.abortActiveTurns.mockClear()
    mocks.cleanupMessages.mockClear()
    mocks.resetContexts.mockClear()
    mocks.resetStream.mockClear()
  })

  it('aborts active turns before resetting the active session', async () => {
    const { useChatMaintenanceStore } = await import('./maintenance')

    const store = useChatMaintenanceStore()
    await store.cleanupMessages()

    expect(mocks.abortActiveTurns).toHaveBeenCalledWith('session-reset')
    expect(mocks.cleanupMessages).toHaveBeenCalledWith('session-1')
    expect(mocks.abortActiveTurns.mock.invocationCallOrder[0]).toBeLessThan(mocks.cleanupMessages.mock.invocationCallOrder[0])
    expect(mocks.resetContexts).toHaveBeenCalledTimes(1)
    expect(mocks.resetStream).toHaveBeenCalledTimes(1)
  })
})
