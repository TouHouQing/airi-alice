import type { Message } from '@xsai/shared-chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { describe, expect, it } from 'vitest'

import { composeAlicePromptMessages } from './alice-prompt-composer'

describe('alice prompt composer', () => {
  it('strips legacy system messages and keeps a single system layer', () => {
    const inputMessages: Message[] = [
      { role: 'system', content: 'legacy-system' },
      { role: 'user', content: 'hello' },
    ]

    const result = composeAlicePromptMessages({
      messages: inputMessages,
      soulContent: '# SOUL',
      hostName: 'AliceHost',
      contextsSnapshot: {},
    })

    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(String(result.messages[0]?.content)).toContain('# SOUL')
    expect(String(result.messages[0]?.content)).toContain('AliceHost')
    expect(String(result.messages[0]?.content)).not.toContain('legacy-system')
  })

  it('merges datetime and memory context into system layer', () => {
    const result = composeAlicePromptMessages({
      messages: [{ role: 'user', content: 'ping' }],
      soulContent: '# SOUL',
      hostName: 'Host',
      contextsSnapshot: {
        alice: [
          {
            id: 'ctx-memory',
            contextId: 'alice:memory',
            strategy: ContextUpdateStrategy.ReplaceSelf,
            text: '- user likes tea',
            createdAt: Date.now(),
          },
        ],
        datetime: [
          {
            id: 'ctx-datetime',
            contextId: 'system:datetime',
            strategy: ContextUpdateStrategy.ReplaceSelf,
            text: JSON.stringify({
              iso: '2026-03-07T12:00:00.000Z',
              local: '2026/3/7 20:00:00',
            }),
            createdAt: Date.now(),
          },
        ],
      },
    })

    expect(result.messages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(String(result.messages[0]?.content)).toContain('Relevant memory facts:')
    expect(String(result.messages[0]?.content)).toContain('Current datetime:')
    expect(result.messages.at(-1)?.role).toBe('user')
  })
})
