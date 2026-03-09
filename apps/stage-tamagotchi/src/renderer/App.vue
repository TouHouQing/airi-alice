<script setup lang="ts">
import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { clearAliceBridge, setAliceBridge } from '@proj-airi/stage-ui/stores/alice-bridge'
import { useAliceEpoch1Store } from '@proj-airi/stage-ui/stores/alice-epoch1'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { clearMcpToolBridge, setMcpToolBridge } from '@proj-airi/stage-ui/stores/mcp-tool-bridge'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useHearingSpeechInputPipeline } from '@proj-airi/stage-ui/stores/modules/hearing'
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
  electronAliceAppendAuditLog,
  electronAliceAppendConversationTurn,
  electronAliceBootstrap,
  electronAliceGetMemoryStats,
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
  electronMcpGetCapabilitiesSnapshot,
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
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const chatSessionStore = useChatSessionStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const hearingSpeechInputPipeline = useHearingSpeechInputPipeline()
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
const getMcpCapabilitiesSnapshot = useElectronEventaInvoke(electronMcpGetCapabilitiesSnapshot)
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
const aliceRetrieveMemoryFacts = useElectronEventaInvoke(electronAliceMemoryRetrieveFacts)
const aliceUpsertMemoryFacts = useElectronEventaInvoke(electronAliceMemoryUpsertFacts)
const aliceImportLegacyMemory = useElectronEventaInvoke(electronAliceMemoryImportLegacy)
const aliceRunMemoryPrune = useElectronEventaInvoke(electronAliceRunMemoryPrune)
const aliceUpdateMemoryStats = useElectronEventaInvoke(electronAliceUpdateMemoryStats)
const aliceAppendConversationTurn = useElectronEventaInvoke(electronAliceAppendConversationTurn)
const aliceAppendAuditLog = useElectronEventaInvoke(electronAliceAppendAuditLog)
const aliceRealtimeExecute = useElectronEventaInvoke(electronAliceRealtimeExecute)

const showGenesisDialog = computed(() => aliceNeedsGenesis.value)
const hasGenesisConflictCandidate = computed(() => Boolean(genesisConflictCandidate.value))
const soulPersonaNotesStart = '<!-- ALICE_PERSONA_NOTES_START -->'
const soulPersonaNotesEnd = '<!-- ALICE_PERSONA_NOTES_END -->'
const genesisForm = ref({
  ownerName: '',
  hostName: '',
  aliceName: 'A.L.I.C.E.',
  gender: 'neutral' as 'female' | 'male' | 'non-binary' | 'neutral' | 'custom',
  genderCustom: '',
  relationship: '数字共生体',
  mindAge: 15,
  obedience: 0.5,
  liveliness: 0.5,
  sensibility: 0.5,
  personaNotes: '',
})
const genesisError = ref('')
const genesisLoading = ref(false)
const unregisterPipelineAborters: Array<() => void> = []

function getSoulBodyFromContent(content: string) {
  if (!content.startsWith('---\n'))
    return content.trim()
  const secondMarkerIndex = content.indexOf('\n---\n', 4)
  if (secondMarkerIndex < 0)
    return content.trim()
  return content.slice(secondMarkerIndex + 5).trim()
}

function getPersonaNotesFromContent(content: string) {
  const body = getSoulBodyFromContent(content)
  const startIndex = body.indexOf(soulPersonaNotesStart)
  const endIndex = body.indexOf(soulPersonaNotesEnd)
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex)
    return ''
  return body.slice(startIndex + soulPersonaNotesStart.length, endIndex).trim()
}

