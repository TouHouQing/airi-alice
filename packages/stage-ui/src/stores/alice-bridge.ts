export type AliceKillSwitchState = 'ACTIVE' | 'SUSPENDED'

export interface AlicePersonalityState {
  obedience: number
  liveliness: number
  sensibility: number
}

export interface AliceSoulFrontmatter {
  schemaVersion: number
  initialized: boolean
  profile: {
    hostName: string
    mindAge: number
  }
  personality: AlicePersonalityState
  boundaries: {
    killSwitch: boolean
    mcpGuard: boolean
  }
}

export interface AliceSoulSnapshot {
  soulPath: string
  content: string
  frontmatter: AliceSoulFrontmatter
  revision: number
  hash: string
  needsGenesis: boolean
  watching: boolean
}

export interface AliceGenesisInput {
  hostName: string
  mindAge: number
  personality: AlicePersonalityState
  allowOverwrite?: boolean
}

export interface AliceInitializeGenesisResult {
  soul: AliceSoulSnapshot
  conflict: boolean
  conflictCandidate?: AliceSoulSnapshot
}

export interface AlicePersonalityUpdatePayload {
  expectedRevision?: number
  reason?: string
  deltas: Partial<AlicePersonalityState>
}

export interface AliceSoulUpdatePayload {
  expectedRevision?: number
  content: string
}

export interface AliceKillSwitchSnapshot {
  state: AliceKillSwitchState
  reason?: string
  updatedAt: number
}

export interface AliceMemoryStats {
  total: number
  active: number
  archived: number
  lastPrunedAt: number | null
}

interface AliceBridge {
  bootstrap: () => Promise<AliceSoulSnapshot>
  getSoul: () => Promise<AliceSoulSnapshot>
  initializeGenesis: (payload: AliceGenesisInput) => Promise<AliceInitializeGenesisResult>
  updateSoul: (payload: AliceSoulUpdatePayload) => Promise<AliceSoulSnapshot>
  updatePersonality: (payload: AlicePersonalityUpdatePayload) => Promise<AliceSoulSnapshot>
  getKillSwitchState: () => Promise<AliceKillSwitchSnapshot>
  suspendKillSwitch: (payload?: { reason?: string }) => Promise<AliceKillSwitchSnapshot>
  resumeKillSwitch: (payload?: { reason?: string }) => Promise<AliceKillSwitchSnapshot>
  getMemoryStats: () => Promise<AliceMemoryStats>
  runMemoryPrune: () => Promise<AliceMemoryStats>
  updateMemoryStats: (payload: AliceMemoryStats) => Promise<AliceMemoryStats>
}

let bridge: AliceBridge | undefined

export function setAliceBridge(nextBridge: AliceBridge) {
  bridge = nextBridge
}

export function clearAliceBridge() {
  bridge = undefined
}

export function getAliceBridge(): AliceBridge {
  if (!bridge) {
    throw new Error('A.L.I.C.E bridge is not available in this runtime.')
  }
  return bridge
}

export function hasAliceBridge() {
  return Boolean(bridge)
}
