import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { StructuredOutputResult } from '../composables/alice-structured-output'
import type { AliceAbortReason } from '../composables/alice-turn-abort'
import type { ChatAssistantMessage, ChatSlices, ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from './llm'

import { createQueue } from '@proj-airi/stream-kit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw } from 'vue'

import { useAnalytics } from '../composables'
import { applyPromptBudget, sanitizeAssistantOutputForDisplay, sanitizeForRemoteModel } from '../composables/alice-guardrails'
import { composeAlicePromptMessages } from '../composables/alice-prompt-composer'
import { detectRealtimeQueryIntent } from '../composables/alice-realtime-query'
import { normalizeStructuredOutput } from '../composables/alice-structured-output'
import { abortAliceTurns, completeAliceTurnAbort, isAliceAbortError, registerAliceTurnAbort } from '../composables/alice-turn-abort'
import { useLlmmarkerParser } from '../composables/llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from '../composables/response-categoriser'
import { getAliceBridge, hasAliceBridge } from './alice-bridge'
import { useAliceExecutionEngineStore } from './alice-execution-engine'
import { createDatetimeContext, createSensoryContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { createChatHooks } from './chat/hooks'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useLLM } from './llm'
import { useConsciousnessStore } from './modules/consciousness'

interface SendOptions {
  model: string
  chatProvider: ChatProvider
  providerConfig?: Record<string, unknown>
  attachments?: { type: 'image', data: string, mimeType: string }[]
  tools?: StreamOptions['tools']
  input?: WebSocketEventInputs
  origin?: 'ui-user' | 'tool-output' | 'context-recall' | 'system'
}

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

interface QueuedSend {
  sendingMessage: string
  options: SendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

type ExternalPipelineAborter = (reason: AliceAbortReason) => Promise<void> | void

const assistantLeakFallbackReply = '我刚才的检索结果混入了内部调用片段，已自动过滤。请你再说一次你的问题，我会直接给你整理后的结果。'
const assistantRealtimeUnavailableReply = '当前无法获取可靠的实时外部数据。请稍后重试，或在设置里检查 MCP 实时工具是否可用。'
const assistantEpoch1StrictFallbackReply = '抱歉，当前是 Epoch 1 受限模式，我无法访问外部实时数据源。你可以继续和我进行本地对话、设定与记忆整理。'
const assistantStructuredContractFallbackReply = '我刚才没有稳定产出结构化结果，这一轮先按安全模式回复。'
const aliceEpoch1StrictModeEnabled = false
const runtimeContractAnchorHeader = 'Output contract (must-follow, highest priority):'
const structuredRetrySystemPrompt = [
  'Return ONLY one strict JSON object with keys: thought, emotion, reply.',
  'No markdown fences, no prose, no tool calls, no extra keys.',
  'The "emotion" value must be a short lowercase label, and "reply" must be natural language.',
].join(' ')
const strictRealtimeRefusalSystemPrompt = [
  '[System Lock]',
  'User request requires realtime external access, but current runtime is locked in Epoch 1 strict mode.',
  'You must not call tools and must not claim you are calling APIs now.',
  'Explain this limitation naturally in your current personality, one-shot, without promising delayed follow-up.',
  'Keep response in strict JSON contract: thought, emotion, reply.',
].join(' ')

function createEmptyStreamingMessage(): StreamingAssistantMessage {
  return {
    role: 'assistant',
    content: '',
    slices: [],
    tool_results: [],
  }
}

interface TurnToolEvidence {
  toolCallCount: number
  toolResultCount: number
  verifiedToolResult: boolean
}

type StructuredWithContract = StructuredOutputResult & {
  contractFailed?: boolean
  policyLocked?: StructuredPolicyLock
}
type StructuredPolicyLock = 'epoch1-strict-realtime'

function insertSystemMessageBeforeLatestUser(messages: Message[], systemText: string): Message[] {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }

  const systemMessage: Message = {
    role: 'system',
    content: systemText,
  }
  if (lastUserIndex < 0)
    return [...messages, systemMessage]

  return [
    ...messages.slice(0, lastUserIndex),
    systemMessage,
    ...messages.slice(lastUserIndex),
  ]
}

function parseKillSwitchDirective(message: string): 'suspend' | 'resume' | null {
  const normalized = message.trim()
  const suspendPattern = /^(?:A\.?L\.?I\.?C\.?E\.?[,，]?\s*)?(?:强制休眠|休眠|suspend|sleep)\s*$/i
  const resumePattern = /^(?:A\.?L\.?I\.?C\.?E\.?[,，]?\s*)?(?:恢复|唤醒|resume|wake)\s*$/i
  if (suspendPattern.test(normalized))
    return 'suspend'
  if (resumePattern.test(normalized))
    return 'resume'
  return null
}

function resolveAbortReason(error: unknown, stale: boolean): AliceAbortReason {
  if (stale)
    return 'session-reset'

  if (typeof error === 'object' && error && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '')
    const match = /Turn aborted:\s*([a-z-]+)/i.exec(message)
    const reason = match?.[1]?.toLowerCase()
    if (reason === 'kill-switch' || reason === 'session-reset' || reason === 'manual' || reason === 'shutdown')
      return reason
  }

  return 'unknown'
}

