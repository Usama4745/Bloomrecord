import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PauseInterval, SessionStatus, TrackKind } from '@shared/recording-types';
import type { AppDatabase } from './db';
import { recordingSessions, sourceTracks, type NewSessionRow, type SessionRow, type TrackRow } from './schema';

export class SessionsRepo {
  constructor(private readonly db: AppDatabase) {}

  create(row: Omit<NewSessionRow, 'updatedAt'>): SessionRow {
    return this.db
      .insert(recordingSessions)
      .values({ ...row, updatedAt: Date.now() })
      .returning()
      .get();
  }

  get(id: string): SessionRow | undefined {
    return this.db.select().from(recordingSessions).where(eq(recordingSessions.id, id)).get();
  }

  update(id: string, patch: Partial<Omit<NewSessionRow, 'id'>>): SessionRow | undefined {
    return this.db
      .update(recordingSessions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(recordingSessions.id, id))
      .returning()
      .get();
  }

  listByStatus(statuses: SessionStatus[]): SessionRow[] {
    if (statuses.length === 0) return [];
    return this.db
      .select()
      .from(recordingSessions)
      .where(inArray(recordingSessions.status, statuses))
      .orderBy(asc(recordingSessions.startedAt))
      .all();
  }

  listAll(): SessionRow[] {
    return this.db.select().from(recordingSessions).all();
  }

  delete(id: string): void {
    this.db.delete(recordingSessions).where(eq(recordingSessions.id, id)).run();
  }

  addTrack(sessionId: string, kind: TrackKind, filePath: string, mimeType: string): TrackRow {
    return this.db
      .insert(sourceTracks)
      .values({ id: randomUUID(), sessionId, kind, filePath, mimeType, createdAt: Date.now() })
      .returning()
      .get();
  }

  tracks(sessionId: string): TrackRow[] {
    return this.db.select().from(sourceTracks).where(eq(sourceTracks.sessionId, sessionId)).all();
  }

  setTrackOffset(sessionId: string, kind: TrackKind, offsetMs: number): void {
    this.db
      .update(sourceTracks)
      .set({ startOffsetMs: offsetMs })
      .where(and(eq(sourceTracks.sessionId, sessionId), eq(sourceTracks.kind, kind)))
      .run();
  }

  setTrackBytes(sessionId: string, kind: TrackKind, bytes: number): void {
    this.db
      .update(sourceTracks)
      .set({ bytesWritten: bytes })
      .where(and(eq(sourceTracks.sessionId, sessionId), eq(sourceTracks.kind, kind)))
      .run();
  }

  totalBytes(sessionId: string): number {
    const r = this.db
      .select({ total: sql<number>`coalesce(sum(${sourceTracks.bytesWritten}), 0)` })
      .from(sourceTracks)
      .where(eq(sourceTracks.sessionId, sessionId))
      .get();
    return Number(r?.total ?? 0);
  }
}

export function parsePauses(json: string): PauseInterval[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is PauseInterval => !!p && typeof p === 'object' && typeof (p as PauseInterval).startedAt === 'number')
      .map((p) => ({ startedAt: p.startedAt, endedAt: typeof p.endedAt === 'number' ? p.endedAt : null }));
  } catch {
    return [];
  }
}
