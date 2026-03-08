import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { ChatAssistantMessage, ChatSlices, ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from './llm'

import { createQueue } from '@proj-airi/stream-kit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw } from 'vue'

import { useAnalytics } from '../composables'
import { applyPromptBudget, sanitizeAssistantOutputForDisplay, sanitizeForRemoteModel } from '../composables/alice-guardrails'
import { composeAlicePromptMessages } from '../composables/alice-prompt-composer'
import { detectRealtimeQueryIntent, runRealtimeQueryPreflight } from '../composables/alice-realtime-query'
import { normalizeStructuredOutput } from '../composables/alice-structured-output'
import { useLlmmarkerParser } from '../composables/llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from '../composables/response-categoriser'
import { getAliceBridge, hasAliceBridge } from './alice-bridge'
import { createDatetimeContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { createChatHooks } from './chat/hooks'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useLLM } from './llm'
import { getMcpToolBridge } from './mcp-tool-bridge'
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

const assistantLeakFallbackReply = '我刚才的检索结果混入了内部调用片段，已自动过滤。请你再说一次你的问题，我会直接给你整理后的结果。'
const assistantRealtimeUnavailableReply = '当前无法获取可靠的实时外部数据。请稍后重试，或在设置里检查 MCP 实时工具是否可用。'

interface TurnToolEvidence {
  toolCallCount: number
  toolResultCount: number
  verifiedToolResult: boolean
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

function hasVerifiedToolResult(result?: string | CommonContentPart[]) {
  if (typeof result === 'string') {
    return result.trim().length > 0
  }

  if (!Array.isArray(result))
    return false

  return result.some((part) => {
    if (part && typeof part === 'object' && 'text' in part)
      return String((part as { text?: unknown }).text ?? '').trim().length > 0
    return Boolean(part && Object.keys(part).length > 0)
  })
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

    const sendingCreatedAt = Date.now()
    const streamingMessageContext: ChatStreamEventContext = {
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: nanoid() },
      contexts: chatContext.getContextsSnapshot(),
      composedMessage: [],
      input: options.input,
    }

    const isStaleGeneration = () => chatSession.getSessionGeneration(sessionId) !== generation
    const shouldAbort = () => isStaleGeneration()
    if (shouldAbort())
      return

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
            streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
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

      const sessionMessagesForSend = chatSession.sessionMessages[sessionId]
      if (!sessionMessagesForSend) {
        throw new Error('Session messages not found')
      }
      sessionMessagesForSend.push({ role: 'user', content: finalContent, createdAt: sendingCreatedAt, id: nanoid() })
      chatSession.persistSessionMessages(sessionId)

      const origin = options.origin ?? 'ui-user'
      const realtimeIntent = hasAliceBridge() && origin === 'ui-user'
        ? detectRealtimeQueryIntent(sendingMessage)
        : detectRealtimeQueryIntent('')
      const turnToolEvidence: TurnToolEvidence = {
        toolCallCount: 0,
        toolResultCount: 0,
        verifiedToolResult: false,
      }

      const categorizer = createStreamingCategorizer(activeProvider.value)
      let streamPosition = 0
      let finalAssistantDisplayText = ''

      const applyAssistantResult = (payload: {
        fullText: string
        reasoning: string
        reply: string
      }) => {
        const previousAssistant = [...sessionMessagesForSend]
          .reverse()
          .find(message => message.role === 'assistant' && 'structured' in message && message.structured)

        const structured = normalizeStructuredOutput({
          fullText: payload.fullText,
          thought: payload.reasoning,
          reply: payload.reply,
          previousEmotion: previousAssistant && 'structured' in previousAssistant
            ? previousAssistant.structured?.emotion
            : undefined,
        })

        buildingMessage.categorization = {
          speech: payload.reply,
          reasoning: payload.reasoning,
        }
        buildingMessage.structured = structured
        buildingMessage.content = payload.reply
        buildingMessage.slices = replaceAssistantTextSlices(buildingMessage.slices, payload.reply)
        finalAssistantDisplayText = payload.reply
        updateUI()
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
          const realtimeFallbackApplied = realtimeIntent.needsRealtime && !turnToolEvidence.verifiedToolResult
          const leakFallbackApplied = sanitizedOutput.leakDetected && emptyAfterSanitize
          const emptyOutputFallbackApplied = !realtimeFallbackApplied && !leakFallbackApplied && emptyAfterSanitize
          const finalSpeech = realtimeFallbackApplied
            ? assistantRealtimeUnavailableReply
            : (leakFallbackApplied || emptyOutputFallbackApplied)
                ? assistantLeakFallbackReply
                : sanitizedOutput.cleanText

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

          applyAssistantResult({
            fullText,
            reasoning: finalCategorization.reasoning,
            reply: finalSpeech,
          })
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
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      if (shouldAbort())
        return

      if (realtimeIntent.needsRealtime) {
        const preflight = await runRealtimeQueryPreflight({
          intent: realtimeIntent,
          timeoutMs: 1500,
          listTools: async () => {
            return await getMcpToolBridge().listTools()
          },
        })

        if (!preflight.allowed) {
          await appendAliceAuditLog({
            level: 'warning',
            category: 'output-guard',
            action: 'realtime-preflight-blocked',
            message: 'Realtime query blocked because no suitable MCP tool is currently available.',
            details: {
              reason: preflight.reason,
              categories: preflight.categories,
              matchedCategories: preflight.matchedCategories,
              availableToolCount: preflight.availableToolCount,
            },
          })

          applyAssistantResult({
            fullText: assistantRealtimeUnavailableReply,
            reasoning: '',
            reply: assistantRealtimeUnavailableReply,
          })
          persistBuiltAssistantMessage()
          await emitAssistantTurnHooks(assistantRealtimeUnavailableReply)

          if (isForegroundSession()) {
            streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
          }
          return
        }
      }

      await llmStore.stream(options.model, options.chatProvider, newMessages as Message[], {
        headers,
        tools: options.tools,
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

      await emitAssistantTurnHooks(assistantOutputText)

      if (isForegroundSession()) {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      }
    }
    catch (error) {
      console.error('Error sending message:', error)
      throw error
    }
    finally {
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

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends.value) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends.value = sessionId
      ? pendingQueuedSends.value.filter(item => item.sessionId !== sessionId)
      : []
  }

  return {
    sending,

    discoverToolsCompatibility: llmStore.discoverToolsCompatibility,

    ingest,
    ingestOnFork,
    cancelPendingSends,

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
