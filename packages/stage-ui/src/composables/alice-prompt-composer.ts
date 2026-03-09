import type { Message } from '@xsai/shared-chat'

import type { ContextMessage } from '../types/chat'

import {
  aliceFixedCoreSystemInstruction,
  aliceFixedDatetimeContextTemplate,
  aliceFixedGenericContextTemplate,
  aliceFixedHostNameDirectiveTemplate,
  aliceFixedMemoryContextTemplate,
  aliceFixedSensoryContextTemplate,
  aliceFixedStructuredContractAnchor,
  renderAlicePromptTemplate,
} from '@proj-airi/stage-shared/alice-prompting'

function readContextText(content: string | Array<string | { text?: unknown }>) {
  if (typeof content === 'string')
    return content

  return content
    .map((part) => {
      if (typeof part === 'string')
        return part
      if (part && typeof part === 'object' && 'text' in part)
        return String(part.text ?? '')
      return ''
    })
    .join('\n')
}

export function stripLegacySystemMessages(messages: Message[]) {
  return messages.filter(message => message.role !== 'system')
}

function buildAliceContextSections(contextsSnapshot: Record<string, ContextMessage[]>) {
  const sections: string[] = []
  const sensorySections: string[] = []

  for (const [source, contexts] of Object.entries(contextsSnapshot)) {
    for (const context of contexts) {
      const content = readContextText(context.text).trim()
      if (!content)
        continue

      if (context.contextId === 'system:datetime') {
        try {
          const parsed = JSON.parse(content) as { iso?: string, local?: string }
          sections.push(renderAlicePromptTemplate(aliceFixedDatetimeContextTemplate, {
            source,
            content,
            iso: parsed.iso ?? '',
            local: parsed.local ?? '',
          }))
        }
        catch {
          sections.push(renderAlicePromptTemplate(aliceFixedDatetimeContextTemplate, {
            source,
            content,
            iso: '',
            local: content,
          }))
        }
        continue
      }

      if (context.contextId === 'alice:memory') {
        sections.push(renderAlicePromptTemplate(aliceFixedMemoryContextTemplate, {
          source,
          content,
          iso: '',
          local: '',
        }))
        continue
      }

      if (context.contextId === 'alice:sensory') {
        sensorySections.push(renderAlicePromptTemplate(aliceFixedSensoryContextTemplate, {
          source,
          content,
          iso: '',
          local: '',
        }))
        continue
      }

      sections.push(renderAlicePromptTemplate(aliceFixedGenericContextTemplate, {
        source,
        content,
        iso: '',
        local: '',
      }))
    }
  }

  return {
    sections,
    sensorySections,
  }
}

export function composeAlicePromptMessages(input: {
  messages: Message[]
  soulContent?: string | null
  hostName?: string | null
  contextsSnapshot?: Record<string, ContextMessage[]>
}) {
  const nextMessages = stripLegacySystemMessages(input.messages)
  const anchorSystemSections: string[] = []
  const runtimeSystemSections: string[] = []
  const soulContent = input.soulContent?.trim()
  const hostName = input.hostName?.trim()

  if (soulContent)
    anchorSystemSections.push(soulContent)

  if (aliceFixedCoreSystemInstruction.trim()) {
    runtimeSystemSections.push(aliceFixedCoreSystemInstruction.trim())
  }

  if (hostName) {
    runtimeSystemSections.push(renderAlicePromptTemplate(aliceFixedHostNameDirectiveTemplate, {
      hostName,
      source: 'host',
      content: '',
      iso: '',
      local: '',
    }).trim())
  }

  const { sections: contextSections, sensorySections } = buildAliceContextSections(input.contextsSnapshot ?? {})
  if (contextSections.length > 0) {
    runtimeSystemSections.push(contextSections.join('\n\n'))
  }

  if (sensorySections.length > 0) {
    runtimeSystemSections.push(sensorySections.join('\n\n'))
  }

  if (aliceFixedStructuredContractAnchor.trim())
    runtimeSystemSections.push(aliceFixedStructuredContractAnchor.trim())

  const finalMessages: Message[] = []
  if (anchorSystemSections.length > 0) {
    finalMessages.push({
      role: 'system',
      content: anchorSystemSections.join('\n\n'),
    })
  }

  if (runtimeSystemSections.length > 0) {
    finalMessages.push({
      role: 'system',
      content: runtimeSystemSections.join('\n\n'),
    })
  }

  finalMessages.push(...nextMessages)
  return {
    messages: finalMessages,
  }
}
