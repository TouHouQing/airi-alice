import { nanoid } from 'nanoid'

export type AliceAbortScope = 'chat' | 'spark' | 'execution'

export type AliceAbortReason
  = | 'kill-switch'
    | 'session-reset'
    | 'manual'
    | 'shutdown'
    | 'unknown'

interface AbortRegistryItem {
  controller: AbortController
  scope: AliceAbortScope
  reason?: AliceAbortReason
  createdAt: number
}

export interface RegisterAliceTurnAbortInput {
  turnId?: string
  scope: AliceAbortScope
}

export interface RegisterAliceTurnAbortResult {
  turnId: string
  signal: AbortSignal
  abort: (reason?: AliceAbortReason) => boolean
}

const abortRegistry = new Map<string, AbortRegistryItem>()

function createAbortReasonError(reason: AliceAbortReason) {
  return new DOMException(`Turn aborted: ${reason}`, 'AbortError')
}

export function isAliceAbortError(error: unknown) {
  if (!error)
    return false

  if (typeof error === 'object' && error != null && 'name' in error) {
    return (error as { name?: unknown }).name === 'AbortError'
  }

  return false
}

export function registerAliceTurnAbort(input: RegisterAliceTurnAbortInput): RegisterAliceTurnAbortResult {
  const turnId = input.turnId?.trim() || `${input.scope}-${nanoid()}`
  const existing = abortRegistry.get(turnId)
  if (existing) {
    existing.controller.abort(createAbortReasonError('unknown'))
    abortRegistry.delete(turnId)
  }

  const controller = new AbortController()
  abortRegistry.set(turnId, {
    controller,
    scope: input.scope,
    createdAt: Date.now(),
  })

  return {
    turnId,
    signal: controller.signal,
    abort: (reason = 'unknown') => abortAliceTurn(turnId, reason),
  }
}

export function completeAliceTurnAbort(turnId: string) {
  abortRegistry.delete(turnId)
}

export function abortAliceTurn(turnId: string, reason: AliceAbortReason) {
  const item = abortRegistry.get(turnId)
  if (!item)
    return false

  if (item.controller.signal.aborted) {
    abortRegistry.delete(turnId)
    return false
  }

  item.reason = reason
  item.controller.abort(createAbortReasonError(reason))
  abortRegistry.delete(turnId)
  return true
}

export function abortAliceTurns(input: { reason: AliceAbortReason, scope?: AliceAbortScope }) {
  let aborted = 0
  const ids: string[] = []

  for (const [turnId, item] of abortRegistry) {
    if (input.scope && item.scope !== input.scope)
      continue

    if (item.controller.signal.aborted) {
      abortRegistry.delete(turnId)
      continue
    }

    item.reason = input.reason
    item.controller.abort(createAbortReasonError(input.reason))
    ids.push(turnId)
    aborted += 1
    abortRegistry.delete(turnId)
  }

  return {
    aborted,
    ids,
  }
}

export function getAliceAbortRegistrySize(scope?: AliceAbortScope) {
  if (!scope)
    return abortRegistry.size

  let size = 0
  for (const item of abortRegistry.values()) {
    if (item.scope === scope)
      size += 1
  }

  return size
}

export function clearAliceAbortRegistry() {
  abortRegistry.clear()
}
