import { describe, expect, it } from 'vitest'

import { computePersonalityDelta } from './alice-personality'

describe('alice epoch1 personality drift', () => {
  it('keeps delta at zero in deadzone', () => {
    expect(computePersonalityDelta(0.24, 1)).toBe(0)
    expect(computePersonalityDelta(-0.24, 1)).toBe(0)
  })

  it('does not drift over 100 neutral turns in deadzone', () => {
    let drift = 0
    for (let index = 0; index < 100; index += 1) {
      drift += computePersonalityDelta(0.1, 0.8)
    }
    expect(drift).toBe(0)
  })

  it('applies delta outside deadzone', () => {
    expect(computePersonalityDelta(0.25, 1)).toBeGreaterThan(0)
    expect(computePersonalityDelta(-0.26, 1)).toBeLessThan(0)
  })

  it('respects delta clamp', () => {
    expect(computePersonalityDelta(1, 1)).toBeLessThanOrEqual(0.02)
    expect(computePersonalityDelta(-1, 1)).toBeGreaterThanOrEqual(-0.02)
  })
})
