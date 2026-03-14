<script setup lang="ts">
import type { AliceBridgeChatStreamEvent } from '@proj-airi/stage-ui/stores/alice-bridge'

import type { AliceChatAbortPayload, AliceChatAbortResult, AliceChatErrorEvent, AliceChatFinishEvent, AliceChatStartPayload, AliceChatStartResult, AliceChatStreamChunkEvent, AliceChatStreamDispatchPayload, AliceChatToolCallEvent, AliceChatToolResultEvent, AliceDialogueRespondedPayload, AliceLlmConfigPayload, AliceSafetyPermissionRequest } from '../shared/eventa'

import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { clearAliceBridge, setAliceBridge } from '@proj-airi/stage-ui/stores/alice-bridge'
import { useAliceEpoch1Store } from '@proj-airi/stage-ui/stores/alice-epoch1'
import { useAlicePresenceDispatcherStore } from '@proj-airi/stage-ui/stores/alice-presence-dispatcher'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { clearMcpToolBridge, setMcpToolBridge } from '@proj-airi/stage-ui/stores/mcp-tool-bridge'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import AliceHitlModal from './components/AliceHitlModal.vue'
import ResizeHandler from './components/ResizeHandler.vue'

import { sanitizeAliceChatStartPayloadForTransport, summarizeAliceChatStartPayloadForTransport } from '../shared/alice-chat-transport'
import {
  aliceChatAbortInvokeChannel,
  aliceChatStartInvokeChannel,
  aliceChatStreamChunk,
  aliceChatStreamDispatchChannel,
  aliceChatStreamError,
  aliceChatStreamFinish,
  aliceChatStreamToolCall,
  aliceChatStreamToolResult,
  aliceDialogueResponded,
  aliceKillSwitchStateChanged,

  aliceSafetyPermissionRequested,
  aliceSoulChanged,
  electronAliceAckDialogue,
  electronAliceAppendAuditLog,
  electronAliceAppendConversationTurn,
  electronAliceBootstrap,
  electronAliceChatAbort,
  electronAliceChatStart,
  electronAliceClearAllConversations,
  electronAliceDeleteAllData,
  electronAliceDeleteCardScope,
  electronAliceGetMemoryStats,
  electronAliceGetSensorySnapshot,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceListConversationTurns,
  electronAliceLlmGetConfig,
  electronAliceLlmSyncConfig,
  electronAliceMemoryImportLegacy,
  electronAliceMemoryRetrieveFacts,
  electronAliceMemoryUpsertFacts,
  electronAliceRealtimeExecute,
  electronAliceReminderSchedule,
  electronAliceReplayDialogues,
  electronAliceRunMemoryPrune,
  electronAliceSafetyResolvePermission,
  electronAliceSetActiveSession,
  electronAliceSubconsciousForceDream,
  electronAliceSubconsciousForceTick,
  electronAliceSubconsciousGetState,
  electronAliceUpdateMemoryStats,
  electronAliceUpdatePersonality,
  electronAliceUpdateSoul,
  electronGetServerChannelConfig,
  electronMcpCallTool,
  electronMcpListTools,
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginSetEnabled,
  electronPluginUnload,
  electronPluginUpdateCapability,
  electronSettingsNavigate,
  electronStartTrackMousePosition,
  i18nSetLocale,
  pluginProtocolListProviders,
  pluginProtocolListProvidersEventName,
} from '../shared/eventa'
import { initializeStageThreeRuntimeTraceBridge } from './bridges/stage-three-runtime-trace'
import { useServerChannelSettingsStore } from './stores/settings/server-channel'
import { useStageWindowLifecycleStore } from './stores/stage-window-lifecycle'

