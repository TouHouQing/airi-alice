import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearAliceBridge, setAliceBridge } from './alice-bridge'
import { useAliceExecutionEngineStore } from './alice-execution-engine'
import { clearMcpToolBridge, setMcpToolBridge } from './mcp-tool-bridge'

function createAliceBridgeStub(overrides?: Partial<Parameters<typeof setAliceBridge>[0]>) {
  return {
    bootstrap: vi.fn(),
    getSoul: vi.fn(),
    initializeGenesis: vi.fn(),
    updateSoul: vi.fn(),
    updatePersonality: vi.fn(),
    getKillSwitchState: vi.fn(),
    suspendKillSwitch: vi.fn(),
    resumeKillSwitch: vi.fn(),
    getMemoryStats: vi.fn(),
    runMemoryPrune: vi.fn(),
    updateMemoryStats: vi.fn(),
    retrieveMemoryFacts: vi.fn(),
    upsertMemoryFacts: vi.fn(),
    importLegacyMemory: vi.fn(),
    appendAuditLog: vi.fn(),
    realtimeExecute: vi.fn(),
    ...overrides,
  } as any
}

describe('alice execution engine', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearAliceBridge()
    clearMcpToolBridge()
  })

  afterEach(() => {
    clearAliceBridge()
    clearMcpToolBridge()
    vi.restoreAllMocks()
  })

  it('handles realtime weather query with builtin execution', async () => {
    const realtimeExecute = vi.fn().mockResolvedValue({
      category: 'weather',
      source: 'builtin',
      ok: true,
      summary: 'United States 当前天气：晴朗；温度 22.0°C。',
      durationMs: 120,
    })
    setAliceBridge(createAliceBridgeStub({ realtimeExecute }))

    setMcpToolBridge({
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({ isError: true, ok: false }),
      getCapabilitiesSnapshot: vi.fn().mockResolvedValue({
        path: '',
        updatedAt: Date.now(),
        servers: [],
        tools: [],
        healthyServers: 0,
      }),
    })

    const store = useAliceExecutionEngineStore()
    const output = await store.executeRealtimeQueryTurn({
      origin: 'ui-user',
      message: '帮我查一下今天美国天气',
    })

    expect(output.handled).toBe(true)
    expect(output.reply).toContain('天气（内置源）')
    expect(output.trace.toolEvidence.verifiedToolResult).toBe(true)
    expect(realtimeExecute).toHaveBeenCalledTimes(1)
  })

  it('falls back honestly when no verified evidence exists', async () => {
    const realtimeExecute = vi.fn().mockResolvedValue({
      category: 'news',
      source: 'builtin',
      ok: false,
      errorCode: 'NO_DATA',
      errorMessage: 'empty',
      durationMs: 90,
    })
    setAliceBridge(createAliceBridgeStub({ realtimeExecute }))

    setMcpToolBridge({
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({ isError: true, ok: false }),
      getCapabilitiesSnapshot: vi.fn().mockResolvedValue({
        path: '',
        updatedAt: Date.now(),
        servers: [],
        tools: [],
        healthyServers: 0,
      }),
    })

    const audits: string[] = []
    const store = useAliceExecutionEngineStore()
    const output = await store.executeRealtimeQueryTurn({
      origin: 'ui-user',
      message: '今天美国发生了什么',
      onAudit: async (entry) => {
        audits.push(entry.action)
      },
    })

    expect(output.handled).toBe(true)
    expect(output.trace.fallbackApplied).toBe(true)
    expect(output.reply).toContain('当前无法获取可靠的实时')
    expect(audits).toContain('unverified-fallback')
  })

  it('does not treat mcp isError result as verified evidence', async () => {
    const realtimeExecute = vi.fn().mockResolvedValue({
      category: 'weather',
      source: 'builtin',
      ok: false,
      errorCode: 'NO_DATA',
      errorMessage: 'empty',
      durationMs: 20,
    })
    setAliceBridge(createAliceBridgeStub({ realtimeExecute }))

    setMcpToolBridge({
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        ok: false,
        content: [{ type: 'text', text: 'upstream failed' }],
      }),
      getCapabilitiesSnapshot: vi.fn().mockResolvedValue({
        path: '',
        updatedAt: Date.now(),
        servers: [{ name: 'weather', state: 'running', command: 'node', args: [], pid: 1 }],
        tools: [{
          serverName: 'weather',
          name: 'weather::get_weather',
          toolName: 'get_weather',
          description: 'weather lookup',
          inputSchema: {},
        }],
        healthyServers: 1,
      }),
    })

    const store = useAliceExecutionEngineStore()
    const output = await store.executeRealtimeQueryTurn({
      origin: 'ui-user',
      message: '今天美国天气',
    })

    expect(output.handled).toBe(true)
    expect(output.trace.toolEvidence.verifiedToolResult).toBe(false)
    expect(output.trace.fallbackApplied).toBe(true)
  })

  it('passes through non-realtime messages', async () => {
    setAliceBridge(createAliceBridgeStub({
      realtimeExecute: vi.fn(),
    }))
    setMcpToolBridge({
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({}),
      getCapabilitiesSnapshot: vi.fn().mockResolvedValue({
        path: '',
        updatedAt: Date.now(),
        servers: [],
        tools: [],
        healthyServers: 0,
      }),
    })

    const store = useAliceExecutionEngineStore()
    const output = await store.executeRealtimeQueryTurn({
      origin: 'ui-user',
      message: '帮我写一个 TypeScript 函数',
    })

    expect(output.handled).toBe(false)
    expect(output.intent.needsRealtime).toBe(false)
  })
})
