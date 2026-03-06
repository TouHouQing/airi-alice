import type { AliceMemoryStats } from './alice-bridge'

import { storage } from '../database/storage'

const memoryFactsKey = 'local:alice/memory/facts:v1'
const memoryArchiveKey = 'local:alice/memory/archive:v1'
const memoryMetaKey = 'local:alice/memory/meta:v1'

const dayMs = 24 * 60 * 60 * 1000

export type AliceMemorySource = 'rule' | 'async-llm'

export interface AliceMemoryFact {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  source: AliceMemorySource
  dedupeKey: string
  createdAt: number
  updatedAt: number
  lastAccessAt: number | null
  accessCount: number
}

export interface AliceMemoryArchiveRecord extends AliceMemoryFact {
  archivedAt: number
}

interface AliceMemoryMeta {
  lastPrunedAt: number | null
}

export interface AliceMemoryExtractInput {
  userText: string
  replyText?: string
}

function clamp01(value: number) {
  if (Number.isNaN(value))
    return 0
  return Math.min(1, Math.max(0, value))
}

function now() {
  return Date.now()
}

function buildDedupeKey(subject: string, predicate: string, object: string) {
  return `${subject.trim().toLowerCase()}|${predicate.trim().toLowerCase()}|${object.trim().toLowerCase()}`
}

function tokenize(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2),
  )
}

function scoreFact(queryTokens: Set<string>, fact: AliceMemoryFact, currentTs: number) {
  const factTokens = tokenize(`${fact.subject} ${fact.predicate} ${fact.object}`)
  if (factTokens.size === 0)
    return 0

  let overlap = 0
  for (const token of factTokens) {
    if (queryTokens.has(token))
      overlap += 1
  }

  const lexicalScore = overlap / factTokens.size
  const ageDays = Math.max(0, (currentTs - fact.updatedAt) / dayMs)
  const decay = Math.exp(-ageDays / 14)
  const accessBoost = Math.min(0.2, fact.accessCount / 50)

  return (lexicalScore * 0.5 + fact.confidence * 0.4 + accessBoost * 0.1) * decay
}

async function getFacts() {
  return await storage.getItemRaw<AliceMemoryFact[]>(memoryFactsKey) ?? []
}

async function saveFacts(facts: AliceMemoryFact[]) {
  await storage.setItemRaw(memoryFactsKey, facts)
}

async function getArchive() {
  return await storage.getItemRaw<AliceMemoryArchiveRecord[]>(memoryArchiveKey) ?? []
}

async function saveArchive(records: AliceMemoryArchiveRecord[]) {
  await storage.setItemRaw(memoryArchiveKey, records)
}

async function getMeta() {
  return await storage.getItemRaw<AliceMemoryMeta>(memoryMetaKey) ?? { lastPrunedAt: null }
}

async function saveMeta(meta: AliceMemoryMeta) {
  await storage.setItemRaw(memoryMetaKey, meta)
}

export function extractRuleFacts(input: AliceMemoryExtractInput): Array<Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object' | 'confidence'>> {
  const text = input.userText.trim()
  if (!text)
    return []

  const results: Array<Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object' | 'confidence'>> = []

  const likes = /我(?:很)?喜欢(.{1,24})/.exec(text)
  if (likes?.[1]) {
    results.push({
      subject: 'user',
      predicate: 'likes',
      object: likes[1].trim(),
      confidence: 0.74,
    })
  }

  const dislikes = /我(?:很)?不喜欢(.{1,24})/.exec(text)
  if (dislikes?.[1]) {
    results.push({
      subject: 'user',
      predicate: 'dislikes',
      object: dislikes[1].trim(),
      confidence: 0.8,
    })
  }

  const plans = /(?:明天|下周|周五|今天)\s*(?:要|得|需要)?\s*(.{1,32})/.exec(text)
  if (plans?.[1]) {
    results.push({
      subject: 'user',
      predicate: 'plan',
      object: plans[1].trim(),
      confidence: 0.66,
    })
  }

  return results
}