const { isDark: dark } = useTheme()
const i18n = useI18n()
const contextBridgeStore = useContextBridgeStore()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const providersStore = useProvidersStore()
const consciousnessStore = useConsciousnessStore()
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const { providers } = storeToRefs(providersStore)
const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
const serverChannelSettingsStore = useServerChannelSettingsStore()
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const { activeCardId } = storeToRefs(cardStore)
const chatSessionStore = useChatSessionStore()
const { activeSessionId } = storeToRefs(chatSessionStore)
const serverChannelStore = useModsServerChannelStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const analyticsStore = useSharedAnalyticsStore()
const aliceEpoch1Store = useAliceEpoch1Store()
const alicePresenceDispatcherStore = useAlicePresenceDispatcherStore()
const pluginHostInspectorStore = usePluginHostInspectorStore()
const stageWindowLifecycleStore = useStageWindowLifecycleStore()
const context = useElectronEventaContext()
usePerfTracerBridgeStore()
initializeStageThreeRuntimeTraceBridge()
void stageWindowLifecycleStore.initializeWindowLifecycleBridge()
const getServerChannelConfig = useElectronEventaInvoke(electronGetServerChannelConfig)
const listPlugins = useElectronEventaInvoke(electronPluginList)
const setPluginEnabled = useElectronEventaInvoke(electronPluginSetEnabled)
const loadEnabledPlugins = useElectronEventaInvoke(electronPluginLoadEnabled)
const loadPlugin = useElectronEventaInvoke(electronPluginLoad)
const unloadPlugin = useElectronEventaInvoke(electronPluginUnload)
const inspectPluginHost = useElectronEventaInvoke(electronPluginInspect)
const startTrackingCursorPoint = useElectronEventaInvoke(electronStartTrackMousePosition)
const reportPluginCapability = useElectronEventaInvoke(electronPluginUpdateCapability)
const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
const setLocale = useElectronEventaInvoke(i18nSetLocale)
const aliceBootstrap = useElectronEventaInvoke(electronAliceBootstrap)
const aliceGetSoul = useElectronEventaInvoke(electronAliceGetSoul)
const aliceInitializeGenesis = useElectronEventaInvoke(electronAliceInitializeGenesis)
const aliceUpdateSoul = useElectronEventaInvoke(electronAliceUpdateSoul)
const aliceUpdatePersonality = useElectronEventaInvoke(electronAliceUpdatePersonality)
const aliceGetKillSwitchState = useElectronEventaInvoke(electronAliceKillSwitchGetState)
const aliceSuspendKillSwitch = useElectronEventaInvoke(electronAliceKillSwitchSuspend)
const aliceResumeKillSwitch = useElectronEventaInvoke(electronAliceKillSwitchResume)
const aliceListConversationTurns = useElectronEventaInvoke(electronAliceListConversationTurns)
const aliceGetMemoryStats = useElectronEventaInvoke(electronAliceGetMemoryStats)
const aliceRunMemoryPrune = useElectronEventaInvoke(electronAliceRunMemoryPrune)
const aliceUpdateMemoryStats = useElectronEventaInvoke(electronAliceUpdateMemoryStats)
const aliceRetrieveMemoryFacts = useElectronEventaInvoke(electronAliceMemoryRetrieveFacts)
const aliceUpsertMemoryFacts = useElectronEventaInvoke(electronAliceMemoryUpsertFacts)
const aliceImportLegacyMemory = useElectronEventaInvoke(electronAliceMemoryImportLegacy)
const aliceAppendConversationTurn = useElectronEventaInvoke(electronAliceAppendConversationTurn)
const aliceSetActiveSession = useElectronEventaInvoke(electronAliceSetActiveSession)
const aliceAppendAuditLog = useElectronEventaInvoke(electronAliceAppendAuditLog)
const aliceRealtimeExecute = useElectronEventaInvoke(electronAliceRealtimeExecute)
const aliceGetSensorySnapshot = useElectronEventaInvoke(electronAliceGetSensorySnapshot)
const aliceGetSubconsciousState = useElectronEventaInvoke(electronAliceSubconsciousGetState)
const aliceForceSubconsciousTick = useElectronEventaInvoke(electronAliceSubconsciousForceTick)
const aliceForceDreaming = useElectronEventaInvoke(electronAliceSubconsciousForceDream)
const aliceSyncLlmConfig = useElectronEventaInvoke(electronAliceLlmSyncConfig)
const aliceGetLlmConfig = useElectronEventaInvoke(electronAliceLlmGetConfig)
const aliceAckDialogue = useElectronEventaInvoke(electronAliceAckDialogue)
const aliceReplayDialogues = useElectronEventaInvoke(electronAliceReplayDialogues)
const aliceChatStart = useElectronEventaInvoke(electronAliceChatStart)
const aliceChatAbort = useElectronEventaInvoke(electronAliceChatAbort)
const aliceReminderSchedule = useElectronEventaInvoke(electronAliceReminderSchedule)
const aliceClearAllConversations = useElectronEventaInvoke(electronAliceClearAllConversations)
const aliceDeleteCardScope = useElectronEventaInvoke(electronAliceDeleteCardScope)
const aliceDeleteAllData = useElectronEventaInvoke(electronAliceDeleteAllData)
const aliceResolvePermission = useElectronEventaInvoke(electronAliceSafetyResolvePermission)

const resolveAliceScope = () => ({ cardId: activeCardId.value || 'default' })
const isCurrentAliceCard = (cardId: string) => cardId === (activeCardId.value || 'default')
const currentHitlRequest = ref<AliceSafetyPermissionRequest | null>(null)
const pendingHitlRequests = ref<AliceSafetyPermissionRequest[]>([])
const hitlResolving = ref(false)
let llmSyncTimer: ReturnType<typeof setTimeout> | undefined
let lastLlmSyncSignature = ''
let llmConfigHydrating = false
const llmConfigHydrated = ref(false)
const pendingAliceChatStreams = new Map<string, {
  onStreamEvent?: (event: AliceBridgeChatStreamEvent) => Promise<void> | void
  resolve: () => void
  reject: (error: unknown) => void
}>()
const proactiveBackfillInFlight = new Set<string>()
const sessionReconcileInFlight = new Set<string>()
const handledDialogueRespondedKeys = new Set<string>()
const handledDialogueRespondedQueue: string[] = []
const handledDialogueRespondedMax = 600

function aliceChatStreamKey(cardId: string, turnId: string) {
  return `${cardId}:${turnId}`
}

function resolvePendingAliceStream(cardId: string, turnId: string) {
  return pendingAliceChatStreams.get(aliceChatStreamKey(cardId, turnId))
}

function settlePendingAliceStream(cardId: string, turnId: string) {
  pendingAliceChatStreams.delete(aliceChatStreamKey(cardId, turnId))
}

function createAliceAbortError(reason?: string) {
  return new DOMException(`A.L.I.C.E stream aborted: ${reason || 'manual'}`, 'AbortError')
}

function estimateJsonPayloadBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  }
  catch {
    return null
  }
}

function cloneProviderCredentials() {
  return JSON.parse(JSON.stringify(providers.value || {})) as Record<string, Record<string, unknown>>
}

