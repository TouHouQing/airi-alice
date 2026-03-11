import type { ElectronMcpCallToolResult } from '../../../../shared/eventa'
import type { McpStdioManager } from './index'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  aliceSafetyPermissionRequested,
  electronAliceSafetyResolvePermission,
  electronMcpCallTool,
} from '../../../../shared/eventa'

const invokeHandlers = new Map<unknown, (payload?: any) => Promise<any>>()
const contextEmitMock = vi.fn()
const appendAuditLogMock = vi.fn().mockResolvedValue(undefined)
const isKillSwitchSuspendedMock = vi.fn(() => false)
const killSwitchListeners = new Set<(snapshot: { state: 'ACTIVE' | 'SUSPENDED', reason?: string, updatedAt: number }) => void>()

vi.mock('@moeru/eventa', () => ({
  defineEventa: (name: string) => ({ name }),
  defineInvokeEventa: (name: string) => ({ name }),
  defineInvokeHandler: (_context: unknown, event: unknown, handler: (payload?: any) => Promise<any>) => {
    invokeHandlers.set(event, handler)
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData')
        return '/tmp/alice-user-data'
      if (name === 'documents')
        return '/tmp/documents'
      return '/tmp'
    }),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
  shell: {
    openPath: vi.fn(async () => ''),
  },
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

vi.mock('../../alice/state', () => ({
  appendAliceRuntimeAuditLog: appendAuditLogMock,
  isAliceKillSwitchSuspended: isKillSwitchSuspendedMock,
  onAliceKillSwitchChanged: vi.fn((listener: (snapshot: { state: 'ACTIVE' | 'SUSPENDED', reason?: string, updatedAt: number }) => void) => {
    killSwitchListeners.add(listener)
    return () => {
      killSwitchListeners.delete(listener)
    }
  }),
}))

function createManager(overrides?: Partial<McpStdioManager>): McpStdioManager {
  return {
    ensureConfigFile: vi.fn(async () => ({ path: '/tmp/mcp.json' })),
    openConfigFile: vi.fn(),
    applyAndRestart: vi.fn(),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ ok: true, isError: false })),
    stopAll: vi.fn(),
    getRuntimeStatus: vi.fn() as any,
    getCapabilitiesSnapshot: vi.fn() as any,
    ...overrides,
  }
}

function getSafetyRequests() {
  return contextEmitMock.mock.calls
    .filter(([event]) => event === aliceSafetyPermissionRequested)
    .map(([, payload]) => payload)
}

function emitKillSwitchState(state: 'ACTIVE' | 'SUSPENDED', reason = 'test') {
  const snapshot = { state, reason, updatedAt: Date.now() }
  for (const listener of [...killSwitchListeners]) {
    listener(snapshot)
  }
}

function parseToolErrorJson(result: ElectronMcpCallToolResult) {
  const text = typeof result.content?.[0]?.text === 'string'
    ? result.content[0].text
    : ''
  return text ? JSON.parse(text) as { status: string, code: string, message: string } : null
}

