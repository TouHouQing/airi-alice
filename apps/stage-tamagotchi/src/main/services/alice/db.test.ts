import type { AliceMemoryLegacySnapshot } from '../../../shared/eventa'

import { describe, expect, it, vi } from 'vitest'

const runCalls: string[] = []
const metaState = new Map<string, string>()

class FakeSqliteDatabase {
  constructor(_path: string, callback: (error?: Error | null) => void) {
    callback(null)
  }

  run(sql: string, params: unknown[] | ((error: Error | null) => void), callback?: (this: { changes: number, lastID: number }, error: Error | null) => void) {
    const actualParams = Array.isArray(params) ? params : []
    const actualCallback = (typeof params === 'function' ? params : callback) as ((this: { changes: number, lastID: number }, error: Error | null) => void) | undefined
    runCalls.push(sql)

    if (sql.includes('INSERT INTO alice_meta')) {
      const [key, value] = actualParams as [string, string]
      if (typeof key === 'string' && typeof value === 'string') {
        metaState.set(key, value)
      }
    }

    actualCallback?.call({ changes: 1, lastID: 1 }, null)
    return this
  }

  get(sql: string, params: unknown[] | ((error: Error | null, row?: unknown) => void), callback?: (error: Error | null, row?: unknown) => void) {
    const actualParams = Array.isArray(params) ? params : []
    const actualCallback = (typeof params === 'function' ? params : callback) as ((error: Error | null, row?: unknown) => void) | undefined

    if (sql.includes('PRAGMA journal_mode')) {
      actualCallback?.(null, { journal_mode: 'wal' })
      return this
    }

    if (sql.includes('SELECT value FROM alice_meta')) {
      const key = actualParams[0]
      if (typeof key === 'string' && metaState.has(key)) {
        actualCallback?.(null, { value: metaState.get(key) })
      }
      else {
        actualCallback?.(null, undefined)
      }
      return this
    }

    if (sql.includes('COUNT(1) AS total FROM memory_facts')) {
      actualCallback?.(null, { total: 0 })
      return this
    }

    if (sql.includes('COUNT(1) AS total FROM memory_archive')) {
      actualCallback?.(null, { total: 0 })
      return this
    }

    actualCallback?.(null, undefined)
    return this
  }

  all(_sql: string, _params: unknown[] | ((error: Error | null, rows?: unknown[]) => void), callback?: (error: Error | null, rows?: unknown[]) => void) {
    const actualCallback = (typeof _params === 'function' ? _params : callback) as ((error: Error | null, rows?: unknown[]) => void) | undefined
    actualCallback?.(null, [])
    return this
  }

  close(callback: (error: Error | null) => void) {
    callback(null)
  }
}

vi.mock('sqlite3', () => {
  return {
    default: {
      Database: FakeSqliteDatabase,
    },
  }
})

const { setupAliceDb } = await import('./db')

describe('alice sqlite dao', () => {
  it('initializes sqlite pragmas with WAL', async () => {
    runCalls.length = 0
    metaState.clear()

    const db = await setupAliceDb('/tmp/airi-alice-test')
    expect(runCalls.some(sql => sql.includes('PRAGMA journal_mode = WAL'))).toBe(true)
    expect(runCalls.some(sql => sql.includes('PRAGMA busy_timeout = 2000'))).toBe(true)
    expect(await db.getJournalMode()).toBe('wal')
    await db.close()
  })

  it('runs legacy migration only once with marker', async () => {
    runCalls.length = 0
    metaState.clear()

    const db = await setupAliceDb('/tmp/airi-alice-test')
    const snapshot: AliceMemoryLegacySnapshot = {
      facts: [],
      archive: [],
      lastPrunedAt: null,
    }

    const first = await db.importLegacyMemory(snapshot)
    const second = await db.importLegacyMemory(snapshot)

    expect(first.migrated).toBe(true)
    expect(second.migrated).toBe(false)
    expect(metaState.has('legacy_memory_migrated_v1')).toBe(true)

    await db.close()
  })
})