function createLlmConfigPayload(): AliceLlmConfigPayload {
  return {
    activeProviderId: activeProvider.value || '',
    activeModelId: activeModel.value || '',
    providerCredentials: cloneProviderCredentials(),
  }
}

function normalizeCreatedAt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

async function acknowledgeDialogueDelivery(sessionIdRaw: string, turnIdRaw: string, createdAtRaw: unknown) {
  const sessionId = sessionIdRaw.trim()
  const turnId = turnIdRaw.trim()
  if (!sessionId || !turnId)
    return
  const createdAt = normalizeCreatedAt(createdAtRaw)
  try {
    await aliceAckDialogue({
      ...resolveAliceScope(),
      sessionId,
      turnId,
      createdAt,
    })
  }
  catch (error) {
    console.warn('[alice-renderer] failed to ack proactive dialogue delivery:', error)
  }
}

async function upsertProactiveAssistantTurn(payload: {
  sessionId: string
  turnId: string
  assistantText: string
  structured?: Record<string, unknown> | null
  createdAt: number
  setActive?: boolean
}) {
  const sessionId = payload.sessionId.trim()
  const turnId = payload.turnId.trim()
  const assistantText = payload.assistantText.trim()
  if (!sessionId || !turnId || !assistantText)
    return

  const ensuredSessionId = await chatSessionStore.ensureExternalSession(sessionId, {
    setActive: payload.setActive === true,
  })
  if (!ensuredSessionId)
    return

  const normalizedCreatedAt = normalizeCreatedAt(payload.createdAt)
  const structuredThought = typeof payload.structured?.thought === 'string'
    ? payload.structured.thought.trim()
    : ''
  const structuredEmotion = typeof payload.structured?.emotion === 'string'
    ? payload.structured.emotion.trim()
    : 'neutral'
  const structuredFormat: 'epoch1-v1' | 'fallback-v1'
    = payload.structured?.format === 'epoch1-v1'
      ? 'epoch1-v1'
      : 'fallback-v1'

  const sessionMessages = chatSessionStore.getSessionMessages(ensuredSessionId)
  const existing = sessionMessages.find(message => message.id === turnId && message.role === 'assistant')
  if (existing) {
    const existingAssistant = existing as any
    existingAssistant.content = assistantText
    existingAssistant.createdAt = normalizedCreatedAt
    existingAssistant.slices = [{ type: 'text', text: assistantText }]
    existingAssistant.tool_results = []
    existingAssistant.structured = {
      thought: structuredThought,
      emotion: structuredEmotion,
      reply: assistantText,
      format: structuredFormat,
    }
    existingAssistant.categorization = {
      speech: assistantText,
      reasoning: structuredThought,
    }
  }
  else {
    sessionMessages.push({
      id: turnId,
      role: 'assistant',
      content: assistantText,
      createdAt: normalizedCreatedAt,
      slices: [{ type: 'text', text: assistantText }],
      tool_results: [],
      structured: {
        thought: structuredThought,
        emotion: structuredEmotion,
        reply: assistantText,
        format: structuredFormat,
      },
      categorization: {
        speech: assistantText,
        reasoning: structuredThought,
      },
    })
  }

  chatSessionStore.persistSessionMessages(ensuredSessionId)
  await acknowledgeDialogueDelivery(ensuredSessionId, turnId, normalizedCreatedAt)
}

function normalizeContentText(raw: unknown) {
  return String(raw ?? '').trim()
}

function getMessageText(message: any) {
  if (!message)
    return ''
  if (typeof message.content === 'string')
    return message.content.trim()
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: unknown) => {
        if (typeof part === 'string')
          return part
        if (part && typeof part === 'object' && 'text' in part)
          return String((part as { text?: unknown }).text ?? '')
        return ''
      })
      .join('')
      .trim()
  }
  return ''
}

function sortSessionMessagesInPlace(messages: any[]) {
  messages.sort((left, right) => {
    const leftAt = normalizeCreatedAt(left?.createdAt)
    const rightAt = normalizeCreatedAt(right?.createdAt)
    if (leftAt !== rightAt)
      return leftAt - rightAt
    const leftRole = String(left?.role ?? '')
    const rightRole = String(right?.role ?? '')
    if (leftRole === rightRole)
      return 0
    if (leftRole === 'user')
      return -1
    if (rightRole === 'user')
      return 1
    return leftRole.localeCompare(rightRole)
  })
}

function findReplayMessageIndex(messages: any[], options: {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}) {
  const byIdIndex = messages.findIndex(item => item?.id === options.id && item?.role === options.role)
  if (byIdIndex >= 0)
    return byIdIndex

  const toleranceMs = options.role === 'assistant' ? 15_000 : 6_000
  return messages.findIndex((item) => {
    if (!item || item.role !== options.role)
      return false
    const itemText = getMessageText(item)
    if (itemText !== options.text)
      return false
    const itemCreatedAt = normalizeCreatedAt(item.createdAt)
    return Math.abs(itemCreatedAt - options.createdAt) <= toleranceMs
  })
}