describe('mcp safety gate', () => {
  beforeEach(() => {
    invokeHandlers.clear()
    contextEmitMock.mockReset()
    appendAuditLogMock.mockClear()
    isKillSwitchSuspendedMock.mockReset()
    isKillSwitchSuspendedMock.mockReturnValue(false)
    killSwitchListeners.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('blocks reads to alice internal root by absolute blacklist', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const result = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/alice-user-data/alice/SOUL.md',
      },
    })

    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(parseToolErrorJson(result)).toEqual(expect.objectContaining({
      status: 'error',
      code: 'ALICE_TOOL_DENIED',
    }))
    expect(manager.callTool).not.toBeCalled()
    expect(contextEmitMock).not.toBeCalledWith(aliceSafetyPermissionRequested, expect.anything())
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      category: 'alice.tool.blocked.blacklist',
      payload: expect.objectContaining({
        path: expect.any(String),
      }),
    }))
  })

  it('denies when any path candidate hits blacklist even if another path is safe', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const result = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        sourcePath: '/tmp/documents/Alice_Workspace/notes.txt',
        targetPath: '/tmp/alice-user-data/alice/alice.db',
      },
    })

    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(manager.callTool).not.toBeCalled()
  })

  it('denies relative traversal into userData root without prompting', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const result = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '../../alice-user-data/alice/alice.db',
      },
    })

    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(parseToolErrorJson(result)).toEqual(expect.objectContaining({
      status: 'error',
      code: 'ALICE_TOOL_DENIED',
    }))
    expect(manager.callTool).not.toBeCalled()
    expect(getSafetyRequests()).toHaveLength(0)
  })

  it('allows relative workspace path by resolving against sandbox root', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const result = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: 'notes/today.md',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
    expect(getSafetyRequests()).toHaveLength(0)
  })

  it('allows sandbox read without prompting and executes tool directly', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const result = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/notes.txt',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
    expect(getSafetyRequests()).toHaveLength(0)
  })

  it('requires prompt for traversal path escaping workspace', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/../secret.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    expect(request?.riskLevel).toBe('sensitive')
    expect(String(request?.resourceLabel)).toContain('secret.txt')

    await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: true,
      rememberSession: false,
      reason: 'user-approved',
    })

    const result = await pending
    expect(result.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
  })

  it('requires human confirmation for unknown tool action category', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const pending = callTool!({
      name: 'custom::mystery_operation',
      arguments: {
        value: 'noop',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    expect(request?.actionCategory).toBe('unknown')
    expect(request?.riskLevel).toBe('sensitive')

    await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: true,
      reason: 'user-approved',
    })

    const result = await pending
    expect(result.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
  })

  it('uses one-time permission token and enables session whitelist', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const firstPending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/other-project/notes.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    const decisionResult = await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: true,
      rememberSession: true,
      reason: 'user-approved',
    })
    expect(decisionResult.accepted).toBe(true)

    const firstResult = await firstPending
    expect(firstResult.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)

    const replayResult = await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: true,
      reason: 'replay',
    })
    expect(replayResult).toEqual({
      accepted: false,
      reason: 'not-found',
    })

    contextEmitMock.mockReset()
    const secondResult = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/other-project/notes.txt',
      },
    })
    expect(secondResult.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(2)
    expect(getSafetyRequests()).toHaveLength(0)
  })

  it('rejects permission resolution when requestId does not match token context', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/other-project/mismatch.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    const mismatched = await resolvePermission!({
      token: request.token,
      requestId: 'wrong-request-id',
      allow: true,
      reason: 'forged',
    })
    expect(mismatched).toEqual({ accepted: false, reason: 'context-mismatch' })

    const correct = await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: true,
      reason: 'user-approved',
    })
    expect(correct.accepted).toBe(true)

    const result = await pending
    expect(result.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
  })

  it('returns explicit user-denied error and keeps loop alive', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/outside/denied.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    const deniedDecision = await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: false,
      reason: 'user-denied',
    })
    expect(deniedDecision.accepted).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(parseToolErrorJson(result)).toEqual(expect.objectContaining({
      status: 'error',
      code: 'ALICE_TOOL_DENIED',
    }))
    expect(String(result.errorMessage)).toContain('User explicitly denied')
    expect(manager.callTool).not.toBeCalled()
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      action: 'alice.safety.permission.denied',
      payload: expect.objectContaining({
        reason: 'user-denied',
      }),
    }))
  })

  it('stays usable after explicit denial and can execute subsequent safe call', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    const resolvePermission = invokeHandlers.get(electronAliceSafetyResolvePermission)
    expect(callTool).toBeTypeOf('function')
    expect(resolvePermission).toBeTypeOf('function')

    const deniedPending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/outside/denied-and-continue.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    const request = getSafetyRequests()[0]
    await resolvePermission!({
      token: request.token,
      requestId: request.requestId,
      allow: false,
      reason: 'user-denied',
    })

    const deniedResult = await deniedPending
    expect(deniedResult.isError).toBe(true)
    expect(deniedResult.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(manager.callTool).not.toBeCalled()

    contextEmitMock.mockReset()
    const safeResult = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/recovered.txt',
      },
    })
    expect(safeResult.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
    expect(getSafetyRequests()).toHaveLength(0)
  })

  it('returns structured timeout denial when permission decision expires', async () => {
    vi.useFakeTimers()
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/outside/timeout.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_DENIED')
    expect(parseToolErrorJson(result)).toEqual(expect.objectContaining({
      status: 'error',
      code: 'ALICE_TOOL_DENIED',
    }))
    expect(String(result.errorMessage)).toContain('timed out')
    expect(manager.callTool).not.toBeCalled()
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      action: 'alice.safety.permission.timeout',
    }))
  })

  it('denies pending permission requests when kill switch is suspended', async () => {
    const { createMcpServersService } = await import('./index')
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/outside/blocked-by-kill-switch.txt',
      },
    })

    await vi.waitFor(() => {
      expect(getSafetyRequests()).toHaveLength(1)
    })

    emitKillSwitchState('SUSPENDED', 'manual')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_ABORTED')
    expect(manager.callTool).not.toBeCalled()
    expect(appendAuditLogMock).toBeCalledWith(expect.objectContaining({
      action: 'alice.safety.permission.denied',
      payload: expect.objectContaining({
        reason: 'kill-switch-suspended',
      }),
    }))
  })

  it('rejects new calls while suspended and allows again after resume', async () => {
    const { createMcpServersService } = await import('./index')
    let suspended = true
    isKillSwitchSuspendedMock.mockImplementation(() => suspended)
    const manager = createManager()

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const suspendedResult = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/blocked-while-suspended.txt',
      },
    })
    expect(suspendedResult.isError).toBe(true)
    expect(suspendedResult.errorCode).toBe('ALICE_TOOL_ABORTED')
    expect(manager.callTool).not.toBeCalled()
    expect(getSafetyRequests()).toHaveLength(0)

    suspended = false
    emitKillSwitchState('ACTIVE', 'resume')
    const resumedResult = await callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/allowed-after-resume.txt',
      },
    })
    expect(resumedResult.isError).not.toBe(true)
    expect(manager.callTool).toBeCalledTimes(1)
  })

  it('aborts in-flight tool call when kill switch flips to suspended', async () => {
    const { createMcpServersService } = await import('./index')
    let resolveCall!: (value: ElectronMcpCallToolResult) => void
    const manager = createManager({
      callTool: vi.fn(() => new Promise<ElectronMcpCallToolResult>((resolve) => {
        resolveCall = resolve
      })),
    })

    createMcpServersService({
      context: { emit: contextEmitMock } as any,
      manager,
    })

    const callTool = invokeHandlers.get(electronMcpCallTool)
    expect(callTool).toBeTypeOf('function')

    const pending = callTool!({
      name: 'filesystem::read_file',
      arguments: {
        path: '/tmp/documents/Alice_Workspace/notes.txt',
      },
    })

    await vi.waitFor(() => {
      expect(manager.callTool).toBeCalledTimes(1)
    })

    emitKillSwitchState('SUSPENDED', 'manual')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.errorCode).toBe('ALICE_TOOL_ABORTED')

    resolveCall({ ok: true, isError: false })
  })
})
