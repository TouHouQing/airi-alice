<script setup lang="ts">
import type { AliceBridgeChatStreamEvent } from '@proj-airi/stage-ui/stores/alice-bridge'

import type { AliceChatAbortPayload, AliceChatAbortResult, AliceChatErrorEvent, AliceChatFinishEvent, AliceChatStartPayload, AliceChatStartResult, AliceChatStreamChunkEvent, AliceChatStreamDispatchPayload, AliceChatToolCallEvent, AliceChatToolResultEvent, AliceSafetyPermissionRequest } from '../shared/eventa'

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
  electronAliceAppendAuditLog,
  electronAliceAppendConversationTurn,
  electronAliceBootstrap,
  electronAliceChatAbort,
  electronAliceChatStart,
  electronAliceDeleteCardScope,
  electronAliceGetMemoryStats,
  electronAliceGetSensorySnapshot,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceLlmGetConfig,
  electronAliceLlmSyncConfig,
  electronAliceMemoryImportLegacy,
  electronAliceMemoryRetrieveFacts,
  electronAliceMemoryUpsertFacts,
  electronAliceRealtimeExecute,
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
const aliceChatStart = useElectronEventaInvoke(electronAliceChatStart)
const aliceChatAbort = useElectronEventaInvoke(electronAliceChatAbort)
const aliceDeleteCardScope = useElectronEventaInvoke(electronAliceDeleteCardScope)
const aliceResolvePermission = useElectronEventaInvoke(electronAliceSafetyResolvePermission)

const resolveAliceScope = () => ({ cardId: activeCardId.value || 'default' })
const isCurrentAliceCard = (cardId: string) => cardId === (activeCardId.value || 'default')
const currentHitlRequest = ref<AliceSafetyPermissionRequest | null>(null)
const pendingHitlRequests = ref<AliceSafetyPermissionRequest[]>([])
const hitlResolving = ref(false)
let llmSyncTimer: ReturnType<typeof setTimeout> | undefined
let lastLlmSyncSignature = ''
const pendingAliceChatStreams = new Map<string, {
  onStreamEvent?: (event: AliceBridgeChatStreamEvent) => Promise<void> | void
  resolve: () => void
  reject: (error: unknown) => void
}>()

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
  suspendKillSwitch: async payload => await aliceSuspendKillSwitch({ ...resolveAliceScope(), ...(payload ?? {}) }),
  resumeKillSwitch: async payload => await aliceResumeKillSwitch({ ...resolveAliceScope(), ...(payload ?? {}) }),
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
  forceDreaming: async payload => await aliceForceDreaming({ ...resolveAliceScope(), ...(payload ?? {}) }),
  syncLlmConfig: async payload => await aliceSyncLlmConfig(payload),
  getLlmConfig: async () => await aliceGetLlmConfig(),
  chatStart: async payload => await invokeAliceChatStartTransport({ ...resolveAliceScope(), ...payload }),
  chatAbort: async payload => await invokeAliceChatAbortTransport({ ...resolveAliceScope(), ...payload }),
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
  deleteCardScope: async scope => await aliceDeleteCardScope(scope),
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

context.value.on(aliceDialogueResponded, (event) => {
  const payload = event?.body
  if (!payload || !isCurrentAliceCard(payload.cardId))
    return
  void alicePresenceDispatcherStore.dispatchDialogueResponded(payload)
})

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
  void aliceEpoch1Store.refreshSoul()
  void aliceEpoch1Store.syncKillSwitchState()
  void aliceEpoch1Store.refreshMemoryStats()
}, { immediate: true })

watch(activeSessionId, (sessionId) => {
  if (!sessionId?.trim())
    return
  void aliceSetActiveSession({
    ...resolveAliceScope(),
    sessionId,
  })
}, { immediate: true })

watch([activeProvider, activeModel, providers], () => {
  const nextCredentials = JSON.parse(JSON.stringify(providers.value || {})) as Record<string, Record<string, unknown>>
  const payload = {
    activeProviderId: activeProvider.value || '',
    activeModelId: activeModel.value || '',
    providerCredentials: nextCredentials,
  }
  const signature = JSON.stringify(payload)
  if (signature === lastLlmSyncSignature)
    return

  if (llmSyncTimer)
    clearTimeout(llmSyncTimer)
  llmSyncTimer = setTimeout(() => {
    lastLlmSyncSignature = signature
    void aliceSyncLlmConfig(payload)
  }, 120)
}, { deep: true, immediate: true })

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
