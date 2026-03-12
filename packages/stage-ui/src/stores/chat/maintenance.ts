import { defineStore } from 'pinia'

import { useChatOrchestratorStore } from '../chat'
import { useChatContextStore } from './context-store'
import { useChatSessionStore } from './session-store'
import { useChatStreamStore } from './stream-store'

export const useChatMaintenanceStore = defineStore('chat-maintenance', () => {
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const chatOrchestrator = useChatOrchestratorStore()

  async function cleanupMessages(sessionId = chatSession.activeSessionId) {
    await chatOrchestrator.abortActiveTurns('session-reset')
    chatSession.cleanupMessages(sessionId)
    chatContext.resetContexts()
    chatStream.resetStream()
  }

  return {
    cleanupMessages,
  }
})
