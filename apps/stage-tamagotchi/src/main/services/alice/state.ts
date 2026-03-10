import type { AliceAuditLogInput, AliceKillSwitchSnapshot, AliceKillSwitchState } from '../../../shared/eventa'

let killSwitchSnapshot: AliceKillSwitchSnapshot = {
  state: 'ACTIVE',
  updatedAt: Date.now(),
}
const listeners = new Set<(snapshot: AliceKillSwitchSnapshot) => void>()
let auditLogger: ((input: AliceAuditLogInput) => Promise<void>) | undefined

export function getAliceKillSwitchSnapshot(): AliceKillSwitchSnapshot {
  return killSwitchSnapshot
}

export function isAliceKillSwitchSuspended() {
  return killSwitchSnapshot.state === 'SUSPENDED'
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

export function onAliceKillSwitchChanged(listener: (snapshot: AliceKillSwitchSnapshot) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
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