function replaceAssistantTextSlices(slices: ChatSlices[], text: string): ChatSlices[] {
  const normalizedText = text.trim()
  const nextSlices: ChatSlices[] = []
  let inserted = false

  for (const slice of slices) {
    if (slice.type === 'text') {
      if (!inserted && normalizedText) {
        nextSlices.push({
          type: 'text',
          text: normalizedText,
        })
        inserted = true
      }
      continue
    }

    nextSlices.push(slice)
  }

  if (!inserted && normalizedText) {
    nextSlices.unshift({
      type: 'text',
      text: normalizedText,
    })
  }

  return nextSlices
}

function stringifyAssistantContent(content: unknown) {
  if (typeof content === 'string')
    return content

  if (!Array.isArray(content))
    return ''

  return content
    .map((part) => {
      if (typeof part === 'string')
        return part
      if (part && typeof part === 'object' && 'text' in part)
        return String((part as { text?: unknown }).text ?? '')
      return ''
    })
    .join('')
}

function hasVerifiedToolResult(result?: unknown) {
  if (typeof result === 'string') {
    return result.trim().length > 0
  }

  if (Array.isArray(result)) {
    return result.some((part) => {
      if (typeof part === 'string')
        return part.trim().length > 0
      if (part && typeof part === 'object' && 'text' in part)
        return String((part as { text?: unknown }).text ?? '').trim().length > 0
      return Boolean(part && typeof part === 'object' && Object.keys(part).length > 0)
    })
  }

  if (!result || typeof result !== 'object')
    return false

  const payload = result as Record<string, unknown>
  if (payload.isError === true || payload.ok === false)
    return false

  const content = payload.content
  const structuredContent = payload.structuredContent
  const toolResult = payload.toolResult

  const hasContent = (value: unknown): boolean => {
    if (typeof value === 'string')
      return value.trim().length > 0
    if (Array.isArray(value)) {
      return value.some((entry) => {
        if (typeof entry === 'string')
          return entry.trim().length > 0
        if (entry && typeof entry === 'object' && 'text' in entry)
          return String((entry as { text?: unknown }).text ?? '').trim().length > 0
        return Boolean(entry && typeof entry === 'object' && Object.keys(entry).length > 0)
      })
    }
    if (value && typeof value === 'object')
      return Object.keys(value as Record<string, unknown>).length > 0
    return false
  }

  return hasContent(content) || hasContent(structuredContent) || hasContent(toolResult)
}

function hasStructuredJsonContract(structured: StructuredOutputResult | undefined) {
  if (!structured?.parsePath)
    return false
  return structured.parsePath === 'json' || structured.parsePath === 'repair-json'
}

function createStructuredFallback(replyText: string): StructuredWithContract {
  return {
    thought: '',
    emotion: 'neutral',
    reply: replyText.trim() || assistantStructuredContractFallbackReply,
    userSentimentScore: 0,
    sentimentConfidence: 0.2,
    format: 'fallback-v1',
    parsePath: 'fallback',
    repairTimedOut: false,
    contractFailed: true,
  }
}

async function safelyGetAliceSoulSnapshot() {
  if (!hasAliceBridge())
    return null

  try {
    return await getAliceBridge().getSoul()
  }
  catch {
    return null
  }
}

