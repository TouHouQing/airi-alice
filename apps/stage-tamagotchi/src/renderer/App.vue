<script setup lang="ts">
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
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import ResizeHandler from './components/ResizeHandler.vue'

import {
  aliceDialogueResponded,
  aliceKillSwitchStateChanged,
  aliceSoulChanged,
  electronAliceAppendAuditLog,
  electronAliceAppendConversationTurn,
  electronAliceBootstrap,
  electronAliceDeleteCardScope,
  electronAliceGetMemoryStats,
  electronAliceGetSensorySnapshot,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
  electronAliceMemoryImportLegacy,
  electronAliceMemoryRetrieveFacts,
  electronAliceMemoryUpsertFacts,
  electronAliceRealtimeExecute,
  electronAliceRunMemoryPrune,
  electronAliceUpdateMemoryStats,
  electronAliceUpdatePersonality,
  electronAliceUpdateSoul,
  electronGetServerChannelConfig,
  electronMcpCallTool,
  electronMcpListTools,
  electronOpenSettings,
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginSetEnabled,
  electronPluginUnload,
  electronPluginUpdateCapability,
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
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const serverChannelSettingsStore = useServerChannelSettingsStore()
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const { activeCardId } = storeToRefs(cardStore)
const chatSessionStore = useChatSessionStore()
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
const aliceAppendAuditLog = useElectronEventaInvoke(electronAliceAppendAuditLog)
const aliceRealtimeExecute = useElectronEventaInvoke(electronAliceRealtimeExecute)
const aliceGetSensorySnapshot = useElectronEventaInvoke(electronAliceGetSensorySnapshot)
const aliceDeleteCardScope = useElectronEventaInvoke(electronAliceDeleteCardScope)

const resolveAliceScope = () => ({ cardId: activeCardId.value || 'default' })
const isCurrentAliceCard = (cardId: string) => cardId === (activeCardId.value || 'default')

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
  appendAuditLog: async payload => await aliceAppendAuditLog({ ...resolveAliceScope(), ...payload }),
  realtimeExecute: async payload => await aliceRealtimeExecute({ ...resolveAliceScope(), ...payload }),
  getSensorySnapshot: async () => await aliceGetSensorySnapshot(resolveAliceScope()),
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
  void aliceEpoch1Store.refreshSoul()
  void aliceEpoch1Store.syncKillSwitchState()
  void aliceEpoch1Store.refreshMemoryStats()
}, { immediate: true })

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

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

  // Listen for open-settings IPC message from main process
  defineInvokeHandler(context.value, electronOpenSettings, () => router.push('/settings'))
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
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
