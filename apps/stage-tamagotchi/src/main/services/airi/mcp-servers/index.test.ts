import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import { isFallbackEligibleMcpError } from './index'

describe('mcp fallback error gate', () => {
  it('allows fallback only for tool name/params class errors', () => {
    expect(isFallbackEligibleMcpError(new McpError(ErrorCode.MethodNotFound, 'Tool not found'))).toBe(true)
    expect(isFallbackEligibleMcpError(new McpError(ErrorCode.InvalidParams, 'Invalid arguments'))).toBe(true)
  })

  it('rejects fallback for timeout/network/core runtime errors', () => {
    expect(isFallbackEligibleMcpError(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))).toBe(false)
    expect(isFallbackEligibleMcpError(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'))).toBe(false)
    expect(isFallbackEligibleMcpError(new McpError(ErrorCode.InternalError, 'internal error'))).toBe(false)
    expect(isFallbackEligibleMcpError(new Error('401 Unauthorized'))).toBe(false)
    expect(isFallbackEligibleMcpError(new Error('ECONNREFUSED upstream unavailable'))).toBe(false)
  })

  it('allows fallback for semantic tool-not-found style messages', () => {
    expect(isFallbackEligibleMcpError(new Error('Tool weather_get not found'))).toBe(true)
    expect(isFallbackEligibleMcpError(new Error('Input validation error: invalid arguments for tool get_weather'))).toBe(true)
  })
})