async function appendAliceAuditLog(payload: {
  level: 'info' | 'notice' | 'warning' | 'critical'
  category: string
  action: string
  message: string
  details?: Record<string, unknown>
}) {
  if (!hasAliceBridge())
    return

  await getAliceBridge().appendAuditLog({
    level: payload.level,
    category: payload.category,
    action: payload.action,
    message: payload.message,
    payload: payload.details,
  }).catch(() => {})
}

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const executionEngine = useAliceExecutionEngineStore()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider } = storeToRefs(consciousnessStore)
  const { trackFirstMessage } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSends = ref<QueuedSend[]>([])
  const externalPipelineAborters = new Set<ExternalPipelineAborter>()
  const hooks = createChatHooks()

  const sendQueue = createQueue<QueuedSend>({
    handlers: [
      async ({ data }) => {
        const { sendingMessage, options, generation, deferred, sessionId, cancelled } = data

        if (cancelled)
          return

        if (chatSession.getSessionGeneration(sessionId) !== generation) {
          deferred.reject(new Error('Chat session was reset before send could start'))
          return
        }

        try {
          await performSend(sendingMessage, options, generation, sessionId)
          deferred.resolve()
        }
        catch (error) {
          deferred.reject(error)
        }
      },
    ],
  })

  sendQueue.on('enqueue', (queuedSend) => {
    pendingQueuedSends.value = [...pendingQueuedSends.value, queuedSend]
  })

  sendQueue.on('dequeue', (queuedSend) => {
    pendingQueuedSends.value = pendingQueuedSends.value.filter(item => item !== queuedSend)
  })

  async function performSend(
    sendingMessage: string,
    options: SendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    chatSession.ensureSession(sessionId)

    // Inject current datetime context before composing the message
    chatContext.ingestContextMessage(createDatetimeContext())
    if (hasAliceBridge()) {
      try {
        const sensorySnapshot = await getAliceBridge().getSensorySnapshot()
        chatContext.ingestContextMessage(createSensoryContext(sensorySnapshot))

        if (sensorySnapshot.sample.degraded?.length) {
          await appendAliceAuditLog({
            level: 'warning',
            category: 'alice.sensory',
            action: 'degraded',
            message: 'Sensory probe sample contains degraded fields.',
            details: {
              reasons: sensorySnapshot.sample.degraded,
            },
          })
        }

        if (sensorySnapshot.stale) {
          await appendAliceAuditLog({
            level: 'warning',
            category: 'alice.sensory',
            action: 'stale',
            message: 'Sensory probe snapshot is stale before prompt injection.',
            details: {
              ageMs: sensorySnapshot.ageMs,
            },
          })
        }

        await appendAliceAuditLog({
          level: 'notice',
          category: 'alice.sensory',
          action: 'injected',
          message: 'Injected sensory context into runtime prompt section.',
          details: {
            stale: sensorySnapshot.stale,
            ageMs: sensorySnapshot.ageMs,
            running: sensorySnapshot.running,
          },
        })
      }
      catch (error) {
        await appendAliceAuditLog({
          level: 'warning',
          category: 'alice.sensory',
          action: 'inject-failed',
          message: 'Failed to inject sensory context before compose.',
          details: {
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    const sendingCreatedAt = Date.now()
    const streamingMessageContext: ChatStreamEventContext = {
      sessionId,
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: nanoid() },
      contexts: chatContext.getContextsSnapshot(),
      composedMessage: [],
      input: options.input,
    }

    const isStaleGeneration = () => chatSession.getSessionGeneration(sessionId) !== generation
    if (isStaleGeneration())
      return

    const activeTurn = registerAliceTurnAbort({
      scope: 'chat',
      turnId: `chat:${sessionId}:${streamingMessageContext.message.id}`,
    })
    const abortSignal = activeTurn.signal
    const turnId = activeTurn.turnId
    const shouldAbort = () => isStaleGeneration() || abortSignal.aborted

    sending.value = true

    const isForegroundSession = () => sessionId === activeSessionId.value

    const buildingMessage: StreamingAssistantMessage = { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now(), id: nanoid() }

    const updateUI = () => {
      if (isForegroundSession()) {
        streamingMessage.value = JSON.parse(JSON.stringify(buildingMessage))
      }
    }

    updateUI()
    trackFirstMessage()

    const sessionMessagesForSend = chatSession.getSessionMessages(sessionId)
    let userTurnMessageId: string | null = null

    try {
      if (options.origin === 'ui-user' && hasAliceBridge()) {
        const directive = parseKillSwitchDirective(sendingMessage)
        if (directive) {
          const bridge = getAliceBridge()
          const nextState = directive === 'suspend'
            ? await bridge.suspendKillSwitch({ reason: 'user-command' })
            : await bridge.resumeKillSwitch({ reason: 'user-command' })

          const sessionMessagesForCommand = chatSession.getSessionMessages(sessionId)
          sessionMessagesForCommand.push({ role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: nanoid() })

          const reply = directive === 'suspend'
            ? '已进入强制休眠模式，执行链路已暂停。'
            : '已恢复运行，执行链路重新启用。'

          sessionMessagesForCommand.push({
            role: 'assistant',
            content: reply,
            slices: [{ type: 'text', text: reply }],
            tool_results: [],
            categorization: {
              speech: reply,
              reasoning: '',
            },
            structured: {
              thought: '',
              emotion: nextState.state === 'SUSPENDED' ? 'tired' : 'neutral',
              reply,
              userSentimentScore: 0,
              sentimentConfidenceRaw: 0.8,
              sentimentConfidence: 0.6,
              format: 'fallback-v1',
            },
            createdAt: Date.now(),
            id: nanoid(),
          })

          chatSession.persistSessionMessages(sessionId)
          if (isForegroundSession()) {
            streamingMessage.value = createEmptyStreamingMessage()
          }
          return
        }
      }

      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)

      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      if (shouldAbort())
        return

      userTurnMessageId = nanoid()
      sessionMessagesForSend.push({ role: 'user', content: finalContent, createdAt: sendingCreatedAt, id: userTurnMessageId })
      chatSession.persistSessionMessages(sessionId)

      const origin = options.origin ?? 'ui-user'
      const strictEpoch1Mode = aliceEpoch1StrictModeEnabled && hasAliceBridge()
      const realtimeIntent = hasAliceBridge() && origin === 'ui-user'
        ? detectRealtimeQueryIntent(sendingMessage)
        : detectRealtimeQueryIntent('')
      let policyLockedReason: StructuredPolicyLock | undefined
      const turnToolEvidence: TurnToolEvidence = {
        toolCallCount: 0,
        toolResultCount: 0,
        verifiedToolResult: false,
      }
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      const categorizer = createStreamingCategorizer(activeProvider.value)
      let streamPosition = 0
      let finalAssistantDisplayText = ''

      const getPreviousAssistantEmotion = () => {
        const previousAssistant = [...sessionMessagesForSend]
          .reverse()
          .find(message => message.role === 'assistant' && 'structured' in message && message.structured)
        return previousAssistant && 'structured' in previousAssistant
          ? previousAssistant.structured?.emotion
          : undefined
      }

      const runStructuredContractRetry = async (payload: {
        reasoning: string
        reply: string
        fullText: string
      }) => {
        if (shouldAbort())
          return null

        const retryMessages: Message[] = [
          {
            role: 'system',
            content: structuredRetrySystemPrompt,
          },
          {
            role: 'user',
            content: [
              'Rewrite the draft assistant output into strict JSON contract.',
              `User input:\n${sendingMessage}`,
              `Assistant draft:\n${payload.reply || payload.fullText}`,
              payload.reasoning.trim()
                ? `Draft thought:\n${payload.reasoning.trim()}`
                : '',
            ].filter(Boolean).join('\n\n'),
          },
        ]

        const sanitizedRetry = sanitizeForRemoteModel(retryMessages, { timeBudgetMs: 50, chunkSize: 2048 })
        if (sanitizedRetry.blocked) {
          await appendAliceAuditLog({
            level: 'critical',
            category: 'structured-output',
            action: 'contract-retry-blocked',
            message: 'Structured contract retry blocked by sanitize gateway.',
            details: {
              reason: sanitizedRetry.reason,
              elapsedMs: sanitizedRetry.elapsedMs,
            },
          })
          return null
        }

        let retryFullText = ''
        try {
          await llmStore.stream(options.model, options.chatProvider, sanitizedRetry.messages as Message[], {
            headers,
            supportsTools: false,
            waitForTools: false,
            abortSignal,
            onStreamEvent: async (event: StreamEvent) => {
              if (event.type === 'text-delta')
                retryFullText += event.text
              if (event.type === 'error')
                throw event.error ?? new Error('Structured contract retry stream error')
            },
          })
        }
        catch (error) {
          if (isAliceAbortError(error) || abortSignal.aborted)
            throw error

          await appendAliceAuditLog({
            level: 'warning',
            category: 'structured-output',
            action: 'contract-retry-failed',
            message: 'Structured contract retry request failed.',
            details: {
              reason: error instanceof Error ? error.message : String(error),
            },
          })
          return null
        }

        const retriedStructured = normalizeStructuredOutput({
          fullText: retryFullText,
          thought: payload.reasoning,
          reply: payload.reply,
          previousEmotion: getPreviousAssistantEmotion(),
        })

        if (hasStructuredJsonContract(retriedStructured)) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'structured-output',
            action: 'contract-retry-succeeded',
            message: 'Structured contract retry succeeded with JSON output.',
            details: {
              parsePath: retriedStructured.parsePath,
            },
          })
          return retriedStructured
        }

        await appendAliceAuditLog({
          level: 'warning',
          category: 'structured-output',
          action: 'contract-retry-unresolved',
          message: 'Structured contract retry still did not produce JSON output.',
          details: {
            parsePath: retriedStructured.parsePath,
          },
        })

        return null
      }

      const buildStructuredOutputWithGuard = async (payload: {
        fullText: string
        reasoning: string
        reply: string
      }): Promise<StructuredWithContract> => {
        const normalized = normalizeStructuredOutput({
          fullText: payload.fullText,
          thought: payload.reasoning,
          reply: payload.reply,
          previousEmotion: getPreviousAssistantEmotion(),
        })

        if (hasStructuredJsonContract(normalized))
          return normalized

        const retried = await runStructuredContractRetry(payload)
        if (retried)
          return retried

        const fallbackReply = payload.reply.trim() || payload.fullText.trim() || assistantStructuredContractFallbackReply
        const fallback = createStructuredFallback(fallbackReply)
        await appendAliceAuditLog({
          level: 'warning',
          category: 'structured-output',
          action: 'contract-fallback',
          message: 'Structured contract failed after retry and switched to fallback-v1.',
          details: {
            parsePath: normalized.parsePath,
          },
        })
        return fallback
      }

      const applyAssistantResult = async (payload: {
        fullText: string
        reasoning: string
        reply: string
        enforceContract?: boolean
        policyLocked?: StructuredPolicyLock
      }) => {
        const structured = payload.enforceContract === false
          ? createStructuredFallback(payload.reply.trim() || payload.fullText.trim() || assistantStructuredContractFallbackReply)
          : await buildStructuredOutputWithGuard(payload)
        if (payload.policyLocked) {
          structured.policyLocked = payload.policyLocked
        }
        const finalReply = structured.reply.trim() || payload.reply

        buildingMessage.categorization = {
          speech: finalReply,
          reasoning: payload.reasoning,
        }
        buildingMessage.structured = structured
        buildingMessage.content = finalReply
        buildingMessage.slices = replaceAssistantTextSlices(buildingMessage.slices, finalReply)
        finalAssistantDisplayText = finalReply
        updateUI()
      }

      const appendConversationTurnRecord = async (assistantText: string) => {
        if (!hasAliceBridge())
          return

        if (abortSignal.aborted || shouldAbort()) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'kill-switch',
            action: 'turn-write-skipped-aborted',
            message: 'Skipped conversation turn persistence because current turn was aborted.',
            details: {
              sessionId,
              turnId,
            },
          })
          return
        }

        await getAliceBridge().appendConversationTurn({
          turnId,
          sessionId,
          userText: sendingMessage,
          assistantText,
          structured: buildingMessage.structured ? { ...buildingMessage.structured } : undefined,
          createdAt: Date.now(),
        }).catch(async (error) => {
          if (isAliceAbortError(error) || abortSignal.aborted || shouldAbort()) {
            await appendAliceAuditLog({
              level: 'notice',
              category: 'kill-switch',
              action: 'turn-write-skipped-aborted',
              message: 'Dropped conversation turn persistence due to abort in runtime write queue.',
              details: {
                sessionId,
                turnId,
              },
            })
            return
          }

          await appendAliceAuditLog({
            level: 'warning',
            category: 'conversation',
            action: 'append-turn-failed',
            message: 'Failed to persist conversation turn into SQLite.',
            details: {
              sessionId,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        })
      }

      const persistBuiltAssistantMessage = () => {
        if (!isStaleGeneration() && buildingMessage.slices.length > 0) {
          sessionMessagesForSend.push(toRaw(buildingMessage))
          chatSession.persistSessionMessages(sessionId)
        }
      }

      const emitAssistantTurnHooks = async (assistantOutputText: string) => {
        await hooks.emitStreamEndHooks(streamingMessageContext)
        await hooks.emitAssistantResponseEndHooks(assistantOutputText, streamingMessageContext)

        await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
        await hooks.emitAssistantMessageHooks({ ...buildingMessage }, assistantOutputText, streamingMessageContext)
        await hooks.emitChatTurnCompleteHooks({
          output: { ...buildingMessage },
          outputText: assistantOutputText,
          toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
        }, streamingMessageContext)
      }

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          if (speechOnly.trim()) {
            buildingMessage.content += speechOnly

            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext)

            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                type: 'text',
                text: speechOnly,
              })
            }
            updateUI()
          }
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
        onEnd: async (fullText) => {
          if (isStaleGeneration())
            return

          const finalCategorization = categorizeResponse(fullText, activeProvider.value)
          const sanitizedOutput = sanitizeAssistantOutputForDisplay(finalCategorization.speech, {
            realtimeIntent: realtimeIntent.needsRealtime,
            verifiedToolResult: turnToolEvidence.verifiedToolResult,
          })
          const emptyAfterSanitize = !sanitizedOutput.cleanText.trim()
          const realtimeFallbackApplied = realtimeIntent.needsRealtime
            && !turnToolEvidence.verifiedToolResult
            && !policyLockedReason
          const leakFallbackApplied = sanitizedOutput.leakDetected && emptyAfterSanitize
          const emptyOutputFallbackApplied = !realtimeFallbackApplied && !leakFallbackApplied && emptyAfterSanitize
          const sanitizeFallbackReply = policyLockedReason
            ? assistantEpoch1StrictFallbackReply
            : assistantLeakFallbackReply
          let finalSpeech = sanitizedOutput.cleanText
          if (realtimeFallbackApplied) {
            finalSpeech = assistantRealtimeUnavailableReply
          }
          else if (leakFallbackApplied || emptyOutputFallbackApplied) {
            finalSpeech = sanitizeFallbackReply
          }

          if (sanitizedOutput.fabricationDetected) {
            await appendAliceAuditLog({
              level: 'warning',
              category: 'output-guard',
              action: 'output-fabrication-sanitized',
              message: 'Assistant output contained fabricated execution fragments and was sanitized.',
              details: {
                removedCount: sanitizedOutput.fabricationRemovedCount,
                realtimeIntent: realtimeIntent.needsRealtime,
                verifiedToolResult: turnToolEvidence.verifiedToolResult,
              },
            })
          }

          if (sanitizedOutput.leakDetected) {
            await appendAliceAuditLog({
              level: leakFallbackApplied ? 'warning' : 'notice',
              category: 'output-guard',
              action: leakFallbackApplied ? 'sanitize-fallback' : 'sanitize-leak',
              message: leakFallbackApplied
                ? 'Assistant output leak detected and fallback reply applied.'
                : 'Assistant output leak detected and sanitized before display.',
              details: {
                removedCount: sanitizedOutput.removedCount,
                redactedSecrets: sanitizedOutput.redactedSecrets,
                fallbackApplied: leakFallbackApplied,
              },
            })
          }

          if (emptyOutputFallbackApplied) {
            await appendAliceAuditLog({
              level: 'warning',
              category: 'output-guard',
              action: 'sanitize-empty-fallback',
              message: 'Assistant output became empty after sanitization; fallback reply applied.',
              details: {
                removedCount: sanitizedOutput.removedCount,
                fabricationDetected: sanitizedOutput.fabricationDetected,
              },
            })
          }

          if (realtimeFallbackApplied) {
            await appendAliceAuditLog({
              level: 'warning',
              category: 'output-guard',
              action: 'realtime-unverified-fallback',
              message: 'Realtime query did not yield verified tool result; fallback reply applied.',
              details: {
                categories: realtimeIntent.categories,
                toolCallCount: turnToolEvidence.toolCallCount,
                toolResultCount: turnToolEvidence.toolResultCount,
                verifiedToolResult: turnToolEvidence.verifiedToolResult,
              },
            })
          }

          await applyAssistantResult({
            fullText,
            reasoning: finalCategorization.reasoning,
            reply: finalSpeech,
            policyLocked: policyLockedReason,
          })

          if (buildingMessage.structured?.repairTimedOut) {
            await appendAliceAuditLog({
              level: 'warning',
              category: 'structured-output',
              action: 'repair-timeout-fallback',
              message: 'Structured output repair exceeded budget and fell back safely.',
              details: {
                parsePath: buildingMessage.structured.parsePath,
              },
            })
          }
        },
        minLiteralEmitLength: 24,
      })

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              updateUI()
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              updateUI()
            }
          },
        ],
      })

      let newMessages = sessionMessagesForSend.map((msg) => {
        const { context: _context, id: _id, createdAt: _createdAt, ...withoutContext } = msg
        const rawMessage = toRaw(withoutContext)

        if (rawMessage.role === 'assistant') {
          const {
            slices: _slices,
            tool_results: _toolResults,
            categorization: _categorization,
            structured: _structured,
            ...rest
          } = rawMessage as ChatAssistantMessage
          return toRaw(rest)
        }

        return rawMessage
      })

      const contextsSnapshot = chatContext.getContextsSnapshot()
      if (hasAliceBridge()) {
        const soulSnapshot = await safelyGetAliceSoulSnapshot()
        const composed = composeAlicePromptMessages({
          messages: newMessages as Message[],
          soulContent: soulSnapshot?.content ?? null,
          hostName: soulSnapshot?.frontmatter?.profile?.hostName ?? null,
          contextsSnapshot,
        })
        newMessages = composed.messages as any

        const budgeted = applyPromptBudget(newMessages as Message[])
        newMessages = budgeted.messages as any
        if (budgeted.report.safeMode.activated) {
          await appendAliceAuditLog({
            level: 'critical',
            category: 'alice.budget',
            action: 'overflow_soul',
            message: 'SOUL exceeded prompt budget and safe mode degradation was applied.',
            details: {
              totalBeforeTokens: budgeted.report.totalBeforeTokens,
              totalAfterTokens: budgeted.report.totalAfterTokens,
              soulTokensBefore: budgeted.report.safeMode.soulTokensBefore,
              soulTokensAfter: budgeted.report.safeMode.soulTokensAfter,
              reason: budgeted.report.safeMode.reason,
            },
          })
        }

        if (!budgeted.report.anchorPreserved) {
          await appendAliceAuditLog({
            level: 'warning',
            category: 'prompt-budget',
            action: 'anchor-mutated',
            message: 'SOUL anchor message changed during budget processing unexpectedly.',
            details: {
              sections: budgeted.report.sections,
            },
          })
        }

        if (budgeted.report.truncated) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'prompt-budget',
            action: 'truncate',
            message: 'Prompt budget manager truncated context before model call.',
            details: {
              totalBeforeTokens: budgeted.report.totalBeforeTokens,
              totalAfterTokens: budgeted.report.totalAfterTokens,
              droppedMessageCount: budgeted.report.droppedMessageCount,
              sections: budgeted.report.sections,
            },
          })
        }

        if (budgeted.report.runtimeContractAnchorRecovered) {
          await appendAliceAuditLog({
            level: 'warning',
            category: 'alice.prompt',
            action: 'runtime-contract-anchor-recovered',
            message: 'Runtime structured contract anchor was missing and recovered by prompt budget guard.',
          })
        }

        const runtimeSystemMessage = budgeted.messages.find((message, index) => index !== 0 && message.role === 'system')
        const runtimeContractAnchorPreserved = typeof runtimeSystemMessage?.content === 'string'
          ? runtimeSystemMessage.content.includes(runtimeContractAnchorHeader)
          : JSON.stringify(runtimeSystemMessage?.content ?? '').includes(runtimeContractAnchorHeader)

        await appendAliceAuditLog({
          level: runtimeContractAnchorPreserved ? 'notice' : 'warning',
          category: 'alice.prompt',
          action: runtimeContractAnchorPreserved
            ? 'runtime-contract-anchor-preserved'
            : 'runtime-contract-anchor-missing',
          message: runtimeContractAnchorPreserved
            ? 'Runtime structured contract anchor is preserved after prompt budgeting.'
            : 'Runtime structured contract anchor is missing after prompt budgeting.',
        })

        const sanitized = sanitizeForRemoteModel(newMessages as Message[], { timeBudgetMs: 50, chunkSize: 2048 })
        if (sanitized.blocked) {
          await appendAliceAuditLog({
            level: 'critical',
            category: 'sanitize',
            action: 'blocked',
            message: 'Outbound model request blocked by sanitize gateway.',
            details: {
              reason: sanitized.reason,
              elapsedMs: sanitized.elapsedMs,
            },
          })
          throw new Error('A.L.I.C.E blocked this outbound request to protect privacy.')
        }

        if (sanitized.redactions > 0) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'sanitize',
            action: 'redacted',
            message: 'Sanitize gateway redacted sensitive content before model call.',
            details: {
              redactions: sanitized.redactions,
              elapsedMs: sanitized.elapsedMs,
            },
          })
        }

        newMessages = sanitized.messages as any
      }
      else if (Object.keys(contextsSnapshot).length > 0) {
        const system = newMessages.slice(0, 1)
        const afterSystem = newMessages.slice(1, newMessages.length)

        newMessages = [
          ...system,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ''
                  + 'These are the contextual information retrieved or on-demand updated from other modules, you may use them as context for chat, or reference of the next action, tool call, etc.:\n'
                  + `${Object.entries(contextsSnapshot).map(([key, value]) => `Module ${key}: ${JSON.stringify(value)}`).join('\n')}\n`,
              },
            ],
          },
          ...afterSystem,
        ]
      }

      streamingMessageContext.composedMessage = newMessages as Message[]

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      let fullText = ''

      if (shouldAbort())
        return

      if (origin === 'ui-user' && hasAliceBridge() && strictEpoch1Mode && realtimeIntent.needsRealtime) {
        policyLockedReason = 'epoch1-strict-realtime'
        const strictRealtimeContext = [
          strictRealtimeRefusalSystemPrompt,
          realtimeIntent.categories.length > 0
            ? `Detected intent categories: ${realtimeIntent.categories.join(', ')}.`
            : '',
        ].filter(Boolean).join('\n')
        const refusalMessages = insertSystemMessageBeforeLatestUser(newMessages as Message[], strictRealtimeContext)
        streamingMessageContext.composedMessage = refusalMessages

        await appendAliceAuditLog({
          level: 'notice',
          category: 'realtime-policy',
          action: 'epoch1-strict-realtime-blocked',
          message: 'Blocked realtime execution in strict Epoch1 mode and switched to personality refusal path.',
          details: {
            sessionId,
            turnId,
            categories: realtimeIntent.categories,
          },
        })

        try {
          await llmStore.stream(options.model, options.chatProvider, refusalMessages, {
            headers,
            supportsTools: false,
            waitForTools: false,
            tools: [],
            abortSignal,
            onStreamEvent: async (event: StreamEvent) => {
              switch (event.type) {
                case 'text-delta':
                  fullText += event.text
                  await parser.consume(event.text)
                  break
                case 'tool-call':
                case 'tool-result':
                case 'finish':
                  break
                case 'error':
                  throw event.error ?? new Error('Strict refusal stream error')
              }
            },
          })

          await parser.end()
        }
        catch (error) {
          if (isAliceAbortError(error) || abortSignal.aborted) {
            throw error
          }

          await appendAliceAuditLog({
            level: 'warning',
            category: 'realtime-policy',
            action: 'epoch1-strict-realtime-refusal-failed',
            message: 'Strict realtime refusal LLM path failed, applied fixed fallback reply.',
            details: {
              sessionId,
              turnId,
              reason: error instanceof Error ? error.message : String(error),
            },
          })

          const fallbackReply = assistantEpoch1StrictFallbackReply
          await applyAssistantResult({
            fullText: fallbackReply,
            reasoning: '',
            reply: fallbackReply,
            enforceContract: false,
            policyLocked: policyLockedReason,
          })
        }

        persistBuiltAssistantMessage()

        const assistantOutputText = finalAssistantDisplayText
          || buildingMessage.structured?.reply
          || stringifyAssistantContent(buildingMessage.content)
          || assistantEpoch1StrictFallbackReply

        await appendConversationTurnRecord(assistantOutputText)
        await emitAssistantTurnHooks(assistantOutputText)

        if (isForegroundSession()) {
          streamingMessage.value = createEmptyStreamingMessage()
        }
        return
      }

      if (origin === 'ui-user' && hasAliceBridge()) {
        const realtimeExecution = await executionEngine.executeRealtimeQueryTurn({
          origin,
          message: sendingMessage,
          abortSignal,
          onStatus: (status) => {
            buildingMessage.slices.push({
              type: 'execution-status',
              phase: status.phase,
              label: status.label,
              source: status.source,
              category: status.category,
            })
            updateUI()
          },
          onAudit: async (entry) => {
            await appendAliceAuditLog({
              level: entry.level,
              category: entry.category,
              action: entry.action,
              message: entry.message,
              details: entry.details,
            })
          },
        })

        if (realtimeExecution.handled) {
          if (abortSignal.aborted) {
            throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError')
          }

          const reply = realtimeExecution.reply?.trim() || assistantRealtimeUnavailableReply
          await applyAssistantResult({
            fullText: reply,
            reasoning: '',
            reply,
            enforceContract: false,
          })
          await appendConversationTurnRecord(finalAssistantDisplayText || reply)
          persistBuiltAssistantMessage()
          await emitAssistantTurnHooks(finalAssistantDisplayText || reply)

          if (isForegroundSession()) {
            streamingMessage.value = createEmptyStreamingMessage()
          }
          return
        }
      }

      await llmStore.stream(options.model, options.chatProvider, newMessages as Message[], {
        headers,
        tools: options.tools,
        supportsTools: true,
        abortSignal,
        // NOTICE: xsai stream may emit `finish` before tool steps continue, so keep waiting until
        // the final non-tool finish to avoid ending the chat turn with no assistant reply.
        waitForTools: true,
        onStreamEvent: async (event: StreamEvent) => {
          switch (event.type) {
            case 'tool-call':
              turnToolEvidence.toolCallCount += 1
              toolCallQueue.enqueue({
                type: 'tool-call',
                toolCall: event,
              })

              break
            case 'tool-result':
              turnToolEvidence.toolResultCount += 1
              if (hasVerifiedToolResult(event.result))
                turnToolEvidence.verifiedToolResult = true
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                result: event.result,
              })

              break
            case 'text-delta':
              fullText += event.text
              await parser.consume(event.text)
              break
            case 'finish':
              break
            case 'error':
              throw event.error ?? new Error('Stream error')
          }
        },
      })

      await parser.end()

      persistBuiltAssistantMessage()

      const assistantOutputText = finalAssistantDisplayText
        || buildingMessage.structured?.reply
        || stringifyAssistantContent(buildingMessage.content)
        || fullText

      await appendConversationTurnRecord(assistantOutputText)

      await emitAssistantTurnHooks(assistantOutputText)

      if (isForegroundSession()) {
        streamingMessage.value = createEmptyStreamingMessage()
      }
    }
    catch (error) {
      if (isAliceAbortError(error) || abortSignal.aborted || shouldAbort()) {
        const abortReason = resolveAbortReason(error, isStaleGeneration())
        const beforeLength = sessionMessagesForSend.length
        if (userTurnMessageId) {
          const nextMessages = sessionMessagesForSend.filter(item => item.id !== userTurnMessageId)
          if (nextMessages.length !== sessionMessagesForSend.length) {
            sessionMessagesForSend.splice(0, sessionMessagesForSend.length, ...nextMessages)
            chatSession.persistSessionMessages(sessionId)
          }
        }

        if (isForegroundSession()) {
          streamingMessage.value = createEmptyStreamingMessage()
        }

        await appendAliceAuditLog({
          level: 'notice',
          category: 'kill-switch',
          action: 'turn-aborted',
          message: 'Active chat turn aborted.',
          details: {
            sessionId,
            turnId,
            reason: abortReason,
          },
        })

        const droppedCount = Math.max(0, beforeLength - sessionMessagesForSend.length)
        if (droppedCount > 0) {
          await appendAliceAuditLog({
            level: 'notice',
            category: 'kill-switch',
            action: 'turn-abort-dropped',
            message: 'Dropped in-flight turn artifacts after abort.',
            details: {
              sessionId,
              turnId,
              droppedCount,
            },
          })
        }
        return
      }

      console.error('Error sending message:', error)
      throw error
    }
    finally {
      completeAliceTurnAbort(turnId)
      sending.value = false
    }
  }

  async function ingest(
    sendingMessage: string,
    options: SendOptions,
    targetSessionId?: string,
  ) {
    if (hasAliceBridge()) {
      const origin = options.origin ?? 'ui-user'
      const isTopLevelInput = origin === 'ui-user'
      const directive = isTopLevelInput ? parseKillSwitchDirective(sendingMessage) : null

      if (!directive) {
        const killSwitch = await getAliceBridge().getKillSwitchState().catch(() => null)
        if (killSwitch?.state === 'SUSPENDED' && isTopLevelInput) {
          throw new Error('A.L.I.C.E is currently suspended. Send "A.L.I.C.E，恢复" to resume.')
        }
      }
    }

    const sessionId = targetSessionId || activeSessionId.value
    const generation = chatSession.getSessionGeneration(sessionId)

    return new Promise<void>((resolve, reject) => {
      sendQueue.enqueue({
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      })
    })
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: SendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string, reason = 'Chat session was reset before send could start') {
    const error = new Error(reason)
    for (const queued of pendingQueuedSends.value) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(error)
    }

    pendingQueuedSends.value = sessionId
      ? pendingQueuedSends.value.filter(item => item.sessionId !== sessionId)
      : []
  }

  async function abortActiveTurns(reason: AliceAbortReason = 'kill-switch') {
    const result = abortAliceTurns({ reason })
    cancelPendingSends(undefined, `A.L.I.C.E turn aborted (${reason})`)
    streamingMessage.value = createEmptyStreamingMessage()

    if (result.aborted > 0) {
      await appendAliceAuditLog({
        level: 'notice',
        category: 'kill-switch',
        action: 'kill-switch-abort-broadcast',
        message: 'Broadcasted turn abort to active pipelines.',
        details: {
          reason,
          aborted: result.aborted,
        },
      })
    }

    return result
  }

  function registerPipelineAborter(aborter: ExternalPipelineAborter) {
    externalPipelineAborters.add(aborter)
    return () => {
      externalPipelineAborters.delete(aborter)
    }
  }

  async function abortAllPipelines(reason: AliceAbortReason = 'kill-switch') {
    const turnAbortResult = await abortActiveTurns(reason)
    const pipelines = [...externalPipelineAborters]
    let pipelineErrors = 0

    await Promise.all(pipelines.map(async (aborter) => {
      try {
        await aborter(reason)
      }
      catch (error) {
        pipelineErrors += 1
        await appendAliceAuditLog({
          level: 'warning',
          category: 'kill-switch',
          action: 'pipeline-abort-failed',
          message: 'Failed to abort external pipeline during kill switch.',
          details: {
            reason,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }))

    return {
      ...turnAbortResult,
      pipelineAborters: pipelines.length,
      pipelineErrors,
    }
  }

  return {
    sending,

    discoverToolsCompatibility: llmStore.discoverToolsCompatibility,

    ingest,
    ingestOnFork,
    cancelPendingSends,
    abortActiveTurns,
    abortAllPipelines,
    registerPipelineAborter,

    clearHooks: hooks.clearHooks,

    emitBeforeMessageComposedHooks: hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: hooks.emitBeforeSendHooks,
    emitAfterSendHooks: hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: hooks.onBeforeMessageComposed,
    onAfterMessageComposed: hooks.onAfterMessageComposed,
    onBeforeSend: hooks.onBeforeSend,
    onAfterSend: hooks.onAfterSend,
    onTokenLiteral: hooks.onTokenLiteral,
    onTokenSpecial: hooks.onTokenSpecial,
    onStreamEnd: hooks.onStreamEnd,
    onAssistantResponseEnd: hooks.onAssistantResponseEnd,
    onAssistantMessage: hooks.onAssistantMessage,
    onChatTurnComplete: hooks.onChatTurnComplete,
  }
})
