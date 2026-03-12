import { describe, expect, it } from 'vitest'

import { calibrateSentimentConfidence, normalizeStructuredOutput, parseLastActEmotion, validateStructuredContract } from './alice-structured-output'

describe('alice structured output', () => {
  it('parses last ACT emotion', () => {
    const emotion = parseLastActEmotion('hello <|ACT:{"emotion":"happy"}|>world <|ACT:{"emotion":"sad"}|>!')
    expect(emotion).toBe('sad')
  })

  it('prefers strict json payload when available', () => {
    const result = normalizeStructuredOutput({
      fullText: JSON.stringify({
        thought: 'internal-json',
        emotion: 'happy',
        reply: 'json reply',
        userSentimentScore: 0.65,
        sentimentConfidenceRaw: 0.88,
      }),
      thought: 'fallback-thought',
      reply: 'fallback-reply',
    })

    expect(result.parsePath).toBe('json')
    expect(result.thought).toBe('internal-json')
    expect(result.reply).toBe('json reply')
    expect(result.emotion).toBe('happy')
    expect(result.format).toBe('epoch1-v1')
  })

  it('uses linear repair path for noisy wrapped json', () => {
    const result = normalizeStructuredOutput({
      fullText: 'prefix noise >>> {"thought":"repair","emotion":"curious","reply":"ok"} <<< suffix noise',
      thought: 'fallback-thought',
      reply: 'fallback-reply',
    })

    expect(result.parsePath).toBe('repair-json')
    expect(result.reply).toBe('ok')
    expect(result.emotion).toBe('curious')
    expect(result.repairTimedOut).toBe(false)
  })

  it('falls back safely for oversized malformed text', () => {
    const oversized = `{${'x'.repeat(40_000)}}`
    const result = normalizeStructuredOutput({
      fullText: oversized,
      thought: 'fallback-thought',
      reply: 'fallback-reply',
    })

    expect(result.parsePath).toBe('fallback')
    expect(result.format).toBe('fallback-v1')
    expect(result.reply).toBe('fallback-reply')
    expect(result.repairTimedOut).toBe(true)
  })

  it('calibrates confidence with heuristic cap', () => {
    const result = normalizeStructuredOutput({
      fullText: '<|ACT:{"emotion":"happy"}|>Thanks a lot!',
      thought: 'internal',
      reply: 'Thanks a lot!',
      sentimentConfidenceRaw: 0.99,
      previousEmotion: 'neutral',
      extractorAgreement: 0.6,
    })

    expect(result.sentimentConfidenceRaw).toBe(0.99)
    expect(result.sentimentConfidence).toBeLessThanOrEqual(result.sentimentConfidenceRaw!)
    expect(result.sentimentConfidence).toBeGreaterThan(0)
  })

  it('falls back to heuristic confidence when raw is missing', () => {
    const result = normalizeStructuredOutput({
      fullText: '<|ACT:{"emotion":"neutral"}|>我会继续优化。',
      thought: 'internal',
      reply: '我会继续优化。',
      previousEmotion: 'happy',
    })

    expect(result.sentimentConfidenceRaw).toBeUndefined()
    expect(result.sentimentConfidence).toBeGreaterThan(0)
  })

  it('caps overconfident raw score with calibrator', () => {
    const calibrated = calibrateSentimentConfidence({
      rawConfidence: 1,
      lexicalStrength: 0.1,
      emotionCoherence: 0.55,
      extractorAgreement: 0.2,
    })
    expect(calibrated).toBeLessThan(1)
    expect(calibrated).toBeGreaterThan(0)
  })

  it('marks non-whitelisted emotion as invalid', () => {
    const issues = validateStructuredContract({
      thought: 'I reviewed obedience/liveliness/sensibility and will stay stable.',
      emotion: 'cheerful',
      reply: '我今天很开心！',
    }, {
      obedience: 0.05,
      liveliness: 0.05,
      sensibility: 0.05,
    })

    expect(issues.map(issue => issue.code)).toContain('emotion-not-whitelisted')
  })

  it('blocks high-arousal emotion/reply when liveliness is very low', () => {
    const issues = validateStructuredContract({
      thought: 'obedience=0.05 liveliness=0.05 sensibility=0.05, I should stay cold and concise.',
      emotion: 'happy',
      reply: '我今天的心情非常愉快！😊',
    }, {
      obedience: 0.05,
      liveliness: 0.05,
      sensibility: 0.05,
    })

    expect(issues.map(issue => issue.code)).toContain('low-liveliness-high-arousal-emotion')
    expect(issues.map(issue => issue.code)).toContain('low-liveliness-high-arousal-reply')
  })
})
