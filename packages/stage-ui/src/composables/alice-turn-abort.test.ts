import { afterEach, describe, expect, it } from 'vitest'

import {
  abortAliceTurn,
  abortAliceTurns,
  clearAliceAbortRegistry,
  completeAliceTurnAbort,
  getAliceAbortRegistrySize,
  isAliceAbortError,
  registerAliceTurnAbort,
} from './alice-turn-abort'

describe('alice turn abort registry', () => {
  afterEach(() => {
    clearAliceAbortRegistry()
  })

  it('registers and completes turns', () => {
    const turn = registerAliceTurnAbort({
      scope: 'chat',
      turnId: 'chat:turn:1',
    })

    expect(getAliceAbortRegistrySize()).toBe(1)
    completeAliceTurnAbort(turn.turnId)
    expect(getAliceAbortRegistrySize()).toBe(0)
  })

  it('aborts a single turn with AbortError semantics', () => {
    const turn = registerAliceTurnAbort({
      scope: 'spark',
      turnId: 'spark:turn:1',
    })

    const aborted = abortAliceTurn(turn.turnId, 'kill-switch')
    expect(aborted).toBe(true)
    expect(turn.signal.aborted).toBe(true)
    expect(isAliceAbortError(turn.signal.reason)).toBe(true)
    expect(getAliceAbortRegistrySize()).toBe(0)
  })

  it('broadcast abort respects scope filtering', () => {
    registerAliceTurnAbort({ scope: 'chat', turnId: 'chat:1' })
    registerAliceTurnAbort({ scope: 'chat', turnId: 'chat:2' })
    registerAliceTurnAbort({ scope: 'spark', turnId: 'spark:1' })

    const chatResult = abortAliceTurns({ reason: 'session-reset', scope: 'chat' })
    expect(chatResult.aborted).toBe(2)
    expect(getAliceAbortRegistrySize('spark')).toBe(1)

    const allResult = abortAliceTurns({ reason: 'kill-switch' })
    expect(allResult.aborted).toBe(1)
    expect(getAliceAbortRegistrySize()).toBe(0)
  })
})