async function reconcileSessionTurnsFromMain(sessionIdRaw: string) {
  const sessionId = sessionIdRaw.trim()
  if (!sessionId || sessionReconcileInFlight.has(sessionId))
    return

  sessionReconcileInFlight.add(sessionId)
  try {
    const ensuredSessionId = await chatSessionStore.ensureExternalSession(sessionId, {
      setActive: sessionId === activeSessionId.value,
    })
    if (!ensuredSessionId)
      return

    const rows = await aliceListConversationTurns({
      ...resolveAliceScope(),
      sessionId: ensuredSessionId,
      limit: 500,
    })
    if (!rows.length)
      return

    const sessionMessages = chatSessionStore.getSessionMessages(ensuredSessionId)
    let changed = false
    const orderedRows = [...rows].sort((a, b) => normalizeCreatedAt(a.createdAt) - normalizeCreatedAt(b.createdAt))
    for (const row of orderedRows) {
      const createdAt = normalizeCreatedAt(row.createdAt)
      const turnId = String(row.turnId ?? '').trim()
      if (!turnId)
        continue

      const userText = normalizeContentText(row.userText)
      if (userText) {
        const userId = `${turnId}:user`
        const userIndex = findReplayMessageIndex(sessionMessages as any[], {
          id: userId,
          role: 'user',
          text: userText,
          createdAt,
        })
        if (userIndex >= 0) {
          const existing = sessionMessages[userIndex] as any
          const beforeSignature = JSON.stringify({
            id: existing.id,
            content: existing.content,
            createdAt: existing.createdAt,
          })
          existing.id = userId
          existing.content = userText
          existing.createdAt = createdAt
          const afterSignature = JSON.stringify({
            id: existing.id,
            content: existing.content,
            createdAt: existing.createdAt,
          })
          if (beforeSignature !== afterSignature)
            changed = true
        }
        else {
          sessionMessages.push({
            id: userId,
            role: 'user',
            content: userText,
            createdAt,
          } as any)
          changed = true
        }
      }

      const assistantText = normalizeContentText(row.assistantText)
      if (assistantText) {
        const structured = row.structured && typeof row.structured === 'object'
          ? row.structured as Record<string, unknown>
          : {}
        const structuredThought = typeof structured.thought === 'string' ? structured.thought.trim() : ''
        const structuredEmotion = typeof structured.emotion === 'string' ? structured.emotion.trim() : 'neutral'
        const structuredFormat: 'epoch1-v1' | 'fallback-v1'
          = structured.format === 'epoch1-v1'
            ? 'epoch1-v1'
            : 'fallback-v1'
        const assistantIndex = findReplayMessageIndex(sessionMessages as any[], {
          id: turnId,
          role: 'assistant',
          text: assistantText,
          createdAt,
        })
        if (assistantIndex >= 0) {
          const existing = sessionMessages[assistantIndex] as any
          const beforeSignature = JSON.stringify({
            id: existing.id,
            content: existing.content,
            createdAt: existing.createdAt,
            thought: existing.structured?.thought,
            emotion: existing.structured?.emotion,
          })
          existing.id = turnId
          existing.content = assistantText
          existing.createdAt = createdAt
          existing.slices = [{ type: 'text', text: assistantText }]
          existing.tool_results = Array.isArray(existing.tool_results) ? existing.tool_results : []
          existing.structured = {
            thought: structuredThought,
            emotion: structuredEmotion,
            reply: assistantText,
            format: structuredFormat,
          }
          existing.categorization = {
            speech: assistantText,
            reasoning: structuredThought,
          }
          const afterSignature = JSON.stringify({
            id: existing.id,
            content: existing.content,
            createdAt: existing.createdAt,
            thought: existing.structured?.thought,
            emotion: existing.structured?.emotion,
          })
          if (beforeSignature !== afterSignature)
            changed = true
        }
        else {
          sessionMessages.push({
            id: turnId,
            role: 'assistant',
            content: assistantText,
            createdAt,
            slices: [{ type: 'text', text: assistantText }],
            tool_results: [],
            structured: {
              thought: structuredThought,
              emotion: structuredEmotion,
              reply: assistantText,
              format: structuredFormat,
            },
            categorization: {
              speech: assistantText,
              reasoning: structuredThought,
            },
          } as any)
          changed = true
        }
      }
    }

    if (changed) {
      sortSessionMessagesInPlace(sessionMessages as any[])
      chatSessionStore.persistSessionMessages(ensuredSessionId)
    }
  }
  catch (error) {
    console.warn('[alice-renderer] failed to reconcile session turns from main:', error)
  }
  finally {
    sessionReconcileInFlight.delete(sessionId)
  }
}

async function backfillProactiveTurnsForSession(sessionIdRaw: string) {
  const sessionId = sessionIdRaw.trim()
  if (!sessionId || proactiveBackfillInFlight.has(sessionId))
    return

  proactiveBackfillInFlight.add(sessionId)
  try {
    const dialogues = await aliceReplayDialogues({
      ...resolveAliceScope(),
      sessionId,
      limit: 200,
    })
    const sorted = [...dialogues].sort((a, b) => normalizeCreatedAt(a.createdAt) - normalizeCreatedAt(b.createdAt))
    for (const row of sorted) {
      if (row.origin !== 'subconscious-proactive')
        continue
      const assistantText = row.structured?.reply?.trim()
      if (!assistantText)
        continue
      await upsertProactiveAssistantTurn({
        sessionId,
        turnId: row.turnId,
        assistantText,
        structured: row.structured as unknown as Record<string, unknown>,
        createdAt: normalizeCreatedAt(row.createdAt),
      })
    }
  }
  catch (error) {
    console.warn('[alice-renderer] failed to backfill proactive turns:', error)
  }
  finally {
    proactiveBackfillInFlight.delete(sessionId)
  }
}

