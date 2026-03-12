import type { AliceAuditLogInput, AliceKillSwitchSnapshot, AliceKillSwitchState } from '../../../shared/eventa'

let killSwitchSnapshot: AliceKillSwitchSnapshot = {
  state: 'ACTIVE',
  updatedAt: Date.now(),
}
const listeners = new Set<(snapshot: AliceKillSwitchSnapshot) => void>()
const cardKillSwitchSnapshots = new Map<string, AliceKillSwitchSnapshot>()
const cardListeners = new Set<(payload: { cardId: string, snapshot: AliceKillSwitchSnapshot }) => void>()
let auditLogger: ((input: AliceAuditLogInput) => Promise<void>) | undefined

export function getAliceKillSwitchSnapshot(): AliceKillSwitchSnapshot {
  return killSwitchSnapshot
}

export function isAliceKillSwitchSuspended() {
  return killSwitchSnapshot.state === 'SUSPENDED'
}

export function getAliceCardKillSwitchSnapshot(cardId: string): AliceKillSwitchSnapshot {
  const normalizedCardId = cardId.trim() || 'default'
  const known = cardKillSwitchSnapshots.get(normalizedCardId)
  if (known)
    return known

  const next: AliceKillSwitchSnapshot = {
    state: 'ACTIVE',
    updatedAt: Date.now(),
  }
  cardKillSwitchSnapshots.set(normalizedCardId, next)
  return next
}

export function isAliceCardKillSwitchSuspended(cardId: string) {
  return getAliceCardKillSwitchSnapshot(cardId).state === 'SUSPENDED'
}

export function setAliceKillSwitchState(state: AliceKillSwitchState, reason?: string): AliceKillSwitchSnapshot {
  killSwitchSnapshot = {
    state,
    reason,
    updatedAt: Date.now(),
  }
  for (const listener of listeners) {
    try {
      listener(killSwitchSnapshot)
    }
    catch {
      // NOTICE: Kill switch listeners must never break state updates.
    }
  }
  return killSwitchSnapshot
}

export function setAliceCardKillSwitchState(cardId: string, state: AliceKillSwitchState, reason?: string): AliceKillSwitchSnapshot {
  const normalizedCardId = cardId.trim() || 'default'
  const snapshot: AliceKillSwitchSnapshot = {
    state,
    reason,
    updatedAt: Date.now(),
  }
  cardKillSwitchSnapshots.set(normalizedCardId, snapshot)
  for (const listener of cardListeners) {
    try {
      listener({ cardId: normalizedCardId, snapshot })
    }
    catch {
      // NOTICE: Card-level kill switch listeners must never break state updates.
    }
  }
  return snapshot
}

export function onAliceKillSwitchChanged(listener: (snapshot: AliceKillSwitchSnapshot) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function onAliceCardKillSwitchChanged(listener: (payload: { cardId: string, snapshot: AliceKillSwitchSnapshot }) => void) {
  cardListeners.add(listener)
  return () => {
    cardListeners.delete(listener)
  }
}

export function setAliceAuditLogger(logger?: (input: AliceAuditLogInput) => Promise<void>) {
  auditLogger = logger
}

export async function appendAliceRuntimeAuditLog(input: AliceAuditLogInput) {
  if (!auditLogger)
    return
  await auditLogger(input).catch(() => {})
}
