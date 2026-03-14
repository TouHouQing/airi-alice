import posthog from 'posthog-js'

import { useSharedAnalyticsStore } from '../stores/analytics'

export function useAnalytics() {
  const analyticsStore = useSharedAnalyticsStore()
  const canUsePosthog = () => Boolean((posthog as unknown as { __loaded?: unknown }).__loaded)

  function trackProviderClick(providerId: string, module: string) {
    if (!canUsePosthog())
      return

    posthog.capture('provider_card_clicked', {
      provider_id: providerId,
      module,
    })
  }

  function trackFirstMessage() {
    // Only track the first message once
    if (analyticsStore.firstMessageTracked)
      return

    analyticsStore.markFirstMessageTracked()

    // Calculate time from app start to message sent
    const timeToFirstMessageMs = analyticsStore.appStartTime
      ? Date.now() - analyticsStore.appStartTime
      : null

    if (!canUsePosthog())
      return

    posthog.capture('first_message_sent', {
      time_to_first_message_ms: timeToFirstMessageMs,
    })
  }

  return {
    trackProviderClick,
    trackFirstMessage,
  }
}
