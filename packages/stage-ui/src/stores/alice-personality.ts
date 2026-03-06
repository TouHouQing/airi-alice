function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value))
    return min
  return Math.min(max, Math.max(min, value))
}

export function computePersonalityDelta(score: number, confidence: number) {
  const boundedScore = clamp(score, -1, 1)
  const boundedConfidence = clamp(confidence, 0, 1)
  if (Math.abs(boundedScore) < 0.25)
    return 0
  return clamp(boundedScore * boundedConfidence * 0.02, -0.02, 0.02)
}
