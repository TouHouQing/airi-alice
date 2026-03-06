<script setup lang="ts">
import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { clearAliceBridge, setAliceBridge } from '@proj-airi/stage-ui/stores/alice-bridge'
import { useAliceEpoch1Store } from '@proj-airi/stage-ui/stores/alice-epoch1'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { clearMcpToolBridge, setMcpToolBridge } from '@proj-airi/stage-ui/stores/mcp-tool-bridge'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useOnboardingStore } from '@proj-airi/stage-ui/stores/onboarding'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import ResizeHandler from './components/ResizeHandler.vue'

import {
  aliceKillSwitchStateChanged,
  aliceSoulChanged,
  electronAliceBootstrap,
  electronAliceGetMemoryStats,
  electronAliceGetSoul,
  electronAliceInitializeGenesis,
  electronAliceKillSwitchGetState,
  electronAliceKillSwitchResume,
  electronAliceKillSwitchSuspend,
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
import { useServerChannelSettingsStore } from './stores/settings/server-channel'

const { isDark: dark } = useTheme()
const i18n = useI18n()
const contextBridgeStore = useContextBridgeStore()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const serverChannelSettingsStore = useServerChannelSettingsStore()
const onboardingStore = useOnboardingStore()
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const chatSessionStore = useChatSessionStore()
const serverChannelStore = useModsServerChannelStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const aliceEpoch1Store = useAliceEpoch1Store()
const analyticsStore = useSharedAnalyticsStore()
const pluginHostInspectorStore = usePluginHostInspectorStore()
const {
  needsGenesis: aliceNeedsGenesis,
  soul: aliceSoulSnapshot,
  genesisConflictCandidate,
} = storeToRefs(aliceEpoch1Store)
usePerfTracerBridgeStore()

const context = useElectronEventaContext()
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

const showGenesisDialog = computed(() => aliceNeedsGenesis.value)
const genesisForm = ref({
  hostName: '',
  mindAge: 15,
  obedience: 0.5,
  liveliness: 0.5,
  sensibility: 0.5,
})
const genesisError = ref('')
const genesisLoading = ref(false)

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
  callTool: payload => callMcpTool(payload),
})

setAliceBridge({
  bootstrap: () => aliceBootstrap(),
  getSoul: () => aliceGetSoul(),
  initializeGenesis: payload => aliceInitializeGenesis(payload),
  updateSoul: payload => aliceUpdateSoul(payload),
  updatePersonality: payload => aliceUpdatePersonality(payload),
  getKillSwitchState: () => aliceGetKillSwitchState(),
  suspendKillSwitch: payload => aliceSuspendKillSwitch(payload),
  resumeKillSwitch: payload => aliceResumeKillSwitch(payload),
  getMemoryStats: () => aliceGetMemoryStats(),
  runMemoryPrune: () => aliceRunMemoryPrune(),
  updateMemoryStats: payload => aliceUpdateMemoryStats(payload),
})

function prefillGenesisFormFromSoul() {
  const snapshot = genesisConflictCandidate.value ?? aliceSoulSnapshot.value
  if (!snapshot)
    return

  genesisForm.value = {
    hostName: snapshot.frontmatter.profile.hostName || genesisForm.value.hostName,
    mindAge: snapshot.frontmatter.profile.mindAge || genesisForm.value.mindAge,
    obedience: snapshot.frontmatter.personality.obedience,
    liveliness: snapshot.frontmatter.personality.liveliness,
    sensibility: snapshot.frontmatter.personality.sensibility,
  }
}

watch([aliceSoulSnapshot, genesisConflictCandidate], () => {
  if (showGenesisDialog.value)
    prefillGenesisFormFromSoul()
}, { immediate: true })

async function submitGenesis(allowOverwrite = false) {
  genesisError.value = ''
  genesisLoading.value = true
  try {
    const result = await aliceEpoch1Store.initializeGenesis({
      ...genesisForm.value,
      allowOverwrite,
    })
    if (result?.conflict) {
      genesisError.value = '检测到 SOUL.md 在初始化期间被外部修改，请确认后覆盖或调整表单。'
      prefillGenesisFormFromSoul()
    }
  }
  catch (error) {
    genesisError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    genesisLoading.value = false
  }
}

watch(language, () => {
  i18n.locale.value = language.value
  setLocale(language.value)
})

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

onMounted(async () => {
  analyticsStore.initialize()
  cardStore.initialize()
  onboardingStore.initializeSetupCheck()

  await chatSessionStore.initialize()
  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()

  const serverChannelConfig = await getServerChannelConfig()
  serverChannelSettingsStore.websocketTlsConfig = serverChannelConfig.websocketTlsConfig

  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  await contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()
  await aliceEpoch1Store.initialize()
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
  context.value.on(aliceSoulChanged, (event: any) => {
    aliceEpoch1Store.setSoulSnapshot(event.body)
  })
  context.value.on(aliceKillSwitchStateChanged, (event: any) => {
    if (event.body.state === 'SUSPENDED') {
      characterOrchestratorStore.stopTicker()
    }
    else {
      characterOrchestratorStore.startTicker()
    }
  })
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
  aliceEpoch1Store.dispose()
  contextBridgeStore.dispose()
  clearAliceBridge()
  clearMcpToolBridge()
})
</script>

<template>
  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>
  <ResizeHandler />
  <RouterView />
  <div
    v-if="showGenesisDialog"
    class="fixed inset-0 z-9999 flex items-center justify-center bg-black/55 px-4"
  >
    <div class="max-w-xl w-full rounded-xl bg-white p-4 shadow-lg dark:bg-neutral-900">
      <h2 class="mb-2 text-lg font-semibold">
        A.L.I.C.E Genesis
      </h2>
      <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
        首次启动需要完成初始化，SOUL.md 将在本地写入并成为人格真源。
      </p>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label class="text-sm">
          <div class="mb-1">称呼</div>
          <input
            v-model="genesisForm.hostName"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：爸爸"
          >
        </label>
        <label class="text-sm">
          <div class="mb-1">心智年龄</div>
          <input
            v-model.number="genesisForm.mindAge"
            type="number"
            min="1"
            max="120"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
          >
        </label>
        <label class="text-sm">
          <div class="mb-1">服从度 (0-1)</div>
          <input v-model.number="genesisForm.obedience" type="number" step="0.01" min="0" max="1" class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800">
        </label>
        <label class="text-sm">
          <div class="mb-1">活泼度 (0-1)</div>
          <input v-model.number="genesisForm.liveliness" type="number" step="0.01" min="0" max="1" class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800">
        </label>
        <label class="text-sm md:col-span-2">
          <div class="mb-1">感性度 (0-1)</div>
          <input v-model.number="genesisForm.sensibility" type="number" step="0.01" min="0" max="1" class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800">
        </label>
      </div>

      <p v-if="genesisError" class="mt-3 text-sm text-red-500">
        {{ genesisError }}
      </p>

      <div class="mt-4 flex items-center justify-end gap-2">
        <button
          class="border border-neutral-300 rounded px-3 py-1.5 text-sm dark:border-neutral-700"
          :disabled="genesisLoading"
          @click="submitGenesis(true)"
        >
          冲突时覆盖写入
        </button>
        <button
          class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          :disabled="genesisLoading"
          @click="submitGenesis(false)"
        >
          {{ genesisLoading ? '保存中...' : '完成初始化' }}
        </button>
      </div>
    </div>
  </div>
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
