export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
  requestId?: string
}

export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  toolResult?: unknown
  isError?: boolean
  ok?: boolean
  errorCode?: string
  errorMessage?: string
  durationMs?: number
}

export interface McpServerRuntimeStatus {
  name: string
  state: 'running' | 'stopped' | 'error'
  command: string
  args: string[]
  pid: number | null
  lastError?: string
}

export interface McpCapabilitiesSnapshot {
  path: string
  updatedAt: number
  servers: McpServerRuntimeStatus[]
  tools: McpToolDescriptor[]
  healthyServers: number
}

interface McpToolBridge {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
  getCapabilitiesSnapshot?: () => Promise<McpCapabilitiesSnapshot>
}

let bridge: McpToolBridge | undefined

export function setMcpToolBridge(nextBridge: McpToolBridge) {
  bridge = nextBridge
}

export function clearMcpToolBridge() {
  bridge = undefined
}

export function getMcpToolBridge(): McpToolBridge {
  if (!bridge) {
    throw new Error('MCP tool bridge is not available in this runtime.')
  }

  return bridge
}

export async function getMcpCapabilitiesSnapshot(): Promise<McpCapabilitiesSnapshot> {
  const activeBridge = getMcpToolBridge()
  if (activeBridge.getCapabilitiesSnapshot) {
    return await activeBridge.getCapabilitiesSnapshot()
  }

  const tools = await activeBridge.listTools()
  return {
    path: '',
    updatedAt: Date.now(),
    servers: [],
    tools,
    healthyServers: 0,
  }
}
