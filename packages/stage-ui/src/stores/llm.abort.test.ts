import type { ChatProvider } from '@xsai-ext/providers/utils'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const streamTextMock = vi.hoisted(() => vi.fn())

vi.mock('@xsai/stream-text', () => ({
  streamText: streamTextMock,
}))

vi.mock('../tools', () => ({
  debug: async () => [],
  mcp: async () => [],
}))

function createChatProviderStub(): ChatProvider {
  return {
    chat: () => ({
      baseURL: 'https://example.test/v1/',
      model: 'mock-model',
    }),
  } as ChatProvider
}

describe('llm stream abort handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    streamTextMock.mockReset()
  })

  it('rejects when the abort signal fires before the provider emits finish/error', async () => {
    const { useLLM } = await import('./llm')
    const store = useLLM()
    const controller = new AbortController()

    streamTextMock.mockImplementation(() => undefined)

    const pending = store.stream('mock-model', createChatProviderStub(), [
      { role: 'user', content: 'hello' },
    ], {
      abortSignal: controller.signal,
    })

    controller.abort(new DOMException('Aborted', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