function scheduleMainLlmConfigSync() {
  if (!llmConfigHydrated.value)
    return
  const payload = createLlmConfigPayload()
  const signature = JSON.stringify(payload)
  if (signature === lastLlmSyncSignature)
    return

  if (llmSyncTimer)
    clearTimeout(llmSyncTimer)
  llmSyncTimer = setTimeout(() => {
    lastLlmSyncSignature = signature
    void aliceSyncLlmConfig(payload)
  }, 120)
}

async function hydrateMainLlmConfig() {
  if (llmConfigHydrating)
    return
  llmConfigHydrating = true
  try {
    const remote = await aliceGetLlmConfig()
    const remoteCredentials = remote.providerCredentials && typeof remote.providerCredentials === 'object'
      ? remote.providerCredentials
      : {}
    if (Object.keys(remoteCredentials).length > 0) {
      providers.value = JSON.parse(JSON.stringify(remoteCredentials))
    }
    if (remote.activeProviderId?.trim()) {
      activeProvider.value = remote.activeProviderId.trim()
    }
    if (remote.activeModelId?.trim()) {
      activeModel.value = remote.activeModelId.trim()
    }
    lastLlmSyncSignature = JSON.stringify({
      activeProviderId: remote.activeProviderId || '',
      activeModelId: remote.activeModelId || '',
      providerCredentials: remoteCredentials,
    } satisfies AliceLlmConfigPayload)
  }
  catch (error) {
    console.warn('[alice-renderer] failed to hydrate llm config from main process:', error)
  }
  finally {
    llmConfigHydrating = false
    llmConfigHydrated.value = true
  }
}

async function invokeAliceChatStartTransport(payload: AliceChatStartPayload): Promise<AliceChatStartResult> {
  const invoke = window.electron?.ipcRenderer?.invoke
  if (typeof invoke === 'function')
    return await invoke(aliceChatStartInvokeChannel, payload) as AliceChatStartResult
  return await aliceChatStart(payload)
}

async function invokeAliceChatAbortTransport(payload: AliceChatAbortPayload): Promise<AliceChatAbortResult> {
  const invoke = window.electron?.ipcRenderer?.invoke
  if (typeof invoke === 'function')
    return await invoke(aliceChatAbortInvokeChannel, payload) as AliceChatAbortResult
  return await aliceChatAbort(payload)
}

function handleAliceChatStreamChunk(payload?: AliceChatStreamChunkEvent) {
  if (!payload)
    return
  const pending = resolvePendingAliceStream(payload.cardId, payload.turnId)
  if (!pending)
    return
  void pending.onStreamEvent?.({
    type: 'text-delta',
    text: payload.text,
  })
}

function handleAliceChatStreamToolCall(payload?: AliceChatToolCallEvent) {
  if (!payload)
    return
  const pending = resolvePendingAliceStream(payload.cardId, payload.turnId)
  if (!pending)
    return
  void pending.onStreamEvent?.({
    type: 'tool-call',
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    args: JSON.stringify(payload.arguments ?? {}),
    toolCallType: 'function',
  })
}

function handleAliceChatStreamToolResult(payload?: AliceChatToolResultEvent) {
  if (!payload)
    return
  const pending = resolvePendingAliceStream(payload.cardId, payload.turnId)
  if (!pending)
    return
  void pending.onStreamEvent?.({
    type: 'tool-result',
    toolCallId: payload.toolCallId,
    result: payload.result,
  })
}

function handleAliceChatStreamError(payload?: AliceChatErrorEvent) {
  if (!payload)
    return
  const pending = resolvePendingAliceStream(payload.cardId, payload.turnId)
  if (!pending)
    return
  void pending.onStreamEvent?.({
    type: 'error',
    error: payload.error,
  })
  pending.reject(new Error(String(payload.error || 'A.L.I.C.E stream error')))
}

function handleAliceChatStreamFinish(payload?: AliceChatFinishEvent) {
  if (!payload)
    return
  const pending = resolvePendingAliceStream(payload.cardId, payload.turnId)
  if (!pending)
    return
  if (payload.status === 'completed') {
    void pending.onStreamEvent?.({ type: 'finish' })
    pending.resolve()
    return
  }
  if (payload.status === 'aborted') {
    pending.reject(createAliceAbortError(payload.finishReason))
    return
  }
  const error = payload.error || 'A.L.I.C.E stream failed'
  void pending.onStreamEvent?.({ type: 'error', error })
  pending.reject(new Error(error))
}

function createDialogueRespondedDedupKey(payload: AliceDialogueRespondedPayload) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  const turnId = typeof payload.turnId === 'string' ? payload.turnId.trim() : ''
  const createdAt = typeof payload.createdAt === 'number' && Number.isFinite(payload.createdAt)
    ? Math.floor(payload.createdAt)
    : 0
  return `${payload.cardId}::${sessionId}::${turnId}::${createdAt}`
}

function registerHandledDialogueResponded(payload: AliceDialogueRespondedPayload) {
  const key = createDialogueRespondedDedupKey(payload)
  if (handledDialogueRespondedKeys.has(key))
    return false
  handledDialogueRespondedKeys.add(key)
  handledDialogueRespondedQueue.push(key)
  if (handledDialogueRespondedQueue.length > handledDialogueRespondedMax) {
    const dropped = handledDialogueRespondedQueue.shift()
    if (dropped)
      handledDialogueRespondedKeys.delete(dropped)
  }
  return true
}

