import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { AliceGenesisInput, AliceKillSwitchSnapshot, AliceMemoryStats, AliceSoulSnapshot } from './alice-bridge'
import type { AliceMemoryFact } from './alice-memory'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { sanitizeForRemoteModel } from '../composables/alice-guardrails'
import { calibrateSentimentConfidence, estimateLexicalSentiment } from '../composables/alice-structured-output'
import { getAliceBridge, hasAliceBridge } from './alice-bridge'
import {
  asyncExtractionIdleMs,
  evaluateAsyncExtractionBudget,
  evaluateAsyncExtractionTrigger,
} from './alice-epoch1-scheduler'
import { ensureRuntimeMemoryMigration, extractRuleFacts, getMemoryStats, retrieveFacts, runMemoryPrune, upsertFacts } from './alice-memory'
import { computePersonalityDelta } from './alice-personality'
import { useChatOrchestratorStore } from './chat'
import { useChatContextStore } from './chat/context-store'
import { useLLM } from './llm'
import { useConsciousnessStore } from './modules/consciousness'
import { useProvidersStore } from './providers'

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value))
    return min
  return Math.min(max, Math.max(min, value))
}

interface ExtractedAsyncFact {
  turnId?: string
  subject: string
  predicate: string
  object: string
  confidence: number
}

function extractJsonObjectCandidate(raw: string, maxChars = 32 * 1024) {
  const text = raw.trim()
  if (!text)
    return null

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace < firstBrace)
    return null

  const candidate = text.slice(firstBrace, lastBrace + 1)
  if (candidate.length > maxChars)
    return null

  return candidate
}

function parseExtractedAsyncFacts(raw: string): ExtractedAsyncFact[] {
  const candidate = extractJsonObjectCandidate(raw)
  if (!candidate)
    return []

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  }
  catch {
    return []
  }

  const payload = parsed && typeof parsed === 'object'
    ? parsed as { facts?: unknown }
    : null
  if (!payload || !Array.isArray(payload.facts))
    return []

  return payload.facts
    .map((item): ExtractedAsyncFact | null => {
      if (!item || typeof item !== 'object')
        return null

      const row = item as Record<string, unknown>
      const subject = typeof row.subject === 'string' ? row.subject.trim() : ''
      const predicate = typeof row.predicate === 'string' ? row.predicate.trim() : ''
      const object = typeof row.object === 'string' ? row.object.trim() : ''
      const turnId = typeof row.turnId === 'string' ? row.turnId.trim() : ''
      const confidenceRaw = typeof row.confidence === 'number'
        ? row.confidence
        : Number.parseFloat(String(row.confidence ?? '0'))
      const confidence = Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0

      if (!subject || !predicate || !object)
        return null

      return {
        turnId: turnId || undefined,
        subject,
        predicate,
        object,
        confidence,
      }
    })
    .filter((item): item is ExtractedAsyncFact => Boolean(item))
}

function parseUserText(content: unknown) {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string')
        return part
      if (part && typeof part === 'object' && 'text' in part)
        return String((part as { text?: unknown }).text ?? '')
      return ''
    }).join('')
  }
  return ''
}

function trimForExtractor(text: string, maxChars = 480) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars)
    return normalized
  return `${normalized.slice(0, Math.max(64, maxChars - 1))}…`
}

function extractSoulBody(content: string) {
  if (!content.startsWith('---\n'))
    return content.trim()
  const secondMarkerIndex = content.indexOf('\n---\n', 4)
  if (secondMarkerIndex < 0)
    return content.trim()
  return content.slice(secondMarkerIndex + 5).trim()
}

function replaceSoulBody(content: string, body: string) {
  const normalizedBody = body.trim()
  if (!content.startsWith('---\n')) {
    return `${normalizedBody}\n`
  }

  const secondMarkerIndex = content.indexOf('\n---\n', 4)
  if (secondMarkerIndex < 0) {
    return `${normalizedBody}\n`
  }

  const frontmatterBlock = content.slice(0, secondMarkerIndex + 5)
  return `${frontmatterBlock}${normalizedBody}\n`
}

const pruneIntervalMs = 24 * 60 * 60 * 1000
const genesisPollIntervalMs = 2000

type AsyncExtractorProvider = 'remote' | 'local' | 'off'

interface PendingAsyncExtractionTurn {
  sessionId: string
  turnId: string
  userText: string
  replyText: string
  memoryConfidenceWeight: number
}

function buildFactKey(fact: Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object'>) {
  return `${fact.subject.trim().toLowerCase()}|${fact.predicate.trim().toLowerCase()}|${fact.object.trim().toLowerCase()}`
}

