import type { AliceMemoryStats, AliceSoulSnapshot } from './alice-bridge'
import type { AliceMemoryFact } from './alice-memory'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { calibrateSentimentConfidence, estimateLexicalSentiment } from '../composables/alice-structured-output'
import { getAliceBridge, hasAliceBridge } from './alice-bridge'
import { extractRuleFacts, getMemoryStats, retrieveFacts, runMemoryPrune, upsertFacts } from './alice-memory'
import { computePersonalityDelta } from './alice-personality'
import { useChatOrchestratorStore } from './chat'
import { useChatContextStore } from './chat/context-store'

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value))
    return min
  return Math.min(max, Math.max(min, value))
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

const pruneIntervalMs = 24 * 60 * 60 * 1000
const genesisPollIntervalMs = 2000

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

export const useAliceEpoch1Store = defineStore('alice-epoch1', () => {
  const soul = ref<AliceSoulSnapshot | null>(null)
  const needsGenesis = ref(false)
  const genesisConflictCandidate = ref<AliceSoulSnapshot | null>(null)
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

  async function syncMemoryStatsToRuntime() {
    const stats = await getMemoryStats()
    memoryStats.value = stats
    if (hasAliceBridge()) {
      await getAliceBridge().updateMemoryStats(stats).catch(() => {})
    }
    return stats
  }

  async function runPruneNow() {
    await runMemoryPrune()
    const stats = await syncMemoryStatsToRuntime()
    if (hasAliceBridge()) {
      await getAliceBridge().runMemoryPrune().catch(() => {})
    }
    return stats
  }

  function setupPruneTimer() {
    if (pruneTimer)
      return

    pruneTimer = setInterval(() => {
      void runPruneNow()
    }, pruneIntervalMs)
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

  async function initializeGenesis(payload: {
    hostName: string
    mindAge: number
    obedience: number
    liveliness: number
    sensibility: number
    allowOverwrite?: boolean
  }) {
    if (!hasAliceBridge())
      return

    const result = await getAliceBridge().initializeGenesis({
      hostName: payload.hostName,
      mindAge: payload.mindAge,
      allowOverwrite: payload.allowOverwrite,
      personality: {
        obedience: payload.obedience,
        liveliness: payload.liveliness,
        sensibility: payload.sensibility,
      },
    })

    soul.value = result.soul
    needsGenesis.value = result.soul.needsGenesis
    genesisConflictCandidate.value = result.conflictCandidate ?? null
    if (result.soul.needsGenesis)
      setupGenesisPolling()
    else
      stopGenesisPolling()
    return result
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
          text: `Relevant memory facts:\n${summary}`,
          createdAt: Date.now(),
          source: 'alice-memory',
        })

        await syncMemoryStatsToRuntime()
      }),
      chatOrchestrator.onChatTurnComplete(async ({ output }, context) => {
        const userText = parseUserText(context.message.content)
        const replyText = output.structured?.reply ?? parseUserText(output.content)
        const extractedByRule = extractRuleFacts({ userText, replyText })
        const extractedByAsyncLlm = extractRuleFacts({
          userText: `${userText}\n${replyText}`.trim(),
          replyText,
        })
        const extractorAgreement = computeExtractorAgreement(extractedByRule, extractedByAsyncLlm)

        const structured = output.structured
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

        // Async refinement path (non-blocking): re-rank confidence and mark source.
        setTimeout(() => {
          void (async () => {
            const refinedSource = extractedByAsyncLlm.length > 0 ? extractedByAsyncLlm : extractedByRule
            const refined = refinedSource.map(item => ({
              ...item,
              confidence: clamp(item.confidence * memoryConfidenceWeight + 0.05, 0, 1),
            }))
            await upsertFacts(refined, 'async-llm')
            await syncMemoryStatsToRuntime()
          })()
        }, 120)

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
    attachChatHooks()
    await syncMemoryStatsToRuntime()
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
    lastAssistantEmotion = null
    initialized = false
  }

  return {
    soul,
    needsGenesis,
    memoryStats,
    genesisConflictCandidate,
    initialize,
    initializeGenesis,
    setSoulSnapshot,
    runPruneNow,
    dispose,
  }
})