export async function upsertFacts(
  facts: Array<Pick<AliceMemoryFact, 'subject' | 'predicate' | 'object' | 'confidence'>>,
  source: AliceMemorySource,
) {
  if (facts.length === 0)
    return

  const current = await getFacts()
  const next = [...current]
  const currentTs = now()

  for (const fact of facts) {
    const dedupeKey = buildDedupeKey(fact.subject, fact.predicate, fact.object)
    const existingIndex = next.findIndex(item => item.dedupeKey === dedupeKey)

    if (existingIndex >= 0) {
      const existing = next[existingIndex]
      next[existingIndex] = {
        ...existing,
        confidence: clamp01(Math.max(existing.confidence, fact.confidence)),
        source,
        updatedAt: currentTs,
      }
      continue
    }

    next.push({
      id: `${currentTs}-${Math.random().toString(36).slice(2, 10)}`,
      subject: fact.subject.trim(),
      predicate: fact.predicate.trim(),
      object: fact.object.trim(),
      confidence: clamp01(fact.confidence),
      source,
      dedupeKey,
      createdAt: currentTs,
      updatedAt: currentTs,
      lastAccessAt: null,
      accessCount: 0,
    })
  }

  await saveFacts(next)
}

export async function retrieveFacts(query: string, limit = 6) {
  const facts = await getFacts()
  if (!query.trim() || facts.length === 0)
    return []

  const currentTs = now()
  const queryTokens = tokenize(query)
  const ranked = facts
    .map(fact => ({ fact, score: scoreFact(queryTokens, fact, currentTs) }))
    .filter(item => item.score > 0.01)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit))

  if (ranked.length === 0)
    return []

  const rankedMap = new Map(ranked.map(item => [item.fact.id, item.score]))
  const touchedFacts = facts.map((fact) => {
    if (!rankedMap.has(fact.id))
      return fact
    return {
      ...fact,
      accessCount: fact.accessCount + 1,
      lastAccessAt: currentTs,
    }
  })

  await saveFacts(touchedFacts)
  return ranked.map(item => item.fact)
}

function computePruneScore(fact: AliceMemoryFact, currentTs: number) {
  const ageDays = Math.max(0, (currentTs - fact.updatedAt) / dayMs)
  const timeDecay = Math.min(1, ageDays / 30)
  const accessFrequencyNorm = Math.min(1, fact.accessCount / 12)
  const confidenceNorm = clamp01(fact.confidence)
  return timeDecay * (1 - accessFrequencyNorm) * (1 - confidenceNorm)
}

export async function runMemoryPrune() {
  const currentTs = now()
  const thresholdArchive = 0.72
  const thresholdDelete = 0.92
  const maxArchiveRetentionDays = 30

  const facts = await getFacts()
  const archive = await getArchive()

  const keepFacts: AliceMemoryFact[] = []
  const archivedFacts: AliceMemoryArchiveRecord[] = [...archive]

  for (const fact of facts) {
    const score = computePruneScore(fact, currentTs)
    const daysSinceAccess = fact.lastAccessAt == null ? Number.POSITIVE_INFINITY : (currentTs - fact.lastAccessAt) / dayMs

    if (score >= thresholdDelete && daysSinceAccess >= 30) {
      continue
    }

    if (score >= thresholdArchive && daysSinceAccess >= 14) {
      archivedFacts.push({
        ...fact,
        archivedAt: currentTs,
      })
      continue
    }

    keepFacts.push(fact)
  }

  const filteredArchive = archivedFacts.filter(record => ((currentTs - record.archivedAt) / dayMs) <= maxArchiveRetentionDays)

  await saveFacts(keepFacts)
  await saveArchive(filteredArchive)
  await saveMeta({ lastPrunedAt: currentTs })

  return await getMemoryStats()
}

export async function getMemoryStats(): Promise<AliceMemoryStats> {
  const [facts, archive, meta] = await Promise.all([
    getFacts(),
    getArchive(),
    getMeta(),
  ])

  return {
    total: facts.length + archive.length,
    active: facts.length,
    archived: archive.length,
    lastPrunedAt: meta.lastPrunedAt ?? null,
  }
}
