import type { Message } from '@xsai/shared-chat'

import type { ContextMessage } from '../types/chat'

import {
  aliceFixedCoreSystemInstruction,
  aliceFixedDatetimeContextTemplate,
  aliceFixedGenericContextTemplate,
  aliceFixedHostNameDirectiveTemplate,
  aliceFixedMemoryContextTemplate,
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

      sections.push(renderAlicePromptTemplate(aliceFixedGenericContextTemplate, {
        source,
        content,
        iso: '',
        local: '',
      }))
    }
  }

  return sections
}

export function composeAlicePromptMessages(input: {
  messages: Message[]
  soulContent?: string | null
  hostName?: string | null
  contextsSnapshot?: Record<string, ContextMessage[]>
}) {
  const nextMessages = stripLegacySystemMessages(input.messages)
  const systemSections: string[] = []
  const soulContent = input.soulContent?.trim()
  const hostName = input.hostName?.trim()

  if (soulContent)
    systemSections.push(soulContent)

  if (aliceFixedCoreSystemInstruction.trim()) {
    systemSections.push(aliceFixedCoreSystemInstruction.trim())
  }

  if (hostName) {
    systemSections.push(renderAlicePromptTemplate(aliceFixedHostNameDirectiveTemplate, {
      hostName,
      source: 'host',
      content: '',
      iso: '',
      local: '',
    }).trim())
  }

  const contextSections = buildAliceContextSections(input.contextsSnapshot ?? {})
  if (contextSections.length > 0) {
    systemSections.push(contextSections.join('\n\n'))
  }

  const finalMessages: Message[] = []
  if (systemSections.length > 0) {
    finalMessages.push({
      role: 'system',
      content: systemSections.join('\n\n'),
    })
  }

  finalMessages.push(...nextMessages)
  return {
    messages: finalMessages,
  }
}