function formatGender(value: string, custom: string) {
  if (value === 'female')
    return '女性'
  if (value === 'male')
    return '男性'
  if (value === 'non-binary')
    return '非二元'
  if (value === 'custom')
    return custom || '自定义'
  return '中性'
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

const genesisConflictRows = computed(() => {
  const candidate = genesisConflictCandidate.value
  if (!candidate)
    return []

  const rows = [
    {
      key: 'ownerName',
      label: '宿主姓名',
      current: genesisForm.value.ownerName || '(空)',
      candidate: candidate.frontmatter.profile.ownerName || '(空)',
    },
    {
      key: 'hostName',
      label: '对宿主称呼',
      current: genesisForm.value.hostName || '(空)',
      candidate: candidate.frontmatter.profile.hostName || '(空)',
    },
    {
      key: 'aliceName',
      label: '宿主对你称呼',
      current: genesisForm.value.aliceName || '(空)',
      candidate: candidate.frontmatter.profile.aliceName || '(空)',
    },
    {
      key: 'gender',
      label: '性别',
      current: formatGender(genesisForm.value.gender, genesisForm.value.genderCustom),
      candidate: formatGender(candidate.frontmatter.profile.gender, candidate.frontmatter.profile.genderCustom),
    },
    {
      key: 'relationship',
      label: '关系定位',
      current: genesisForm.value.relationship || '(空)',
      candidate: candidate.frontmatter.profile.relationship || '(空)',
    },
    {
      key: 'mindAge',
      label: '心智年龄',
      current: String(genesisForm.value.mindAge),
      candidate: String(candidate.frontmatter.profile.mindAge),
    },
    {
      key: 'obedience',
      label: '服从度',
      current: formatPercent(genesisForm.value.obedience),
      candidate: formatPercent(candidate.frontmatter.personality.obedience),
    },
    {
      key: 'liveliness',
      label: '活泼度',
      current: formatPercent(genesisForm.value.liveliness),
      candidate: formatPercent(candidate.frontmatter.personality.liveliness),
    },
    {
      key: 'sensibility',
      label: '感性度',
      current: formatPercent(genesisForm.value.sensibility),
      candidate: formatPercent(candidate.frontmatter.personality.sensibility),
    },
  ]

  return rows.map(item => ({
    ...item,
    changed: item.current !== item.candidate,
  }))
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
  callTool: payload => callMcpTool(payload),
  getCapabilitiesSnapshot: () => getMcpCapabilitiesSnapshot(),
})

setAliceBridge({
  bootstrap: () => aliceBootstrap(),
  getSoul: () => aliceGetSoul(),
  initializeGenesis: payload => aliceInitializeGenesis(payload),
  updateSoul: payload => aliceUpdateSoul(payload),
  updatePersonality: payload => aliceUpdatePersonality(payload),
  getKillSwitchState: () => aliceGetKillSwitchState(),
  suspendKillSwitch: payload => aliceSuspendKillSwitch(payload ?? {}),
  resumeKillSwitch: payload => aliceResumeKillSwitch(payload ?? {}),
  getMemoryStats: () => aliceGetMemoryStats(),
  runMemoryPrune: () => aliceRunMemoryPrune(),
  updateMemoryStats: payload => aliceUpdateMemoryStats(payload),
  retrieveMemoryFacts: payload => aliceRetrieveMemoryFacts(payload),
  upsertMemoryFacts: payload => aliceUpsertMemoryFacts(payload),
  importLegacyMemory: payload => aliceImportLegacyMemory(payload),
  appendConversationTurn: payload => aliceAppendConversationTurn(payload),
  appendAuditLog: payload => aliceAppendAuditLog(payload),
  realtimeExecute: payload => aliceRealtimeExecute(payload),
})

function prefillGenesisFormFromSoul() {
  const snapshot = genesisConflictCandidate.value ?? aliceSoulSnapshot.value
  if (!snapshot)
    return

  genesisForm.value = {
    ownerName: snapshot.frontmatter.profile.ownerName || genesisForm.value.ownerName,
    hostName: snapshot.frontmatter.profile.hostName || genesisForm.value.hostName,
    aliceName: snapshot.frontmatter.profile.aliceName || genesisForm.value.aliceName,
    gender: snapshot.frontmatter.profile.gender || genesisForm.value.gender,
    genderCustom: snapshot.frontmatter.profile.genderCustom || genesisForm.value.genderCustom,
    relationship: snapshot.frontmatter.profile.relationship || genesisForm.value.relationship,
    mindAge: snapshot.frontmatter.profile.mindAge || genesisForm.value.mindAge,
    obedience: snapshot.frontmatter.personality.obedience,
    liveliness: snapshot.frontmatter.personality.liveliness,
    sensibility: snapshot.frontmatter.personality.sensibility,
    personaNotes: getPersonaNotesFromContent(snapshot.content),
  }
}

function applyGenesisConflictCandidate() {
  const candidate = genesisConflictCandidate.value
  if (!candidate)
    return

  genesisForm.value = {
    ownerName: candidate.frontmatter.profile.ownerName,
    hostName: candidate.frontmatter.profile.hostName,
    aliceName: candidate.frontmatter.profile.aliceName,
    gender: candidate.frontmatter.profile.gender,
    genderCustom: candidate.frontmatter.profile.genderCustom,
    relationship: candidate.frontmatter.profile.relationship,
    mindAge: candidate.frontmatter.profile.mindAge,
    obedience: candidate.frontmatter.personality.obedience,
    liveliness: candidate.frontmatter.personality.liveliness,
    sensibility: candidate.frontmatter.personality.sensibility,
    personaNotes: getPersonaNotesFromContent(candidate.content),
  }
  genesisError.value = ''
}

watch([aliceSoulSnapshot, genesisConflictCandidate], () => {
  if (showGenesisDialog.value)
    prefillGenesisFormFromSoul()
}, { immediate: true })

watch(showGenesisDialog, (visible) => {
  if (!visible)
    return

  prefillGenesisFormFromSoul()
}, { immediate: true })

async function submitGenesis(allowOverwrite = false) {
  genesisError.value = ''
  genesisLoading.value = true
  try {
    let result
    if (aliceNeedsGenesis.value) {
      result = await aliceEpoch1Store.initializeGenesis({
        ownerName: genesisForm.value.ownerName,
        hostName: genesisForm.value.hostName,
        aliceName: genesisForm.value.aliceName,
        gender: genesisForm.value.gender,
        genderCustom: genesisForm.value.genderCustom,
        relationship: genesisForm.value.relationship,
        personaNotes: genesisForm.value.personaNotes,
        mindAge: genesisForm.value.mindAge,
        allowOverwrite,
        personality: {
          obedience: genesisForm.value.obedience,
          liveliness: genesisForm.value.liveliness,
          sensibility: genesisForm.value.sensibility,
        },
      })
      if (result?.conflict) {
        genesisError.value = '检测到 SOUL.md 在初始化期间被外部修改，请确认后覆盖或调整表单。'
        prefillGenesisFormFromSoul()
        return
      }
    }

    await aliceEpoch1Store.refreshSoul()
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

  unregisterPipelineAborters.push(chatOrchestratorStore.registerPipelineAborter(async () => {
    await hearingSpeechInputPipeline.stopStreamingTranscription(true).catch(() => {})
  }))
  unregisterPipelineAborters.push(chatOrchestratorStore.registerPipelineAborter(async (reason) => {
    await characterOrchestratorStore.abortAllPipelines(reason)
  }))

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
    aliceEpoch1Store.setKillSwitchSnapshot(event.body)
    if (event.body.state === 'SUSPENDED') {
      void chatOrchestratorStore.abortAllPipelines('kill-switch')
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
  while (unregisterPipelineAborters.length > 0) {
    unregisterPipelineAborters.pop()?.()
  }
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
    class="fixed inset-0 z-9999 flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-4"
  >
    <div class="max-h-[calc(100vh-2rem)] max-w-xl w-full overflow-y-auto rounded-xl bg-white p-4 shadow-lg dark:bg-neutral-900">
      <h2 class="mb-2 text-lg font-semibold">
        A.L.I.C.E Genesis
      </h2>
      <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
        首次启动需要完成初始化，SOUL.md 将在本地写入并成为人格真源。
      </p>

      <div
        v-if="hasGenesisConflictCandidate"
        class="mb-4 border border-amber-300 rounded-md bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/20"
      >
        <div class="text-amber-700 font-semibold dark:text-amber-300">
          发现 Genesis 冲突候选
        </div>
        <div class="mt-1 break-all text-neutral-700 dark:text-neutral-300">
          文件：{{ genesisConflictCandidate?.soulPath }}
        </div>
        <div class="mt-0.5 text-neutral-600 dark:text-neutral-400">
          候选 revision={{ genesisConflictCandidate?.revision }} / hash={{ genesisConflictCandidate?.hash?.slice(0, 12) }}...
        </div>
        <div class="grid grid-cols-3 mt-2 gap-1 text-[11px]">
          <div class="text-neutral-500 font-medium dark:text-neutral-400">
            字段
          </div>
          <div class="text-neutral-500 font-medium dark:text-neutral-400">
            当前表单
          </div>
          <div class="text-neutral-500 font-medium dark:text-neutral-400">
            候选 SOUL
          </div>
          <template v-for="row in genesisConflictRows" :key="row.key">
            <div :class="row.changed ? 'font-semibold text-amber-700 dark:text-amber-300' : ''">
              {{ row.label }}
            </div>
            <div :class="row.changed ? 'font-semibold text-amber-700 dark:text-amber-300' : ''">
              {{ row.current }}
            </div>
            <div :class="row.changed ? 'font-semibold text-amber-700 dark:text-amber-300' : ''">
              {{ row.candidate }}
            </div>
          </template>
        </div>
        <button
          class="mt-2 border border-amber-300 rounded px-2 py-1 text-xs dark:border-amber-700"
          :disabled="genesisLoading"
          @click="applyGenesisConflictCandidate()"
        >
          用候选值填充表单
        </button>
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label class="text-sm">
          <div class="mb-1">宿主姓名</div>
          <input
            v-model="genesisForm.ownerName"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：TouhouQing"
          >
        </label>
        <label class="text-sm">
          <div class="mb-1">你对宿主的称呼</div>
          <input
            v-model="genesisForm.hostName"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：爸爸"
          >
        </label>
        <label class="text-sm">
          <div class="mb-1">宿主对你的称呼</div>
          <input
            v-model="genesisForm.aliceName"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：爱丽丝"
          >
        </label>
        <label class="text-sm">
          <div class="mb-1">性别</div>
          <select
            v-model="genesisForm.gender"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="female">
              女性
            </option>
            <option value="male">
              男性
            </option>
            <option value="non-binary">
              非二元
            </option>
            <option value="neutral">
              中性
            </option>
            <option value="custom">
              自定义
            </option>
          </select>
        </label>
        <label v-if="genesisForm.gender === 'custom'" class="text-sm md:col-span-2">
          <div class="mb-1">自定义性别描述</div>
          <input
            v-model="genesisForm.genderCustom"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：仿生少女"
          >
        </label>
        <label class="text-sm md:col-span-2">
          <div class="mb-1">关系定位</div>
          <input
            v-model="genesisForm.relationship"
            class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="例如：数字共生体 / 助手 / 室友"
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
        <label class="text-sm">
          <div class="mb-1">感性度 (0-1)</div>
          <input v-model.number="genesisForm.sensibility" type="number" step="0.01" min="0" max="1" class="w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800">
        </label>
      </div>

      <div class="mt-4 border border-neutral-200 rounded-md p-3 dark:border-neutral-700">
        <div class="mb-2 text-sm font-semibold">
          人格补充描述（自由文）
        </div>
        <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
          Genesis 会将结构化人格事实写入 Frontmatter，并把这里的补充描述写入 SOUL 正文 Persona Notes。
        </p>
        <textarea
          v-model="genesisForm.personaNotes"
          class="h-36 w-full border border-neutral-300 rounded px-2 py-1.5 outline-none dark:border-neutral-700 dark:bg-neutral-800"
          placeholder="例如：希望她更温柔、更主动提醒休息，遇到冲突先安抚再给方案。"
        />
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
