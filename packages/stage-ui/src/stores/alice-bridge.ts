export type AliceKillSwitchState = 'ACTIVE' | 'SUSPENDED'

export interface AliceCardScope {
  cardId: string
}

export interface AlicePersonalityState {
  obedience: number
  liveliness: number
  sensibility: number
}

export type AliceGender = 'female' | 'male' | 'non-binary' | 'neutral' | 'custom'

export interface AliceSoulFrontmatter {
  schemaVersion: number
  initialized: boolean
  profile: {
    ownerName: string
    hostName: string
    aliceName: string
    gender: AliceGender
    genderCustom: string
    relationship: string
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
  ownerName: string
  hostName: string
  aliceName: string
  gender: AliceGender
  genderCustom?: string
  relationship: string
  personaNotes?: string
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

export type AliceMemorySource = 'rule' | 'async-llm'

export interface AliceMemoryFact {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  source: AliceMemorySource
  dedupeKey: string
  createdAt: number
  updatedAt: number
  lastAccessAt: number | null
  accessCount: number
}

export interface AliceMemoryArchiveRecord extends AliceMemoryFact {
  archivedAt: number
}

export interface AliceMemoryFactInput {
  subject: string
  predicate: string
  object: string
  confidence: number
}

export interface AliceMemoryLegacySnapshot {
  facts: AliceMemoryFact[]
  archive: AliceMemoryArchiveRecord[]
  lastPrunedAt: number | null
}

export interface AliceMemoryMigrationResult {
  migrated: boolean
  importedFacts: number
  importedArchive: number
  marker: string
}

export interface AliceConversationTurnInput {
  turnId?: string
  sessionId: string
  userText?: string
  assistantText?: string
  structured?: Record<string, unknown>
  createdAt?: number
}

export type AliceAuditLogLevel = 'info' | 'notice' | 'warning' | 'critical'

export interface AliceAuditLogInput {
  level?: AliceAuditLogLevel
  category: string
  action: string
  message: string
  payload?: Record<string, unknown>
  createdAt?: number
}

export type AliceRealtimeCategory = 'weather' | 'news' | 'finance' | 'sports'

export interface AliceRealtimeExecutePayload {
  category: AliceRealtimeCategory
  query: string
  locale?: string
  now?: number
}

export interface AliceRealtimeExecuteResult {
  category: AliceRealtimeCategory
  source: 'builtin'
  ok: boolean
  summary?: string
  data?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  durationMs: number
}

export type AliceSystemProbeDegradeReason
  = | 'battery-unavailable'
    | 'cpu-unavailable'
    | 'memory-unavailable'

export interface AliceSystemProbeSample {
  collectedAt: number
  time: {
    iso: string
    local: string
    timezone: string
  }
  battery?: {
    percent: number
    charging: boolean
    source: 'native' | 'fallback'
  }
  cpu: {
    usagePercent: number
    windowMs: number
  }
  memory: {
    freeMB: number
    totalMB: number
    usagePercent: number
  }
  degraded?: AliceSystemProbeDegradeReason[]
}

export interface AliceSensoryCacheSnapshot {
  sample: AliceSystemProbeSample
  stale: boolean
  ageMs: number
  nextTickAt: number | null
  running: boolean
}

export const aliceEmotionWhitelist = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'concerned',
  'tired',
  'apologetic',
  'processing',
] as const

export type AliceEmotion = typeof aliceEmotionWhitelist[number]

export function normalizeAliceEmotion(raw: unknown): { emotion: AliceEmotion, rawEmotion?: string, downgraded: boolean } {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if ((aliceEmotionWhitelist as readonly string[]).includes(value)) {
    return {
      emotion: value as AliceEmotion,
      downgraded: false,
    }
  }

  return {
    emotion: 'neutral',
    rawEmotion: value || undefined,
    downgraded: Boolean(value),
  }
}

export interface AliceDialogueStructuredPayload {
  thought: string
  emotion: AliceEmotion
  reply: string
  policyLocked?: string
  rawEmotion?: string
}

export interface AliceDialogueRespondedPayload {
  cardId: string
  turnId: string
  sessionId: string
  structured: AliceDialogueStructuredPayload
  isFallback: boolean
  createdAt: number
}

export type AliceToolRiskLevel = 'safe' | 'sensitive' | 'danger'

export interface AliceSafetyPermissionRequest {
  cardId: string
  requestId: string
  token: string
  riskLevel: AliceToolRiskLevel
  actionCategory: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'unknown'
  serverName: string
  toolName: string
  reason: string
  resourceLabel?: string
  timeoutMs: number
  createdAt: number
  supportsRememberSession: boolean
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
  retrieveMemoryFacts: (payload: { query: string, limit?: number }) => Promise<AliceMemoryFact[]>
  upsertMemoryFacts: (payload: { facts: AliceMemoryFactInput[], source: AliceMemorySource }) => Promise<void>
  importLegacyMemory: (payload: AliceMemoryLegacySnapshot) => Promise<AliceMemoryMigrationResult>
  appendConversationTurn: (payload: AliceConversationTurnInput) => Promise<void>
  appendAuditLog: (payload: AliceAuditLogInput) => Promise<void>
  realtimeExecute: (payload: AliceRealtimeExecutePayload) => Promise<AliceRealtimeExecuteResult>
  getSensorySnapshot: () => Promise<AliceSensoryCacheSnapshot>
  deleteCardScope?: (scope: AliceCardScope) => Promise<void>
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