function handleAliceDialogueRespondedPayload(payload?: AliceDialogueRespondedPayload) {
  if (!payload || !isCurrentAliceCard(payload.cardId))
    return
  if (!registerHandledDialogueResponded(payload))
    return

  const targetSessionId = payload.sessionId?.trim() || activeSessionId.value
  if (targetSessionId)
    void reconcileSessionTurnsFromMain(targetSessionId)

  if (payload.origin === 'subconscious-proactive' && payload.structured?.reply?.trim()) {
    if (targetSessionId) {
      void upsertProactiveAssistantTurn({
        sessionId: targetSessionId,
        turnId: payload.turnId,
        assistantText: payload.structured.reply,
        structured: payload.structured as unknown as Record<string, unknown>,
        createdAt: payload.createdAt,
        setActive: targetSessionId === activeSessionId.value,
      })
    }
  }

  void alicePresenceDispatcherStore.dispatchDialogueResponded(payload)
}

function handleAliceChatStreamDispatch(payload?: AliceChatStreamDispatchPayload) {
  if (!payload)
    return
  switch (payload.eventType) {
    case 'chunk':
      handleAliceChatStreamChunk(payload.body)
      return
    case 'tool-call':
      handleAliceChatStreamToolCall(payload.body)
      return
    case 'tool-result':
      handleAliceChatStreamToolResult(payload.body)
      return
    case 'finish':
      handleAliceChatStreamFinish(payload.body)
      return
    case 'error':
      handleAliceChatStreamError(payload.body)
      return
    case 'dialogue-responded':
      handleAliceDialogueRespondedPayload(payload.body)
  }
}

const removeAliceChatStreamDispatchListener = window.electron?.ipcRenderer?.on(
  aliceChatStreamDispatchChannel,
  (_event, payload) => handleAliceChatStreamDispatch(payload as AliceChatStreamDispatchPayload),
)

function popNextHitlRequest() {
  if (currentHitlRequest.value || pendingHitlRequests.value.length === 0)
    return
  const [next, ...rest] = pendingHitlRequests.value
  pendingHitlRequests.value = rest
  currentHitlRequest.value = next ?? null
}

async function resolveHitlDecision(payload: { allow: boolean, rememberSession: boolean }) {
  const request = currentHitlRequest.value
  if (!request || hitlResolving.value)
    return

  hitlResolving.value = true
  try {
    await aliceResolvePermission({
      cardId: request.cardId,
      token: request.token,
      requestId: request.requestId,
      allow: payload.allow,
      rememberSession: payload.allow ? payload.rememberSession : false,
      reason: payload.allow ? 'user-approved' : 'user-denied',
    })
  }
  finally {
    hitlResolving.value = false
    currentHitlRequest.value = null
    popNextHitlRequest()
  }
}

