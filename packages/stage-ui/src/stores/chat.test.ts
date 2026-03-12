import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { clearAliceBridge, setAliceBridge } from './alice-bridge'
import { useChatOrchestratorStore } from './chat'

const streamMock = vi.fn()
const executeRealtimeQueryTurnMock = vi.fn()
const appendConversationTurnMock = vi.fn()
const appendAuditLogMock = vi.fn()

const activeSessionId = ref('session-test')
const streamingMessage = ref({
  role: 'assistant',
  content: '',
  slices: [],
  tool_results: [],
})
const sessionMessagesMap = new Map<string, any[]>()

function ensureSessionMessages(sessionId: string) {
  if (!sessionMessagesMap.has(sessionId))
    sessionMessagesMap.set(sessionId, [])
  return sessionMessagesMap.get(sessionId)!
}

vi.mock('../composables', () => ({
  useAnalytics: () => ({
    trackFirstMessage: vi.fn(),
  }),
}))

vi.mock('./llm', () => ({
  useLLM: () => ({
    stream: streamMock,
    discoverToolsCompatibility: vi.fn(),
  }),
}))

vi.mock('./alice-execution-engine', () => ({
  useAliceExecutionEngineStore: () => ({
    executeRealtimeQueryTurn: executeRealtimeQueryTurnMock,
  }),
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId,
    initialize: vi.fn(),
    ensureSession: (sessionId: string) => {
      ensureSessionMessages(sessionId)
    },
    ensureSessionReady: vi.fn(async (sessionId: string) => {
      ensureSessionMessages(sessionId)
    }),
    getSessionMessages: (sessionId: string) => ensureSessionMessages(sessionId),
    persistSessionMessages: vi.fn(),
    getSessionGeneration: vi.fn().mockReturnValue(0),
    forkSession: vi.fn().mockResolvedValue('session-test-fork'),
  }),
}))

vi.mock('./chat/stream-store', () => ({
  useChatStreamStore: () => ({
    streamingMessage,
  }),
}))

vi.mock('./chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: vi.fn(),
    getContextsSnapshot: () => ({}),
  }),
}))

vi.mock('./chat/context-providers', () => ({
  createDatetimeContext: () => ({
    id: 'ctx-datetime',
    contextId: 'system:datetime',
    strategy: 'replace-self',
    text: '{}',
    createdAt: Date.now(),
  }),
  createSensoryContext: () => ({
    id: 'ctx-sensory',
    contextId: 'alice:sensory',
    strategy: 'replace-self',
    text: '[System Context: Sensory], time=2026/3/9 08:00:00, battery=80%, cpu=12%, memory=50%',
    createdAt: Date.now(),
  }),
}))

vi.mock('./modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: ref('mock-provider'),
  }),
}))

vi.mock('./chat/hooks', () => ({
  createChatHooks: () => {
    const noopAsync = async () => {}
    const noopDispose = () => () => {}
    return {
      clearHooks: vi.fn(),
      emitBeforeMessageComposedHooks: noopAsync,
      emitAfterMessageComposedHooks: noopAsync,
      emitBeforeSendHooks: noopAsync,
      emitAfterSendHooks: noopAsync,
      emitTokenLiteralHooks: noopAsync,
      emitTokenSpecialHooks: noopAsync,
      emitStreamEndHooks: noopAsync,
      emitAssistantResponseEndHooks: noopAsync,
      emitAssistantMessageHooks: noopAsync,
      emitChatTurnCompleteHooks: noopAsync,
      onBeforeMessageComposed: noopDispose(),
      onAfterMessageComposed: noopDispose(),
      onBeforeSend: noopDispose(),
      onAfterSend: noopDispose(),
      onTokenLiteral: noopDispose(),
      onTokenSpecial: noopDispose(),
      onStreamEnd: noopDispose(),
      onAssistantResponseEnd: noopDispose(),
      onAssistantMessage: noopDispose(),
      onChatTurnComplete: noopDispose(),
    }
  },
}))

