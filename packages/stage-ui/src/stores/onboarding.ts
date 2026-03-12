import { useLocalStorage } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'

import { useConsciousnessStore } from './modules/consciousness'
import { useProvidersStore } from './providers'

const credentialBasedEssentialProviderIds = ['openai', 'anthropic', 'google-generative-ai', 'openrouter-ai', 'deepseek'] as const

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export const useOnboardingStore = defineStore('onboarding', () => {
  const providersStore = useProvidersStore()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)

  function isChatProvider(providerId: string) {
    return providersStore.providerMetadata[providerId]?.category === 'chat'
  }

  // Track if first-time setup has been completed or skipped
  const hasCompletedSetup = useLocalStorage('onboarding/completed', false)
  const hasSkippedSetup = useLocalStorage('onboarding/skipped', false)

  // Track if we should show the setup dialog
  const shouldShowSetup = ref(false)

  // Check if any chat provider is configured
  const hasChatProviderConfigured = computed(() => {
    return Object.entries(providersStore.configuredProviders)
      .some(([providerId, configured]) => configured && isChatProvider(providerId))
  })

  // Fallback for app startup timing:
  // If configured state has not been revalidated yet, infer "configured"
  // from persisted credentials.
  const hasCredentialBackedChatProviderConfigured = computed(() => {
    return credentialBasedEssentialProviderIds.some((providerId) => {
      const providerConfig = providersStore.providers[providerId] as Record<string, unknown> | undefined
      if (!providerConfig) {
        return false
      }

      return hasNonEmptyText(providerConfig.apiKey)
    })
  })

  const hasPersistedActiveProviderSelection = computed(() => {
    const providerId = activeProvider.value
    if (!providerId || !isChatProvider(providerId) || !hasNonEmptyText(activeModel.value)) {
      return false
    }

    return !!providersStore.providers[providerId] || !!providersStore.addedProviders[providerId]
  })

  // NOTICE: runtime selection can be valid before provider metadata/category fully hydrates.
  // Treat any non-empty provider+model pair as configured to avoid false-positive onboarding reopen.
  const hasRuntimeProviderSelection = computed(() => {
    return hasNonEmptyText(activeProvider.value) && hasNonEmptyText(activeModel.value)
  })

  const hasPersistedChatProviderConfig = computed(() => {
    return (providersStore.persistedChatProvidersMetadata?.length ?? 0) > 0
  })

  // Check if first-time setup should be shown
  const needsOnboarding = computed(() => {
    if (hasSkippedSetup.value) {
      console.warn('Onboarding already skipped')
      return false
    }

    if (hasCompletedSetup.value) {
      console.warn('Onboarding already completed')
      return false
    }

    const hasConfiguredChatProvider = hasCredentialBackedChatProviderConfigured.value
      || hasChatProviderConfigured.value
      || hasPersistedChatProviderConfig.value
      || hasPersistedActiveProviderSelection.value
      || hasRuntimeProviderSelection.value

    // Don't show if user already has persisted chat credentials/runtime config.
    if (hasConfiguredChatProvider) {
      console.warn('Chat provider already configured, no onboarding needed')
      return false
    }

    return true
  })

  // Keep in-memory display flag aligned with persisted onboarding status
  // when setup is completed/skipped from another window (desktop multi-window case).
  watch(needsOnboarding, (needSetup) => {
    if (!needSetup) {
      shouldShowSetup.value = false
    }
  })

  // Initialize setup check
  async function initializeSetupCheck() {
    const hasConfiguredChatProvider = hasCredentialBackedChatProviderConfigured.value
      || hasChatProviderConfigured.value
      || hasPersistedChatProviderConfig.value
      || hasPersistedActiveProviderSelection.value
      || hasRuntimeProviderSelection.value

    if (!needsOnboarding.value) {
      shouldShowSetup.value = false
      if (hasConfiguredChatProvider && !hasSkippedSetup.value && !hasCompletedSetup.value)
        hasCompletedSetup.value = true
      return
    }

    // Use nextTick to ensure the app is fully rendered before showing dialog
    await nextTick()
    shouldShowSetup.value = true
  }

  // Mark setup as completed
  function markSetupCompleted() {
    hasCompletedSetup.value = true
    hasSkippedSetup.value = false
    shouldShowSetup.value = false
  }

  // Mark setup as skipped
  function markSetupSkipped() {
    hasSkippedSetup.value = true
    shouldShowSetup.value = false
  }

  // Reset setup state (for testing or re-showing setup)
  function resetSetupState() {
    hasCompletedSetup.value = false
    hasSkippedSetup.value = false
    shouldShowSetup.value = false
  }

  // Force show setup dialog
  function forceShowSetup() {
    shouldShowSetup.value = true
  }

  return {
    hasCompletedSetup,
    hasSkippedSetup,
    shouldShowSetup,
    hasChatProviderConfigured,
    hasCredentialBackedChatProviderConfigured,
    hasPersistedActiveProviderSelection,
    hasRuntimeProviderSelection,
    hasPersistedChatProviderConfig,
    needsOnboarding,

    initializeSetupCheck,
    markSetupCompleted,
    markSetupSkipped,
    resetSetupState,
    forceShowSetup,
  }
})
