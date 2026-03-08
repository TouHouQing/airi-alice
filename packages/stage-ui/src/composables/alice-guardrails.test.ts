import type { Message } from '@xsai/shared-chat'

import { describe, expect, it } from 'vitest'

import { applyPromptBudget, sanitizeAssistantOutputForDisplay, sanitizeForRemoteModel } from './alice-guardrails'

describe('alice guardrails', () => {
  it('redacts sensitive values before outbound model call', () => {
    const messages: Message[] = [
      { role: 'system', content: 'SOUL prompt' },
      {
        role: 'user',
        content: 'api_key=secret1234 token=tok_abcdef sk-1234567890123456789012345',
      },
    ]

    const sanitized = sanitizeForRemoteModel(messages)

    expect(sanitized.blocked).toBe(false)
    expect(sanitized.redactions).toBeGreaterThan(0)
    expect(JSON.stringify(sanitized.messages)).toContain('[REDACTED]')
  })

  it('keeps image parts while sanitizing text parts', () => {
    const sanitized = sanitizeForRemoteModel([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'password=abc123' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ])

    expect(sanitized.blocked).toBe(false)
    const serialized = JSON.stringify(sanitized.messages[0]?.content)
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('image_url')
  })

  it('blocks outbound request on sanitize timeout', () => {
    const hugeText = 'token=abc123 '.repeat(8000)
    const sanitized = sanitizeForRemoteModel([
      { role: 'user', content: hugeText },
    ], {
      timeBudgetMs: 0,
      chunkSize: 32,
    })

    expect(sanitized.blocked).toBe(true)
    expect(sanitized.reason).toBe('sanitize-timeout')
  })

  it('applies section budgets and keeps current user turn', () => {
    const messages: Message[] = [
      {
        role: 'system',
        content: 'SOUL'.repeat(1200),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Relevant memory facts:',
              '- user likes coffee (confidence=0.91)',
              '- user dislikes bugs (confidence=0.23)',
              '- user plan ship release (confidence=0.45)',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'assistant',
        content: 'history'.repeat(900),
      },
      {
        role: 'user',
        content: '请保留这一轮关键指令：修复登录流程并写测试。'.repeat(100),
      },
    ]

    const { messages: nextMessages, report } = applyPromptBudget(messages, { totalTokens: 600 })

    expect(report.truncated).toBe(true)
    expect(report.totalAfterTokens).toBeLessThanOrEqual(600)

    const currentTurn = nextMessages.at(-1)
    expect(currentTurn?.role).toBe('user')
    expect(typeof currentTurn?.content === 'string' ? currentTurn.content : JSON.stringify(currentTurn?.content)).toContain('修复登录流程')
  })

  it('removes leaked mcp tool payload text from assistant output', () => {
    const leaked = [
      '{"name":"mcp_call_tool","arguments":{"name":"weather::get_weather","parameters":[{"name":"location","value":"United States"}],"toolbench_rapidapi_key":"secret-key"}}',
      'mcp_call_tool',
    ].join('\n')

    const sanitized = sanitizeAssistantOutputForDisplay(leaked)

    expect(sanitized.leakDetected).toBe(true)
    expect(sanitized.removedCount).toBeGreaterThan(0)
    expect(sanitized.redactedSecrets).toBeGreaterThan(0)
    expect(sanitized.cleanText).toBe('')
    expect(sanitized.cleanText).not.toContain('mcp_call_tool')
    expect(sanitized.cleanText).not.toContain('toolbench_rapidapi_key')
  })

  it('keeps natural language content while dropping leaked tool fragments', () => {
    const mixed = [
      '今天美国有几件值得关注的新闻：',
      '{"name":"mcp_call_tool","arguments":{"name":"current_events::get_recent_events","parameters":[{"name":"location","value":"UnitedStates"}]}}',
      '1. 国会预算谈判继续推进。',
    ].join('\n')

    const sanitized = sanitizeAssistantOutputForDisplay(mixed)

    expect(sanitized.leakDetected).toBe(true)
    expect(sanitized.cleanText).toContain('今天美国有几件值得关注的新闻')
    expect(sanitized.cleanText).toContain('1. 国会预算谈判继续推进。')
    expect(sanitized.cleanText).not.toContain('mcp_call_tool')
    expect(sanitized.cleanText).not.toContain('current_events::get_recent_events')
  })

  it('returns leakDetected with empty clean text for pure internal call output', () => {
    const onlyLeak = 'mcp_list_tools {"arguments":{"parameters":[{"name":"location","value":"US"}]}}'
    const sanitized = sanitizeAssistantOutputForDisplay(onlyLeak)

    expect(sanitized.leakDetected).toBe(true)
    expect(sanitized.cleanText).toBe('')
  })

  it('detects fabricated api execution snippets in realtime strict mode', () => {
    const fabricated = '好的，让我帮您查一下今天美国发生了什么。pythonimportrequestsdefget_recent_events(location):url=f"https://api.example.com/events?location={location}"我正在调用一个假设的API，请稍等一下，我会返回具体的信息。'
    const sanitized = sanitizeAssistantOutputForDisplay(fabricated, {
      realtimeIntent: true,
      verifiedToolResult: false,
    })

    expect(sanitized.fabricationDetected).toBe(true)
    expect(sanitized.fabricationRemovedCount).toBeGreaterThan(0)
    expect(sanitized.cleanText).toBe('')
  })

  it('keeps non-fabricated summary while dropping wait promises in realtime strict mode', () => {
    const mixed = [
      '我查到今天美国有三条值得关注的事件。',
      '请稍等一下，我会返回具体的信息。',
    ].join('\n')

    const sanitized = sanitizeAssistantOutputForDisplay(mixed, {
      realtimeIntent: true,
      verifiedToolResult: false,
    })

    expect(sanitized.fabricationDetected).toBe(true)
    expect(sanitized.cleanText).toContain('三条值得关注的事件')
    expect(sanitized.cleanText).not.toContain('请稍等')
  })
})
