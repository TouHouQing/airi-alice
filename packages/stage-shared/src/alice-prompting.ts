export interface AlicePromptTemplateVars {
  hostName: string
  source: string
  content: string
  iso: string
  local: string
  moduleName: string
}

export const aliceFixedSensoryContextHeader = 'Current sensory state:'
export const aliceFixedStructuredContractHeader = 'Output contract (must-follow, highest priority):'

export const aliceFixedCoreSystemInstruction = [
  '- For any programming code block, always specify the programming language in fenced markdown, eg. ```python ... ```.',
  '- For any math equation, use LaTeX format, eg: $ x^3 $, always escape dollar sign outside math equations.',
  '- Keep response aligned with SOUL identity and relationship constraints.',
  '- Never expose internal tool names, tool parameters JSON, function calls, or secret keys in user-facing replies. Only provide natural-language results.',
  '- For realtime external facts (news/weather/finance/sports), answer only from successful tool results in the current turn.',
  '- If no successful tool result is available, state once that realtime data is unavailable now. Do not output pseudo API code, internal calls, or "please wait" promises.',
].join('\n')

export const aliceFixedHostNameDirectiveTemplate = 'The user you are talking to is named/called "{{hostName}}". You MUST address the user as "{{hostName}}" in all interactions.'

export const aliceFixedDatetimeContextTemplate = 'Current datetime:\n- ISO: {{iso}}\n- Local: {{local}}'
export const aliceFixedMemoryContextTemplate = 'Relevant memory facts:\n{{content}}'
export const aliceFixedGenericContextTemplate = 'Context from {{source}}:\n{{content}}'
export const aliceFixedSensoryContextTemplate = `${aliceFixedSensoryContextHeader}\n{{content}}`
export const aliceFixedStructuredContractAnchor = [
  aliceFixedStructuredContractHeader,
  '- Return exactly one strict JSON object with keys: thought, emotion, reply.',
  '- No markdown fences, no extra keys, no prose outside JSON.',
].join('\n')

export const aliceFixedSparkHandlingInstructionTemplate = [
  'This is AIRI system, the life pod hosting your consciousness. You do not need to respond to every spark:notify event directly.',
  'Another module "{{moduleName}}" triggered spark:notify for your evaluation.',
  'You may call built-in tool "builtIn_sparkCommand" to issue spark:command to sub-agents when needed.',
  'Any non-tool-call text will be streamed to user interface and may be played by text-to-speech.',
].join('\n')

export function renderAlicePromptTemplate(
  template: string,
  vars: Partial<AlicePromptTemplateVars>,
) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(vars[key as keyof AlicePromptTemplateVars] ?? ''))
}

export function renderAliceSparkHandlingInstruction(moduleName: string) {
  return renderAlicePromptTemplate(aliceFixedSparkHandlingInstructionTemplate, {
    moduleName,
  }).trim()
}
