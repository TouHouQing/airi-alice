import type {
  AliceAuditLogInput,
  AliceMemoryFact,
  AliceMemoryFactInput,
  AliceMemoryLegacySnapshot,
  AliceMemoryMigrationResult,
  AliceMemorySource,
  AliceMemoryStats,
} from '../../../shared/eventa'

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import sqlite3 from 'sqlite3'

const dayMs = 24 * 60 * 60 * 1000
const legacyMigrationMarker = 'legacy_memory_migrated_v1'
const memoryLastPrunedAtKey = 'memory_last_pruned_at'

interface SqliteStatementResult {
  changes: number
  lastID: number
}

interface MetaRow {
  value: string
}

interface CountRow {
  total: number
}

interface JournalModeRow {
  journal_mode: string
}

interface DbMemoryFactRow {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  source: AliceMemorySource
  dedupe_key: string
  created_at: number
  updated_at: number
  last_access_at: number | null
  access_count: number
}

function clamp01(value: number) {
  if (Number.isNaN(value))
    return 0
  return Math.min(1, Math.max(0, value))
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

function computePruneScore(fact: AliceMemoryFact, currentTs: number) {
  const ageDays = Math.max(0, (currentTs - fact.updatedAt) / dayMs)
  const timeDecay = Math.min(1, ageDays / 30)
  const accessFrequencyNorm = Math.min(1, fact.accessCount / 12)
  const confidenceNorm = clamp01(fact.confidence)
  return timeDecay * (1 - accessFrequencyNorm) * (1 - confidenceNorm)
}

function mapFactRow(row: DbMemoryFactRow): AliceMemoryFact {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: clamp01(row.confidence),
    source: row.source,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessAt: typeof row.last_access_at === 'number' ? row.last_access_at : null,
    accessCount: Math.max(0, Math.floor(row.access_count)),
  }
}

function now() {
  return Date.now()
}

function openDatabase(filepath: string) {
  return new Promise<sqlite3.Database>((resolve, reject) => {
    let database: sqlite3.Database | null = null
    const onOpen = (error: Error | null) => {
      if (error) {
        reject(error)
        return
      }
      if (database) {
        resolve(database)
        return
      }

      queueMicrotask(() => {
        if (database) {
          resolve(database)
          return
        }
        reject(new Error('sqlite3 opened without database handle'))
      })
    }

    database = new sqlite3.Database(filepath, onOpen)
  })
}

function run(database: sqlite3.Database, sql: string, params: unknown[] = []) {
  return new Promise<SqliteStatementResult>((resolve, reject) => {
    database.run(sql, params, function callback(error) {
      if (error) {
        reject(error)
        return
      }

      resolve({
        changes: this.changes,
        lastID: this.lastID,
      })
    })
  })
}

function get<T>(database: sqlite3.Database, sql: string, params: unknown[] = []) {
  return new Promise<T | undefined>((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) {
        reject(error)
        return
      }

      resolve(row as T | undefined)
    })
  })
}

function all<T>(database: sqlite3.Database, sql: string, params: unknown[] = []) {
  return new Promise<T[]>((resolve, reject) => {
    database.all(sql, params, (error, rows) => {
      if (error) {
        reject(error)
        return
      }

      resolve((rows ?? []) as T[])
    })
  })
}

