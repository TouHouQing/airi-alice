import type { AboutBuildInfo } from '../../components/scenarios/about/types'

import posthog from 'posthog-js'

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useBuildInfo } from '../../composables'

export const useSharedAnalyticsStore = defineStore('analytics-shared', () => {
  const buildInfo = ref<AboutBuildInfo>(useBuildInfo())
  const isInitialized = ref(false)

  const appStartTime = ref<number | null>(null)
  const firstMessageTracked = ref(false)

  function canUsePosthog() {
    return Boolean((posthog as unknown as { __loaded?: unknown }).__loaded)
  }

  function initialize() {
    if (isInitialized.value)
      return

    appStartTime.value = Date.now()

    // Register metadata with PostHog after buildInfo is set
    if (canUsePosthog()) {
      posthog.register({
        app_version: (buildInfo.value.version && buildInfo.value.version !== '0.0.0') ? buildInfo.value.version : 'dev',
        app_commit: buildInfo.value.commit,
        app_branch: buildInfo.value.branch,
        app_build_time: buildInfo.value.builtOn,
      })
    }

    isInitialized.value = true
  }

  function markFirstMessageTracked() {
    firstMessageTracked.value = true
  }

  return {
    buildInfo,
    appStartTime,
    firstMessageTracked,
    initialize,
    markFirstMessageTracked,
  }
})
