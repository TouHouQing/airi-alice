const sentimentLexiconPositive = [
  '谢谢',
  '感谢',
  '喜欢',
  '开心',
  '高兴',
  'great',
  'good',
  'thanks',
  'love',
]

const sentimentLexiconNegative = [
  '讨厌',
  '烦',
  '难过',
  '崩溃',
  '生气',
  '糟糕',
  'bad',
  'angry',
  'hate',
  'sad',
]

const emotionToSentiment: Record<string, number> = {
  happy: 0.8,
  neutral: 0,
  concerned: -0.4,
  apologetic: -0.35,
  tired: -0.2,
  sad: -0.7,
  angry: -0.8,
  surprised: 0.2,
  curious: 0.1,
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value))
    return min
  return Math.min(max, Math.max(min, value))
}

interface ActPayload {
  emotion?: unknown
  userSentimentScore?: unknown
  user_sentiment_score?: unknown
  sentimentConfidenceRaw?: unknown
  sentiment_confidence_raw?: unknown
  sentimentConfidence?: unknown
  sentiment_confidence?: unknown
  confidence?: unknown
  [key: string]: unknown
}

function parseLastActPayload(content: string): ActPayload | null {
  const matches = [...content.matchAll(/<\|ACT\s*(?::\s*)?(\{[\s\S]*?\})\|>/gi)]
  if (matches.length === 0)
    return null

  const lastPayloadText = matches[matches.length - 1]?.[1]
  if (!lastPayloadText)
    return null

  try {
    const payload = JSON.parse(lastPayloadText) as unknown
    if (payload && typeof payload === 'object' && !Array.isArray(payload))
      return payload as ActPayload
  }
  catch {
    return null
  }

  return null
}

function getNumeric(payload: ActPayload | null, keys: string[]) {
  if (!payload)
    return undefined

  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value))
      return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed))
        return parsed
    }
  }

  return undefined
}

export function parseLastActEmotion(content: string) {
  const payload = parseLastActPayload(content)
  if (!payload)
    return 'neutral'

  if (typeof payload.emotion === 'string')
    return payload.emotion.trim().toLowerCase() || 'neutral'
  if (payload.emotion && typeof payload.emotion === 'object' && 'name' in payload.emotion) {
    const name = (payload.emotion as { name?: unknown }).name
    if (typeof name === 'string' && name.trim())
      return name.trim().toLowerCase()
  }

  return 'neutral'
}

function computeConfidenceCap(input: {
  lexicalStrength: number
  emotionCoherence: number
  extractorAgreement: number
}) {
  const lexicalStrength = clamp(input.lexicalStrength, 0, 1)
  const emotionCoherence = clamp(input.emotionCoherence, 0, 1)
  const extractorAgreement = clamp(input.extractorAgreement, 0, 1)

  return clamp(
    0.45
    + lexicalStrength * 0.3
    + (emotionCoherence - 0.5) * 0.25
    + (extractorAgreement - 0.5) * 0.2,
    0.2,
    0.92,
  )
}

export function calibrateSentimentConfidence(input: {
  rawConfidence?: number
  lexicalStrength: number
  emotionCoherence: number
  extractorAgreement: number
}) {
  const cap = computeConfidenceCap({
    lexicalStrength: input.lexicalStrength,
    emotionCoherence: input.emotionCoherence,
    extractorAgreement: input.extractorAgreement,
  })

  if (typeof input.rawConfidence === 'number' && Number.isFinite(input.rawConfidence)) {
    const raw = clamp(input.rawConfidence, 0, 1)
    return clamp(Math.min(raw, cap), 0, 1)
  }

  return cap
}

export function estimateLexicalSentiment(text: string) {
  const lower = text.toLowerCase()
  let positive = 0
  let negative = 0

  for (const token of sentimentLexiconPositive) {
    if (lower.includes(token))
      positive += 1
  }
  for (const token of sentimentLexiconNegative) {
    if (lower.includes(token))
      negative += 1
  }

  if (positive === 0 && negative === 0)
    return 0

  return clamp((positive - negative) / (positive + negative), -1, 1)
}

function emotionToScore(emotion: string) {
  return emotionToSentiment[emotion] ?? 0
}

export interface StructuredOutputInput {
  fullText: string
  reply: string
  thought: string
  previousEmotion?: string
  userSentimentScore?: number
  sentimentConfidenceRaw?: number
  extractorAgreement?: number
}

export interface StructuredOutputResult {
  thought: string
  emotion: string
  reply: string
  userSentimentScore: number
  sentimentConfidenceRaw?: number
  sentimentConfidence: number
  format: 'epoch1-v1' | 'fallback-v1'
}

export function normalizeStructuredOutput(input: StructuredOutputInput): StructuredOutputResult {
  const actPayload = parseLastActPayload(input.fullText)
  const emotion = parseLastActEmotion(input.fullText)
  const emotionScore = emotionToScore(emotion)
  const lexicalScore = estimateLexicalSentiment(input.reply)
  const modelSentiment = getNumeric(actPayload, ['userSentimentScore', 'user_sentiment_score'])
  const scoreInput = input.userSentimentScore ?? modelSentiment
  const userSentimentScore = clamp(
    typeof scoreInput === 'number' && Number.isFinite(scoreInput)
      ? scoreInput
      : emotionScore * 0.7 + lexicalScore * 0.3,
    -1,
    1,
  )

  const rawInput = input.sentimentConfidenceRaw
    ?? getNumeric(actPayload, [
      'sentimentConfidenceRaw',
      'sentiment_confidence_raw',
      'sentimentConfidence',
      'sentiment_confidence',
      'confidence',
    ])
  const lexicalStrength = Math.abs(lexicalScore)
  const coherence = input.previousEmotion
    ? (input.previousEmotion === emotion ? 1 : 0.55)
    : 0.7
  const extractorAgreement = clamp(input.extractorAgreement ?? 0.8, 0, 1)
  const calibrated = calibrateSentimentConfidence({
    rawConfidence: rawInput,
    lexicalStrength,
    emotionCoherence: coherence,
    extractorAgreement,
  })

  return {
    thought: input.thought.trim(),
    emotion,
    reply: input.reply.trim(),
    userSentimentScore,
    sentimentConfidenceRaw: typeof rawInput === 'number' && Number.isFinite(rawInput)
      ? clamp(rawInput, 0, 1)
      : undefined,
    sentimentConfidence: calibrated,
    format: 'epoch1-v1',
  }
}
