import type { AliceKillSwitchSnapshot, AliceKillSwitchState } from '../../../shared/eventa'

let killSwitchSnapshot: AliceKillSwitchSnapshot = {
  state: 'ACTIVE',
  updatedAt: Date.now(),
}

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
  return killSwitchSnapshot
}