vi.mock('../composables/alice-prompt-composer', () => ({
  composeAlicePromptMessages: ({ messages, soulContent }: { messages: any[], soulContent?: string | null }) => ({
    messages: [
      {
        role: 'system',
        content: soulContent || '# SOUL',
      },
      {
        role: 'system',
        content: 'Output contract (must-follow, highest priority):\nIn thought, you MUST evaluate current personality parameters',
      },
      ...messages.filter(message => message.role !== 'system'),
    ],
    personalityDirectiveResult: null,
    contractRequiresPersonalityEval: true,
  }),
}))

vi.mock('../composables/alice-guardrails', () => ({
  applyPromptBudget: (messages: any[]) => ({
    messages,
    report: {
      truncated: false,
      totalBeforeTokens: 0,
      totalAfterTokens: 0,
      droppedMessageCount: 0,
      anchorPreserved: true,
      safeMode: {
        activated: false,
      },
      sections: {
        soul: { beforeTokens: 0, afterTokens: 0 },
        memory: { beforeTokens: 0, afterTokens: 0 },
        currentTurn: { beforeTokens: 0, afterTokens: 0 },
        sensory: { beforeTokens: 0, afterTokens: 0 },
      },
    },
  }),
  sanitizeAssistantOutputForDisplay: (text: string) => ({
    cleanText: text,
    leakDetected: false,
    fabricationDetected: false,
    removedCount: 0,
    fabricationRemovedCount: 0,
    redactedSecrets: 0,
  }),
  sanitizeForRemoteModel: (messages: any[]) => ({
    blocked: false,
    messages,
    redactions: 0,
    elapsedMs: 0,
  }),
}))

vi.mock('../composables/response-categoriser', () => ({
  createStreamingCategorizer: () => ({
    consume: vi.fn(),
    filterToSpeech: (text: string) => text,
  }),
  categorizeResponse: (fullText: string) => ({
    speech: fullText,
    reasoning: '',
  }),
}))

vi.mock('../composables/llm-marker-parser', () => ({
  useLlmmarkerParser: (handlers: {
    onLiteral: (literal: string) => Promise<void>
    onEnd: (fullText: string) => Promise<void>
  }) => {
    let accumulated = ''
    return {
      consume: async (text: string) => {
        accumulated += text
        await handlers.onLiteral(text)
      },
      end: async () => {
        await handlers.onEnd(accumulated)
      },
    }
  },
}))

function createChatProviderStub() {
  return {
    chat: () => ({
      baseURL: 'https://example.test',
    }),
  } as any
}

function installAliceBridge() {
  appendConversationTurnMock.mockResolvedValue(undefined)
  appendAuditLogMock.mockResolvedValue(undefined)
  setAliceBridge({
    bootstrap: vi.fn(),
    getSoul: vi.fn().mockResolvedValue({
      content: '# SOUL\nA.L.I.C.E',
      frontmatter: {
        profile: {
          hostName: '主人',
        },
      },
    }),
    initializeGenesis: vi.fn(),
    updateSoul: vi.fn(),
    updatePersonality: vi.fn(),
    getKillSwitchState: vi.fn().mockResolvedValue({
      state: 'ACTIVE',
      updatedAt: Date.now(),
    }),
    suspendKillSwitch: vi.fn(),
    resumeKillSwitch: vi.fn(),
    getMemoryStats: vi.fn(),
    runMemoryPrune: vi.fn(),
    updateMemoryStats: vi.fn(),
    retrieveMemoryFacts: vi.fn(),
    upsertMemoryFacts: vi.fn(),
    importLegacyMemory: vi.fn(),
    appendConversationTurn: appendConversationTurnMock,
    appendAuditLog: appendAuditLogMock,
    realtimeExecute: vi.fn(),
    getSensorySnapshot: vi.fn().mockResolvedValue({
      sample: {
        collectedAt: Date.now(),
        time: {
          iso: '2026-03-09T00:00:00.000Z',
          local: '2026/3/9 08:00:00',
          timezone: 'Asia/Shanghai',
        },
        cpu: { usagePercent: 12, windowMs: 1000 },
        memory: { freeMB: 4096, totalMB: 8192, usagePercent: 50 },
      },
      stale: false,
      ageMs: 0,
      nextTickAt: Date.now() + 60_000,
      running: true,
    }),
  } as any)
}