setAliceBridge({
  bootstrap: async () => await aliceBootstrap(resolveAliceScope()),
  getSoul: async () => await aliceGetSoul(resolveAliceScope()),
  initializeGenesis: async payload => await aliceInitializeGenesis({ ...resolveAliceScope(), ...payload }),
  updateSoul: async payload => await aliceUpdateSoul({ ...resolveAliceScope(), ...payload }),
  updatePersonality: async payload => await aliceUpdatePersonality({ ...resolveAliceScope(), ...payload }),
  getKillSwitchState: async () => await aliceGetKillSwitchState(resolveAliceScope()),
  suspendKillSwitch: async payload => await aliceSuspendKillSwitch({ ...resolveAliceScope(), ...payload }),
  resumeKillSwitch: async payload => await aliceResumeKillSwitch({ ...resolveAliceScope(), ...payload }),
  getMemoryStats: async () => await aliceGetMemoryStats(resolveAliceScope()),
  runMemoryPrune: async () => await aliceRunMemoryPrune(resolveAliceScope()),
  updateMemoryStats: async payload => await aliceUpdateMemoryStats({ ...resolveAliceScope(), ...payload }),
  retrieveMemoryFacts: async payload => await aliceRetrieveMemoryFacts({ ...resolveAliceScope(), ...payload }),
  upsertMemoryFacts: async payload => await aliceUpsertMemoryFacts({ ...resolveAliceScope(), ...payload }),
  importLegacyMemory: async payload => await aliceImportLegacyMemory({ ...resolveAliceScope(), ...payload }),
  appendConversationTurn: async payload => await aliceAppendConversationTurn({ ...resolveAliceScope(), ...payload }),
  setActiveSession: async payload => await aliceSetActiveSession({ ...resolveAliceScope(), ...payload }),
  appendAuditLog: async payload => await aliceAppendAuditLog({ ...resolveAliceScope(), ...payload }),
  realtimeExecute: async payload => await aliceRealtimeExecute({ ...resolveAliceScope(), ...payload }),
  getSensorySnapshot: async () => await aliceGetSensorySnapshot(resolveAliceScope()),
  getSubconsciousState: async () => await aliceGetSubconsciousState(resolveAliceScope()),
  forceSubconsciousTick: async () => await aliceForceSubconsciousTick(resolveAliceScope()),
  forceDreaming: async payload => await aliceForceDreaming({ ...resolveAliceScope(), ...payload }),
  syncLlmConfig: async payload => await aliceSyncLlmConfig(payload),
  getLlmConfig: async () => await aliceGetLlmConfig(),
  chatStart: async payload => await invokeAliceChatStartTransport({ ...resolveAliceScope(), ...payload }),
  chatAbort: async payload => await invokeAliceChatAbortTransport({ ...resolveAliceScope(), ...payload }),
  reminderSchedule: async payload => await aliceReminderSchedule({ ...resolveAliceScope(), ...payload }),
  streamChat: async (payload, options) => await new Promise<void>(async (resolve, reject) => {
    const scope = resolveAliceScope()
    const key = aliceChatStreamKey(scope.cardId, payload.turnId)
    const previousPending = pendingAliceChatStreams.get(key)
    if (previousPending) {
      // NOTICE: Retry path may restart the same turnId after timeout.
      // Forcefully supersede the old pending stream so retried stream can proceed.
      await invokeAliceChatAbortTransport({
        ...scope,
        turnId: payload.turnId,
        reason: 'renderer-restart',
      }).catch(() => {})
      previousPending.reject(new Error(`A.L.I.C.E stream superseded by restart for turn ${payload.turnId}`))
      pendingAliceChatStreams.delete(key)
    }

    let disposed = false
    const abortHandler = () => {
      void invokeAliceChatAbortTransport({
        ...scope,
        turnId: payload.turnId,
        reason: 'renderer-abort',
      })
    }
    const dispose = () => {
      if (disposed)
        return
      disposed = true
      options.abortSignal?.removeEventListener('abort', abortHandler)
      settlePendingAliceStream(scope.cardId, payload.turnId)
    }
    const rejectAndDispose = (error: unknown) => {
      dispose()
      reject(error)
    }
    const resolveAndDispose = () => {
      dispose()
      resolve()
    }

    pendingAliceChatStreams.set(key, {
      onStreamEvent: options.onStreamEvent,
      resolve: resolveAndDispose,
      reject: rejectAndDispose,
    })

    if (options.abortSignal?.aborted) {
      await invokeAliceChatAbortTransport({
        ...scope,
        turnId: payload.turnId,
        reason: 'renderer-abort',
      })
      rejectAndDispose(createAliceAbortError('renderer-abort'))
      return
    }

    options.abortSignal?.addEventListener('abort', abortHandler, { once: true })

    const transportPayloadResult = sanitizeAliceChatStartPayloadForTransport({
      ...scope,
      ...payload,
    })
    const transportPayload = transportPayloadResult.value
    const transportPayloadSummary = summarizeAliceChatStartPayloadForTransport(transportPayload)

    try {
      void aliceAppendAuditLog({
        ...scope,
        level: 'notice',
        category: 'alice.main-gateway',
        action: 'renderer-chat-start-requested',
        message: 'Renderer requested main-process Alicization chat stream startup.',
        payload: {
          turnId: transportPayload.turnId,
          providerId: transportPayload.providerId,
          model: transportPayload.model,
          messageCount: Array.isArray(transportPayload.messages) ? transportPayload.messages.length : 0,
          payloadBytes: estimateJsonPayloadBytes(transportPayload),
          transport: typeof window.electron?.ipcRenderer?.invoke === 'function' ? 'direct-ipc' : 'eventa',
          transportPayload: transportPayloadSummary,
          transportSanitization: transportPayloadResult.report.changed
            ? {
                droppedCount: transportPayloadResult.report.droppedCount,
                coercedCount: transportPayloadResult.report.coercedCount,
                droppedPaths: transportPayloadResult.report.droppedPaths,
                coercedPaths: transportPayloadResult.report.coercedPaths,
              }
            : undefined,
        },
      }).catch(() => {})
      let start = await invokeAliceChatStartTransport(transportPayload)
      if (!start.accepted && start.state === 'duplicate-running') {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)))
          start = await invokeAliceChatStartTransport(transportPayload)
          if (start.accepted || start.state !== 'duplicate-running')
            break
        }
      }
      void aliceAppendAuditLog({
        ...scope,
        level: start.accepted ? 'notice' : 'warning',
        category: 'alice.main-gateway',
        action: 'renderer-chat-start-resolved',
        message: start.accepted
          ? 'Renderer received accepted response for main-process Alicization chat stream startup.'
          : 'Renderer received rejected response for main-process Alicization chat stream startup.',
        payload: {
          turnId: payload.turnId,
          accepted: start.accepted,
          state: start.state,
          reason: start.reason,
        },
      }).catch(() => {})
      if (!start.accepted) {
        const reason = typeof start.reason === 'string' && start.reason.trim()
          ? ` reason=${start.reason}`
          : ''
        const state = typeof start.state === 'string' ? start.state : 'unknown'
        rejectAndDispose(new Error(`A.L.I.C.E stream start rejected (state=${state}) for turn ${payload.turnId}.${reason}`))
      }
    }
    catch (error) {
      void aliceAppendAuditLog({
        ...scope,
        level: 'warning',
        category: 'alice.main-gateway',
        action: 'renderer-chat-start-error',
        message: 'Renderer chat start invoke failed before stream handshake completed.',
        payload: {
          turnId: payload.turnId,
          reason: error instanceof Error ? error.message : String(error),
          transportPayload: transportPayloadSummary,
          transportSanitization: transportPayloadResult.report.changed
            ? {
                droppedCount: transportPayloadResult.report.droppedCount,
                coercedCount: transportPayloadResult.report.coercedCount,
                droppedPaths: transportPayloadResult.report.droppedPaths,
                coercedPaths: transportPayloadResult.report.coercedPaths,
              }
            : undefined,
        },
      }).catch(() => {})
      rejectAndDispose(error)
    }
  }),
  clearAllConversations: async () => await aliceClearAllConversations(),
  deleteCardScope: async scope => await aliceDeleteCardScope(scope),
  deleteAllData: async () => await aliceDeleteAllData(),
})