function computeExtractorAgreement(
  left: Array<Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object'>>,
  right: Array<Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object'>>,
) {
  if (left.length === 0 && right.length === 0)
    return 0.5

  const leftKeys = new Set(left.map(buildFactKey))
  const rightKeys = new Set(right.map(buildFactKey))
  const union = new Set([...leftKeys, ...rightKeys])
  if (union.size === 0)
    return 0.5

  let intersection = 0
  for (const key of leftKeys) {
    if (rightKeys.has(key))
      intersection += 1
  }

  return clamp(intersection / union.size, 0, 1)
}

async function appendAliceAuditLog(payload: {
  level: 'info' | 'notice' | 'warning' | 'critical'
  category: string
  action: string
  message: string
  details?: Record<string, unknown>
}) {
  if (!hasAliceBridge())
    return

  await getAliceBridge().appendAuditLog({
    level: payload.level,
    category: payload.category,
    action: payload.action,
    message: payload.message,
    payload: payload.details,
  }).catch(() => {})
}

export const useAliceEpoch1Store = defineStore('alice-epoch1', () => {
  const llmStore = useLLM()
  const providersStore = useProvidersStore()
  const consciousnessStore = useConsciousnessStore()

  const soul = ref<AliceSoulSnapshot | null>(null)
  const needsGenesis = ref(false)
  const genesisConflictCandidate = ref<AliceSoulSnapshot | null>(null)
  const killSwitch = ref<AliceKillSwitchSnapshot>({
    state: 'ACTIVE',
    reason: 'bootstrap',
    updatedAt: Date.now(),
  })
  const memoryStats = ref<AliceMemoryStats>({
    total: 0,
    active: 0,
    archived: 0,
    lastPrunedAt: null,
  })

  let initialized = false
  let pruneTimer: ReturnType<typeof setInterval> | undefined
  let genesisPollTimer: ReturnType<typeof setInterval> | undefined
  let lastAssistantEmotion: string | null = null
  const hookDisposers: Array<() => void> = []
  const pendingAsyncExtractionTurns = new Map<string, PendingAsyncExtractionTurn>()
  let asyncExtractionIdleTimer: ReturnType<typeof setTimeout> | undefined
  let asyncExtractionRunning = false
  const asyncExtractionProvider: AsyncExtractorProvider = 'remote'
  let asyncExtractionBudgetWindowStartedAt = 0
  let asyncExtractionBudgetConsumed = 0
  let lastAsyncExtractionQueuedAt: number | null = null

  async function extractFactsViaConfiguredProvider(batch: PendingAsyncExtractionTurn[]): Promise<ExtractedAsyncFact[]> {
    const providerId = consciousnessStore.activeProvider
    const modelId = consciousnessStore.activeModel
    if (!providerId || !modelId) {
      throw new Error('No active provider/model configured for async extractor.')
    }

    const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
    const transcript = batch
      .map((item, index) => [
        `Turn #${index + 1}`,
        `turnId=${item.turnId}`,
        `User: ${trimForExtractor(item.userText)}`,
        `Assistant: ${trimForExtractor(item.replyText)}`,
      ].join('\n'))
      .join('\n\n')

    const messages: Message[] = [
      {
        role: 'system',
        content: [
          'Extract durable user-related memory facts from the transcript.',
          'Return ONLY strict JSON object:',
          '{"facts":[{"turnId":"...","subject":"...","predicate":"...","object":"...","confidence":0.0}]}',
          'Rules:',
          '- Keep only stable facts that help future assistance.',
          '- Use short lowercase predicate labels.',
          '- confidence must be 0..1.',
          '- Do not include markdown or prose.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: transcript,
      },
    ]

    const sanitized = sanitizeForRemoteModel(messages, { timeBudgetMs: 50, chunkSize: 2048 })
    if (sanitized.blocked) {
      throw new Error(`Async extractor blocked by sanitize gateway: ${sanitized.reason ?? 'unknown'}`)
    }

    let fullText = ''
    await llmStore.stream(modelId, chatProvider, sanitized.messages, {
      supportsTools: false,
      waitForTools: false,
      onStreamEvent: async (event) => {
        if (event.type === 'text-delta')
          fullText += event.text
        if (event.type === 'error')
          throw event.error ?? new Error('Async extractor stream error')
      },
    })

    return parseExtractedAsyncFacts(fullText)
  }

  async function syncMemoryStatsToRuntime() {
    const stats = await getMemoryStats()
    memoryStats.value = stats
    return stats
  }

  async function runPruneNow() {
    const stats = await runMemoryPrune()
    memoryStats.value = stats
    return await syncMemoryStatsToRuntime()
  }

  async function refreshMemoryStats() {
    return await syncMemoryStatsToRuntime()
  }

  async function syncKillSwitchState() {
    if (!hasAliceBridge()) {
      killSwitch.value = {
        state: 'ACTIVE',
        reason: 'bridge-unavailable',
        updatedAt: Date.now(),
      }
      return killSwitch.value
    }

    const snapshot = await getAliceBridge().getKillSwitchState().catch(() => null)
    if (snapshot)
      killSwitch.value = snapshot
    return killSwitch.value
  }

  function setKillSwitchSnapshot(snapshot: AliceKillSwitchSnapshot) {
    killSwitch.value = snapshot
  }

  async function suspendKillSwitch(reason = 'manual-ui') {
    if (!hasAliceBridge())
      return killSwitch.value

    const snapshot = await getAliceBridge().suspendKillSwitch({ reason }).catch(() => null)
    if (snapshot)
      killSwitch.value = snapshot
    return killSwitch.value
  }

  async function resumeKillSwitch(reason = 'manual-ui') {
    if (!hasAliceBridge())
      return killSwitch.value

    const snapshot = await getAliceBridge().resumeKillSwitch({ reason }).catch(() => null)
    if (snapshot)
      killSwitch.value = snapshot
    return killSwitch.value
  }

  function setupPruneTimer() {
    if (pruneTimer)
      return

    pruneTimer = setInterval(() => {
      void runPruneNow()
    }, pruneIntervalMs)
  }

  function clearAsyncExtractionIdleTimer() {
    if (!asyncExtractionIdleTimer)
      return
    clearTimeout(asyncExtractionIdleTimer)
    asyncExtractionIdleTimer = undefined
  }

  function canConsumeAsyncExtractionBudget() {
    const currentTs = Date.now()
    const result = evaluateAsyncExtractionBudget({
      state: {
        windowStartedAt: asyncExtractionBudgetWindowStartedAt,
        consumed: asyncExtractionBudgetConsumed,
      },
      now: currentTs,
    })
    asyncExtractionBudgetWindowStartedAt = result.nextState.windowStartedAt
    asyncExtractionBudgetConsumed = result.nextState.consumed
    return result.allowed
  }

  async function flushAsyncExtraction(reason: 'batch-threshold' | 'idle') {
    if (asyncExtractionRunning)
      return
    if (pendingAsyncExtractionTurns.size === 0)
      return

    asyncExtractionRunning = true
    clearAsyncExtractionIdleTimer()
    const batch = [...pendingAsyncExtractionTurns.values()]
    pendingAsyncExtractionTurns.clear()

    try {
      if (asyncExtractionProvider === 'off') {
        await appendAliceAuditLog({
          level: 'notice',
          category: 'memory',
          action: 'async-extractor-skipped',
          message: 'Async memory extractor is disabled (provider=off).',
          details: {
            batchSize: batch.length,
            reason,
          },
        })
        return
      }

      if (!canConsumeAsyncExtractionBudget()) {
        await appendAliceAuditLog({
          level: 'notice',
          category: 'memory',
          action: 'async-extractor-degraded',
          message: 'Async memory extractor budget exceeded, degraded to rule-only extraction.',
          details: {
            batchSize: batch.length,
            provider: asyncExtractionProvider,
            reason,
          },
        })
        return
      }

      if (asyncExtractionProvider === 'remote' || asyncExtractionProvider === 'local') {
        const extracted = await extractFactsViaConfiguredProvider(batch)
        if (extracted.length > 0) {
          const turnWeightById = new Map(batch.map(item => [item.turnId, item.memoryConfidenceWeight]))
          const weightedFacts = extracted.map((fact) => {
            const weight = fact.turnId ? turnWeightById.get(fact.turnId) : undefined
            const confidenceWeight = typeof weight === 'number' ? weight : 0.6
            return {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              confidence: clamp(fact.confidence * confidenceWeight + 0.05, 0, 1),
            }
          })
          await upsertFacts(weightedFacts, 'async-llm')
        }
      }

      await appendAliceAuditLog({
        level: 'info',
        category: 'memory',
        action: 'async-extractor-flushed',
        message: 'Async memory extraction batch completed.',
        details: {
          batchSize: batch.length,
          provider: asyncExtractionProvider,
          reason,
        },
      })
      await syncMemoryStatsToRuntime()
    }
    catch (error) {
      await appendAliceAuditLog({
        level: 'warning',
        category: 'memory',
        action: 'async-extractor-failed',
        message: 'Async memory extraction batch failed.',
        details: {
          reason: error instanceof Error ? error.message : String(error),
          provider: asyncExtractionProvider,
        },
      })
    }
    finally {
      asyncExtractionRunning = false
    }
  }

  function scheduleAsyncExtractionIdleFlush() {
    clearAsyncExtractionIdleTimer()
    asyncExtractionIdleTimer = setTimeout(() => {
      void flushAsyncExtraction('idle')
    }, asyncExtractionIdleMs)
  }

  function enqueueAsyncExtractionTurn(input: PendingAsyncExtractionTurn) {
    const key = `${input.sessionId}:${input.turnId}`
    pendingAsyncExtractionTurns.set(key, input)
    lastAsyncExtractionQueuedAt = Date.now()

    const trigger = evaluateAsyncExtractionTrigger({
      pendingCount: pendingAsyncExtractionTurns.size,
      lastQueuedAt: lastAsyncExtractionQueuedAt,
      now: lastAsyncExtractionQueuedAt,
    })
    if (trigger === 'batch') {
      void flushAsyncExtraction('batch-threshold')
      return
    }

    scheduleAsyncExtractionIdleFlush()
  }

  function stopGenesisPolling() {
    if (!genesisPollTimer)
      return

    clearInterval(genesisPollTimer)
    genesisPollTimer = undefined
  }

  function setupGenesisPolling() {
    if (genesisPollTimer || !hasAliceBridge())
      return

    genesisPollTimer = setInterval(() => {
      void (async () => {
        if (!needsGenesis.value || !hasAliceBridge()) {
          stopGenesisPolling()
          return
        }

        const latest = await getAliceBridge().getSoul().catch(() => null)
        if (!latest)
          return
        if (latest.hash === soul.value?.hash)
          return

        soul.value = latest
        needsGenesis.value = latest.needsGenesis
        if (latest.needsGenesis) {
          genesisConflictCandidate.value = latest
        }
        else {
          genesisConflictCandidate.value = null
          stopGenesisPolling()
        }
      })()
    }, genesisPollIntervalMs)
  }

  async function bootstrapRuntime() {
    if (!hasAliceBridge()) {
      needsGenesis.value = false
      stopGenesisPolling()
      return
    }

    const snapshot = await getAliceBridge().bootstrap()
    soul.value = snapshot
    needsGenesis.value = snapshot.needsGenesis
    if (!snapshot.needsGenesis)
      genesisConflictCandidate.value = null
    if (snapshot.needsGenesis)
      setupGenesisPolling()
    else
      stopGenesisPolling()
  }

  async function initializeGenesis(payload: AliceGenesisInput) {
    if (!hasAliceBridge())
      return

    const result = await getAliceBridge().initializeGenesis(payload)

    soul.value = result.soul
    needsGenesis.value = result.soul.needsGenesis
    genesisConflictCandidate.value = result.conflictCandidate ?? null
    if (result.soul.needsGenesis)
      setupGenesisPolling()
    else
      stopGenesisPolling()
    return result
  }

  async function refreshSoul() {
    if (!hasAliceBridge())
      return soul.value

    const snapshot = await getAliceBridge().getSoul().catch(() => null)
    if (snapshot)
      setSoulSnapshot(snapshot)
    return soul.value
  }

  async function updateSoulContent(content: string) {
    if (!hasAliceBridge() || !soul.value)
      return soul.value

    const updated = await getAliceBridge().updateSoul({
      expectedRevision: soul.value.revision,
      content,
    }).catch(() => null)

    if (updated)
      setSoulSnapshot(updated)
    return soul.value
  }

  async function updateSoulBody(body: string) {
    if (!soul.value)
      return soul.value

    const nextContent = replaceSoulBody(soul.value.content, body)
    if (extractSoulBody(nextContent) === extractSoulBody(soul.value.content))
      return soul.value
    return await updateSoulContent(nextContent)
  }

  function attachChatHooks() {
    const chatOrchestrator = useChatOrchestratorStore()
    const chatContext = useChatContextStore()

    hookDisposers.push(
      chatOrchestrator.onBeforeMessageComposed(async (message) => {
        const matched = await retrieveFacts(message, 6)
        if (matched.length === 0)
          return

        const summary = matched
          .map(item => `- ${item.subject} ${item.predicate} ${item.object} (confidence=${item.confidence.toFixed(2)})`)
          .join('\n')

        chatContext.ingestContextMessage({
          id: nanoid(),
          contextId: 'alice:memory',
          strategy: ContextUpdateStrategy.ReplaceSelf,
          text: summary,
          createdAt: Date.now(),
        })

        await syncMemoryStatsToRuntime()
      }),
      chatOrchestrator.onChatTurnComplete(async ({ output }, context) => {
        const userText = parseUserText(context.message.content)
        const replyText = output.structured?.reply ?? parseUserText(output.content)
        const structured = output.structured

        if (structured?.contractFailed) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'structured-output',
            action: 'contract-failed-skip-learning',
            message: 'Skipped personality drift and async memory extraction because contract failed.',
            details: {
              sessionId: context.sessionId,
              parsePath: structured.parsePath,
              format: structured.format,
            },
          })
          lastAssistantEmotion = structured.emotion || lastAssistantEmotion
          return
        }

        const extractedByRule = extractRuleFacts({ userText, replyText })
        const extractedByAsyncLlm = extractRuleFacts({
          userText: `${userText}\n${replyText}`.trim(),
          replyText,
        })
        const extractorAgreement = computeExtractorAgreement(extractedByRule, extractedByAsyncLlm)
        const lexicalStrength = Math.abs(estimateLexicalSentiment(replyText))
        const emotionalCoherence = lastAssistantEmotion
          ? (lastAssistantEmotion === structured?.emotion ? 1 : 0.55)
          : 0.7
        const calibratedConfidence = calibrateSentimentConfidence({
          rawConfidence: structured?.sentimentConfidenceRaw,
          lexicalStrength,
          emotionCoherence: emotionalCoherence,
          extractorAgreement,
        })

        const memoryConfidenceWeight = clamp(calibratedConfidence, 0.2, 1)
        const extracted = extractedByRule.map(item => ({
          ...item,
          confidence: clamp(item.confidence * memoryConfidenceWeight, 0, 1),
        }))
        await upsertFacts(extracted, 'rule')

        const turnId = context.message.id ?? nanoid()
        enqueueAsyncExtractionTurn({
          sessionId: context.sessionId ?? 'unknown',
          turnId,
          userText,
          replyText,
          memoryConfidenceWeight,
        })

        if (!structured || !hasAliceBridge())
          return

        structured.sentimentConfidence = calibratedConfidence
        const score = structured.userSentimentScore ?? 0
        const confidence = calibratedConfidence
        if (confidence < 0.25) {
          lastAssistantEmotion = structured.emotion
          return
        }
        const delta = computePersonalityDelta(score, confidence)
        if (Math.abs(delta) <= 0.0001) {
          lastAssistantEmotion = structured.emotion
          return
        }

        const nextSoul = await getAliceBridge().updatePersonality({
          expectedRevision: soul.value?.revision,
          reason: 'epoch1-sentiment-drift',
          deltas: {
            obedience: delta * 0.7,
            liveliness: delta * 0.5,
            sensibility: delta * 0.6,
          },
        }).catch(() => null)

        if (nextSoul)
          soul.value = nextSoul
        lastAssistantEmotion = structured.emotion

        await syncMemoryStatsToRuntime()
      }),
    )
  }

  async function initialize() {
    if (initialized)
      return
    initialized = true

    await bootstrapRuntime()
    await ensureRuntimeMemoryMigration()
    attachChatHooks()
    await syncMemoryStatsToRuntime()
    await syncKillSwitchState()
    await runPruneNow()
    setupPruneTimer()
  }

  function setSoulSnapshot(snapshot: AliceSoulSnapshot) {
    soul.value = snapshot
    needsGenesis.value = snapshot.needsGenesis
    if (!snapshot.needsGenesis)
      genesisConflictCandidate.value = null
    if (snapshot.needsGenesis)
      setupGenesisPolling()
    else
      stopGenesisPolling()
  }

  function dispose() {
    for (const disposer of hookDisposers.splice(0, hookDisposers.length)) {
      disposer()
    }

    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = undefined
    }
    stopGenesisPolling()
    clearAsyncExtractionIdleTimer()
    pendingAsyncExtractionTurns.clear()
    asyncExtractionRunning = false
    asyncExtractionBudgetWindowStartedAt = 0
    asyncExtractionBudgetConsumed = 0
    lastAsyncExtractionQueuedAt = null
    lastAssistantEmotion = null
    initialized = false
  }

  return {
    soul,
    needsGenesis,
    memoryStats,
    genesisConflictCandidate,
    killSwitch,
    initialize,
    initializeGenesis,
    setSoulSnapshot,
    setKillSwitchSnapshot,
    refreshSoul,
    updateSoulContent,
    updateSoulBody,
    suspendKillSwitch,
    resumeKillSwitch,
    syncKillSwitchState,
    refreshMemoryStats,
    runPruneNow,
    dispose,
  }
})