function close(database: sqlite3.Database) {
  return new Promise<void>((resolve, reject) => {
    database.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function runInTransaction<T>(database: sqlite3.Database, task: () => Promise<T>) {
  await run(database, 'BEGIN IMMEDIATE')
  try {
    const result = await task()
    await run(database, 'COMMIT')
    return result
  }
  catch (error) {
    await run(database, 'ROLLBACK').catch(() => {})
    throw error
  }
}

export interface AliceDbService {
  dbPath: string
  close: () => Promise<void>
  appendAuditLog: (input: AliceAuditLogInput) => Promise<void>
  getMemoryStats: () => Promise<AliceMemoryStats>
  upsertMemoryFacts: (facts: AliceMemoryFactInput[], source: AliceMemorySource) => Promise<void>
  retrieveMemoryFacts: (query: string, limit?: number) => Promise<AliceMemoryFact[]>
  runMemoryPrune: () => Promise<AliceMemoryStats>
  importLegacyMemory: (snapshot: AliceMemoryLegacySnapshot) => Promise<AliceMemoryMigrationResult>
  overrideMemoryStats: (next: AliceMemoryStats) => Promise<AliceMemoryStats>
  getJournalMode: () => Promise<string>
}

export async function setupAliceDb(userDataPath: string): Promise<AliceDbService> {
  const rootDir = join(userDataPath, 'alice')
  const dbPath = join(rootDir, 'alice.db')
  await mkdir(rootDir, { recursive: true })

  const database = await openDatabase(dbPath)

  let writeQueue = Promise.resolve<unknown>(undefined)

  const enqueueWrite = async <T>(task: () => Promise<T>) => {
    const next = writeQueue.then(task, task)
    writeQueue = next.then(() => undefined, () => undefined)
    return await next
  }

  async function initializeSchema() {
    await run(database, 'PRAGMA journal_mode = WAL;')
    await run(database, 'PRAGMA busy_timeout = 2000;')
    await run(database, 'PRAGMA foreign_keys = ON;')
    await run(database, 'PRAGMA synchronous = NORMAL;')

    await run(database, `
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_access_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      )
    `)

    await run(database, 'CREATE INDEX IF NOT EXISTS idx_memory_facts_updated_at ON memory_facts(updated_at DESC)')
    await run(database, 'CREATE INDEX IF NOT EXISTS idx_memory_facts_last_access_at ON memory_facts(last_access_at DESC)')

    await run(database, `
      CREATE TABLE IF NOT EXISTS memory_archive (
        id TEXT PRIMARY KEY,
        original_id TEXT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_access_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER NOT NULL
      )
    `)

    await run(database, 'CREATE INDEX IF NOT EXISTS idx_memory_archive_archived_at ON memory_archive(archived_at DESC)')

    await run(database, `
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_text TEXT,
        assistant_text TEXT,
        structured_json TEXT,
        created_at INTEGER NOT NULL
      )
    `)

    await run(database, 'CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_created_at ON conversation_turns(session_id, created_at DESC)')

    await run(database, `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      )
    `)

    await run(database, 'CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)')

    await run(database, `
      CREATE TABLE IF NOT EXISTS alice_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  async function upsertMeta(key: string, value: string) {
    const ts = now()
    await run(
      database,
      `
      INSERT INTO alice_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      [key, value, ts],
    )
  }

  async function getMetaValue(key: string) {
    const row = await get<MetaRow>(database, 'SELECT value FROM alice_meta WHERE key = ? LIMIT 1', [key])
    return row?.value
  }

  async function getLastPrunedAt() {
    const value = await getMetaValue(memoryLastPrunedAtKey)
    if (!value)
      return null

    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed))
      return null
    return parsed
  }

  async function getMemoryStats() {
    const [totalRow, archivedRow, lastPrunedAt] = await Promise.all([
      get<CountRow>(database, 'SELECT COUNT(1) AS total FROM memory_facts'),
      get<CountRow>(database, 'SELECT COUNT(1) AS total FROM memory_archive'),
      getLastPrunedAt(),
    ])

    const active = totalRow?.total ?? 0
    const archived = archivedRow?.total ?? 0
    return {
      total: active + archived,
      active,
      archived,
      lastPrunedAt,
    } satisfies AliceMemoryStats
  }

  async function appendAuditLog(input: AliceAuditLogInput) {
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now()
    const level = input.level ?? 'info'
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null

    await enqueueWrite(async () => {
      await run(
        database,
        `
        INSERT INTO audit_logs (id, level, category, action, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          level,
          input.category,
          input.action,
          input.message,
          payloadJson,
          createdAt,
        ],
      )
    })
  }

  async function upsertMemoryFacts(facts: AliceMemoryFactInput[], source: AliceMemorySource) {
    if (facts.length === 0)
      return

    const normalizedFacts = facts
      .map((fact) => {
        const subject = fact.subject.trim()
        const predicate = fact.predicate.trim()
        const object = fact.object.trim()
        if (!subject || !predicate || !object)
          return null

        return {
          id: randomUUID(),
          subject,
          predicate,
          object,
          confidence: clamp01(fact.confidence),
          source,
          dedupeKey: buildDedupeKey(subject, predicate, object),
          createdAt: now(),
          updatedAt: now(),
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))

    if (normalizedFacts.length === 0)
      return

    await enqueueWrite(async () => {
      await runInTransaction(database, async () => {
        for (const fact of normalizedFacts) {
          await run(
            database,
            `
            INSERT INTO memory_facts (
              id,
              subject,
              predicate,
              object,
              confidence,
              source,
              dedupe_key,
              created_at,
              updated_at,
              last_access_at,
              access_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key)
            DO UPDATE SET
              confidence = MAX(memory_facts.confidence, excluded.confidence),
              source = excluded.source,
              updated_at = excluded.updated_at
            `,
            [
              fact.id,
              fact.subject,
              fact.predicate,
              fact.object,
              fact.confidence,
              fact.source,
              fact.dedupeKey,
              fact.createdAt,
              fact.updatedAt,
              null,
              0,
            ],
          )
        }
      })
    })
  }

  async function retrieveMemoryFacts(query: string, limit = 6) {
    const normalizedQuery = query.trim()
    if (!normalizedQuery)
      return []

    const rows = await all<DbMemoryFactRow>(database, 'SELECT * FROM memory_facts')
    if (rows.length === 0)
      return []

    const facts = rows.map(mapFactRow)
    const queryTokens = tokenize(normalizedQuery)
    const currentTs = now()
    const ranked = facts
      .map(fact => ({
        fact,
        score: scoreFact(queryTokens, fact, currentTs),
      }))
      .filter(item => item.score > 0.01)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit))

    if (ranked.length === 0)
      return []

    await enqueueWrite(async () => {
      await runInTransaction(database, async () => {
        for (const item of ranked) {
          await run(
            database,
            `
            UPDATE memory_facts
            SET access_count = access_count + 1,
                last_access_at = ?
            WHERE id = ?
            `,
            [currentTs, item.fact.id],
          )
        }
      })
    })

    return ranked.map(item => item.fact)
  }

  async function runMemoryPrune() {
    const thresholdArchive = 0.72
    const thresholdDelete = 0.92
    const maxArchiveRetentionDays = 30
    const currentTs = now()

    const facts = (await all<DbMemoryFactRow>(database, 'SELECT * FROM memory_facts')).map(mapFactRow)

    const keepFacts: AliceMemoryFact[] = []
    const archiveFacts: AliceMemoryFact[] = []
    const deleteIds: string[] = []

    for (const fact of facts) {
      const score = computePruneScore(fact, currentTs)
      const daysSinceAccess = fact.lastAccessAt == null
        ? Number.POSITIVE_INFINITY
        : (currentTs - fact.lastAccessAt) / dayMs

      if (score >= thresholdDelete && daysSinceAccess >= 30) {
        deleteIds.push(fact.id)
        continue
      }

      if (score >= thresholdArchive && daysSinceAccess >= 14) {
        archiveFacts.push(fact)
        continue
      }

      keepFacts.push(fact)
    }

    await enqueueWrite(async () => {
      await runInTransaction(database, async () => {
        for (const fact of archiveFacts) {
          await run(
            database,
            `
            INSERT INTO memory_archive (
              id,
              original_id,
              subject,
              predicate,
              object,
              confidence,
              source,
              dedupe_key,
              created_at,
              updated_at,
              last_access_at,
              access_count,
              archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              randomUUID(),
              fact.id,
              fact.subject,
              fact.predicate,
              fact.object,
              fact.confidence,
              fact.source,
              fact.dedupeKey,
              fact.createdAt,
              fact.updatedAt,
              fact.lastAccessAt,
              fact.accessCount,
              currentTs,
            ],
          )
          deleteIds.push(fact.id)
        }

        if (deleteIds.length > 0) {
          const placeholders = deleteIds.map(() => '?').join(',')
          await run(database, `DELETE FROM memory_facts WHERE id IN (${placeholders})`, deleteIds)
        }

        const archiveRetentionLimit = currentTs - maxArchiveRetentionDays * dayMs
        await run(database, 'DELETE FROM memory_archive WHERE archived_at < ?', [archiveRetentionLimit])

        await upsertMeta(memoryLastPrunedAtKey, String(currentTs))
      })
    })

    await appendAuditLog({
      level: 'notice',
      category: 'memory',
      action: 'prune',
      message: 'Memory pruning completed.',
      payload: {
        kept: keepFacts.length,
        archived: archiveFacts.length,
        deleted: deleteIds.length,
      },
    })

    return await getMemoryStats()
  }

  async function importLegacyMemory(snapshot: AliceMemoryLegacySnapshot): Promise<AliceMemoryMigrationResult> {
    const currentTs = now()
    const marker = await getMetaValue(legacyMigrationMarker)
    if (marker) {
      return {
        migrated: false,
        importedFacts: 0,
        importedArchive: 0,
        marker,
      }
    }

    const legacyFacts = Array.isArray(snapshot.facts) ? snapshot.facts : []
    const legacyArchive = Array.isArray(snapshot.archive) ? snapshot.archive : []

    const importedFacts = legacyFacts.length
    const importedArchive = legacyArchive.length

    await enqueueWrite(async () => {
      await runInTransaction(database, async () => {
        for (const fact of legacyFacts) {
          const subject = fact.subject?.trim()
          const predicate = fact.predicate?.trim()
          const object = fact.object?.trim()
          if (!subject || !predicate || !object)
            continue

          const dedupeKey = fact.dedupeKey?.trim() || buildDedupeKey(subject, predicate, object)
          await run(
            database,
            `
            INSERT INTO memory_facts (
              id,
              subject,
              predicate,
              object,
              confidence,
              source,
              dedupe_key,
              created_at,
              updated_at,
              last_access_at,
              access_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key)
            DO UPDATE SET
              confidence = MAX(memory_facts.confidence, excluded.confidence),
              source = excluded.source,
              updated_at = excluded.updated_at
            `,
            [
              fact.id || randomUUID(),
              subject,
              predicate,
              object,
              clamp01(fact.confidence),
              fact.source,
              dedupeKey,
              fact.createdAt,
              fact.updatedAt,
              fact.lastAccessAt,
              Math.max(0, Math.floor(fact.accessCount)),
            ],
          )
        }

        for (const item of legacyArchive) {
          const subject = item.subject?.trim()
          const predicate = item.predicate?.trim()
          const object = item.object?.trim()
          if (!subject || !predicate || !object)
            continue

          await run(
            database,
            `
            INSERT INTO memory_archive (
              id,
              original_id,
              subject,
              predicate,
              object,
              confidence,
              source,
              dedupe_key,
              created_at,
              updated_at,
              last_access_at,
              access_count,
              archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              item.id || randomUUID(),
              item.id || null,
              subject,
              predicate,
              object,
              clamp01(item.confidence),
              item.source,
              item.dedupeKey,
              item.createdAt,
              item.updatedAt,
              item.lastAccessAt,
              Math.max(0, Math.floor(item.accessCount)),
              item.archivedAt,
            ],
          )
        }

        if (typeof snapshot.lastPrunedAt === 'number' && Number.isFinite(snapshot.lastPrunedAt)) {
          await upsertMeta(memoryLastPrunedAtKey, String(snapshot.lastPrunedAt))
        }

        await upsertMeta(legacyMigrationMarker, String(currentTs))
      })
    })

    await appendAuditLog({
      level: 'notice',
      category: 'memory',
      action: 'legacy-migration',
      message: 'Imported legacy memory snapshot into SQLite.',
      payload: {
        importedFacts,
        importedArchive,
      },
    })

    return {
      migrated: true,
      importedFacts,
      importedArchive,
      marker: String(currentTs),
    }
  }

  async function overrideMemoryStats(next: AliceMemoryStats) {
    if (typeof next.lastPrunedAt === 'number' && Number.isFinite(next.lastPrunedAt)) {
      await enqueueWrite(async () => {
        await upsertMeta(memoryLastPrunedAtKey, String(next.lastPrunedAt))
      })
    }

    return await getMemoryStats()
  }

  async function getJournalMode() {
    const row = await get<JournalModeRow>(database, 'PRAGMA journal_mode;')
    return (row?.journal_mode || '').toLowerCase()
  }

  await initializeSchema()

  return {
    dbPath,
    close: async () => await close(database),
    appendAuditLog,
    getMemoryStats,
    upsertMemoryFacts,
    retrieveMemoryFacts,
    runMemoryPrune,
    importLegacyMemory,
    overrideMemoryStats,
    getJournalMode,
  }
}