context.value.on(aliceSoulChanged, (event) => {
  const payload = event?.body
  if (!payload || !isCurrentAliceCard(payload.cardId))
    return
  const { cardId: _cardId, ...snapshot } = payload
  aliceEpoch1Store.setSoulSnapshot(snapshot)
})

context.value.on(aliceKillSwitchStateChanged, (event) => {
  const payload = event?.body
  if (!payload || !isCurrentAliceCard(payload.cardId))
    return
  const { cardId: _cardId, ...snapshot } = payload
  aliceEpoch1Store.setKillSwitchSnapshot(snapshot)
})

context.value.on(aliceDialogueResponded, event => handleAliceDialogueRespondedPayload(event?.body))

context.value.on(aliceSafetyPermissionRequested, (event) => {
  const payload = event?.body
  if (!payload || !isCurrentAliceCard(payload.cardId))
    return
  pendingHitlRequests.value = [...pendingHitlRequests.value, payload]
  popNextHitlRequest()
})

context.value.on(aliceChatStreamChunk, (event) => {
  handleAliceChatStreamChunk(event?.body)
})

context.value.on(aliceChatStreamToolCall, (event) => {
  handleAliceChatStreamToolCall(event?.body)
})

context.value.on(aliceChatStreamToolResult, (event) => {
  handleAliceChatStreamToolResult(event?.body)
})

context.value.on(aliceChatStreamError, (event) => {
  handleAliceChatStreamError(event?.body)
})

context.value.on(aliceChatStreamFinish, (event) => {
  handleAliceChatStreamFinish(event?.body)
})

// NOTICE: register plugin host bridge during setup to avoid race with pages using it in immediate watchers.
pluginHostInspectorStore.setBridge({
  list: () => listPlugins(),
  setEnabled: payload => setPluginEnabled(payload),
  loadEnabled: () => loadEnabledPlugins(),
  load: payload => loadPlugin(payload),
  unload: payload => unloadPlugin(payload),
  inspect: () => inspectPluginHost(),
})

// NOTICE: MCP tools are declared from stage-ui and executed during model streaming.
// Register runtime bridge during setup to avoid missing bridge in early tool invocations.
setMcpToolBridge({
  listTools: () => listMcpTools(),
  callTool: payload => callMcpTool({
    ...payload,
    cardId: activeCardId.value || 'default',
  }),
})

watch(language, () => {
  i18n.locale.value = language.value
  setLocale(language.value)
})

watch(activeCardId, () => {
  currentHitlRequest.value = null
  pendingHitlRequests.value = []
  hitlResolving.value = false
  proactiveBackfillInFlight.clear()
  void aliceEpoch1Store.refreshSoul()
  void aliceEpoch1Store.syncKillSwitchState()
  void aliceEpoch1Store.refreshMemoryStats()
  if (activeSessionId.value?.trim()) {
    void Promise.all([
      backfillProactiveTurnsForSession(activeSessionId.value),
      reconcileSessionTurnsFromMain(activeSessionId.value),
    ])
  }
}, { immediate: true })

watch(activeSessionId, (sessionId) => {
  if (!sessionId?.trim())
    return
  void aliceSetActiveSession({
    ...resolveAliceScope(),
    sessionId,
  })
  void Promise.all([
    backfillProactiveTurnsForSession(sessionId),
    reconcileSessionTurnsFromMain(sessionId),
  ])
}, { immediate: true })

watch([activeProvider, activeModel, providers], () => scheduleMainLlmConfigSync(), { deep: true, immediate: true })

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

context.value.on(electronSettingsNavigate, (event) => {
  const targetRoute = event?.body?.route
  if (!targetRoute || route.fullPath === targetRoute) {
    return
  }

  void router.push(targetRoute).catch((error) => {
    console.warn('Failed to navigate settings window:', error)
  })
})

onMounted(async () => {
  analyticsStore.initialize()
  cardStore.initialize()
  await aliceEpoch1Store.initialize()

  await chatSessionStore.initialize()
  await hydrateMainLlmConfig()
  scheduleMainLlmConfigSync()
  if (activeSessionId.value?.trim()) {
    await Promise.all([
      backfillProactiveTurnsForSession(activeSessionId.value),
      reconcileSessionTurnsFromMain(activeSessionId.value),
    ])
  }
  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()

  const serverChannelConfig = await getServerChannelConfig()
  serverChannelSettingsStore.websocketTlsConfig = serverChannelConfig.tlsConfig

  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  await contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()
  await startTrackingCursorPoint()

  // Expose stage provider definitions to plugin host APIs.
  defineInvokeHandler(context.value, pluginProtocolListProviders, async () => listProvidersForPluginHost())

  if (shouldPublishPluginHostCapabilities()) {
    await reportPluginCapability({
      key: pluginProtocolListProvidersEventName,
      state: 'ready',
      metadata: {
        source: 'stage-ui',
      },
    })
  }
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
  if (llmSyncTimer)
    clearTimeout(llmSyncTimer)
  removeAliceChatStreamDispatchListener?.()
  for (const [key, pending] of pendingAliceChatStreams.entries()) {
    pendingAliceChatStreams.delete(key)
    pending.reject(new Error('Renderer unmounted before A.L.I.C.E stream completed.'))
  }
  contextBridgeStore.dispose()
  clearMcpToolBridge()
  aliceEpoch1Store.dispose()
  clearAliceBridge()
})
</script>

<template>
  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>
  <AliceHitlModal
    :request="currentHitlRequest"
    :resolving="hitlResolving"
    @decide="resolveHitlDecision"
  />
  <ResizeHandler />
  <RouterView />
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