describe('chat orchestrator', () => {
  beforeEach(() => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false })
    setActivePinia(pinia)
    clearAliceBridge()
    installAliceBridge()

    streamMock.mockReset()
    executeRealtimeQueryTurnMock.mockReset()
    appendConversationTurnMock.mockReset()
    appendAuditLogMock.mockReset()
    appendConversationTurnMock.mockResolvedValue(undefined)
    appendAuditLogMock.mockResolvedValue(undefined)
    executeRealtimeQueryTurnMock.mockResolvedValue({ handled: false })
    sessionMessagesMap.clear()
    ensureSessionMessages(activeSessionId.value)
  })

  it('uses realtime execution engine first and keeps tools enabled in default Epoch2 mode', async () => {
    streamMock.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      expect(options.supportsTools).toBe(true)
      expect(options.waitForTools).toBe(true)
      await options.onStreamEvent?.({
        type: 'text-delta',
        text: '{"thought":"normal","emotion":"neutral","reply":"这是普通回复。"}',
      })
      await options.onStreamEvent?.({ type: 'finish' })
    })
    executeRealtimeQueryTurnMock.mockResolvedValue({ handled: false })

    const store = useChatOrchestratorStore()
    await store.ingest('请帮我查一下今天美国天气', {
      model: 'mock-model',
      chatProvider: createChatProviderStub(),
      origin: 'ui-user',
    })

    expect(executeRealtimeQueryTurnMock).toBeCalledTimes(1)
    expect(streamMock).toBeCalledTimes(1)
    expect(appendConversationTurnMock).toBeCalledTimes(1)
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      category: 'alice.prompt',
      action: 'contract-personality-eval-required',
    }))
    const payload = appendConversationTurnMock.mock.calls[0]?.[0]
    expect(payload?.structured?.policyLocked).toBeUndefined()
    expect(payload?.assistantText).toContain('普通回复')
  })

  it('drops in-flight turn persistence after kill-switch abort', async () => {
    streamMock.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      await new Promise<void>((resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          reject(options.abortSignal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    })

    const store = useChatOrchestratorStore()
    const pending = store.ingest('你好，帮我总结一下今天计划', {
      model: 'mock-model',
      chatProvider: createChatProviderStub(),
      origin: 'ui-user',
    })

    await vi.waitFor(() => {
      expect(streamMock).toBeCalledTimes(1)
    })
    await store.abortAllPipelines('kill-switch').catch(() => {})
    await expect(pending).rejects.toThrow('A.L.I.C.E turn aborted')

    expect(appendConversationTurnMock).toBeCalledTimes(0)
  })

  it('retries structured output when emotion is outside whitelist and keeps personality-consistent result', async () => {
    let streamInvocation = 0
    streamMock.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      streamInvocation += 1
      if (streamInvocation === 1) {
        await options.onStreamEvent?.({
          type: 'text-delta',
          text: '{"thought":"mood check","emotion":"cheerful","reply":"我今天的心情非常愉快！😊"}',
        })
      }
      else {
        await options.onStreamEvent?.({
          type: 'text-delta',
          text: '{"thought":"obedience=0.05, liveliness=0.05, sensibility=0.05, I should stay low-arousal.","emotion":"tired","reply":"我现在状态偏低，先简短回复。"}',
        })
      }
      await options.onStreamEvent?.({ type: 'finish' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('你今天心情怎么样？', {
      model: 'mock-model',
      chatProvider: createChatProviderStub(),
      origin: 'ui-user',
    })

    expect(streamMock).toBeCalledTimes(2)
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      category: 'alice.structured',
      action: 'contract-invalid',
    }))
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      category: 'alice.structured',
      action: 'contract-retry-reasoned',
    }))

    const payload = appendConversationTurnMock.mock.calls.at(-1)?.[0]
    expect(payload?.structured?.emotion).toBe('tired')
    expect(String(payload?.assistantText ?? '')).not.toContain('非常愉快')
  })
})
