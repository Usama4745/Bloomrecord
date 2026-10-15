import { and, asc, count, desc, eq, sql, sum, type SQL } from 'drizzle-orm';
import type { LibrarySort } from '@shared/recording-types';
import type { AppDatabase } from './db';
import { recordings, type NewRecordingRow, type RecordingRow } from './schema';

export interface ListOptions {
  search?: string;
  sort?: LibrarySort;
  limit?: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class RecordingsRepo {
  constructor(private readonly db: AppDatabase) {}

  create(row: NewRecordingRow): RecordingRow {
    return this.db.insert(recordings).values(row).returning().get();
  }

  get(id: string): RecordingRow | undefined {
    return this.db.select().from(recordings).where(eq(recordings.id, id)).get();
  }

  findBySession(sessionId: string): RecordingRow | undefined {
    return this.db.select().from(recordings).where(eq(recordings.sessionId, sessionId)).get();
  }

  list(opts: ListOptions = {}): RecordingRow[] {
    const where: SQL[] = [];
    const term = opts.search?.trim();
    if (term) where.push(sql`${recordings.title} LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);
    const order = (() => {
      switch (opts.sort ?? 'newest') {
        case 'oldest':
          return [asc(recordings.createdAt)];
        case 'title':
          return [asc(sql`${recordings.title} COLLATE NOCASE`), desc(recordings.createdAt)];
        case 'duration':
          return [desc(sql`coalesce(${recordings.durationMs}, -1)`), desc(recordings.createdAt)];
        case 'size':
          return [desc(sql`coalesce(${recordings.fileSize}, -1)`), desc(recordings.createdAt)];
        default:
          return [desc(recordings.createdAt)];
      }
    })();
    return this.db
      .select()
      .from(recordings)
      .where(where.length ? and(...where) : undefined)
      .orderBy(...order)
      .limit(opts.limit ?? 500)
      .all();
  }

  update(id: string, patch: Partial<Omit<NewRecordingRow, 'id' | 'createdAt'>>): RecordingRow | undefined {
    return this.db
      .update(recordings)
      .set({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
      .where(eq(recordings.id, id))
      .returning()
      .get();
  }

  delete(id: string): boolean {
    return this.db.delete(recordings).where(eq(recordings.id, id)).run().changes > 0;
  }

  stats(): { count: number; totalBytes: number } {
    const r = this.db
      .select({ c: count(), total: sum(recordings.fileSize) })
      .from(recordings)
      .get();
    return { count: r?.c ?? 0, totalBytes: Number(r?.total ?? 0) };
  }

  /** Recordings still marked processing (e.g. after a crash). */
  listProcessing(): RecordingRow[] {
    return this.db.select().from(recordings).where(eq(recordings.status, 'processing')).all();
  }
}
