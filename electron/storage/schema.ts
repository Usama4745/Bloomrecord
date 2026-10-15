import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Finished (or processing / failed) recordings shown in the library. Media lives on disk; only metadata is stored. */
export const recordings = sqliteTable(
  'recordings',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    filePath: text('file_path').notNull(),
    thumbnailPath: text('thumbnail_path'),
    status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    fps: real('fps'),
    fileSize: integer('file_size'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    hasAudio: integer('has_audio', { mode: 'boolean' }).notNull().default(false),
    hasCamera: integer('has_camera', { mode: 'boolean' }).notNull().default(false),
    sessionId: text('session_id'),
    /** Set for trimmed exports saved back into the library. */
    sourceRecordingId: text('source_recording_id'),
    trimStartMs: integer('trim_start_ms'),
    trimEndMs: integer('trim_end_ms'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('recordings_created_idx').on(t.createdAt), index('recordings_session_idx').on(t.sessionId)],
);

/** One capture session. Survives crashes so interrupted recordings can be recovered. */
export const recordingSessions = sqliteTable(
  'recording_sessions',
  {
    id: text('id').primaryKey(),
    status: text('status', {
      enum: ['recording', 'paused', 'stopping', 'processing', 'completed', 'failed', 'interrupted', 'discarded'],
    }).notNull(),
    mode: text('mode', { enum: ['screen', 'screen-camera', 'camera'] }).notNull(),
    /** JSON of the validated StartRecordingRequest (minus tracks). */
    optionsJson: text('options_json').notNull(),
    /** JSON array of PauseInterval. */
    pausesJson: text('pauses_json').notNull().default('[]'),
    tempDir: text('temp_dir').notNull(),
    title: text('title'),
    recordingId: text('recording_id'),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    activeDurationMs: integer('active_duration_ms'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('sessions_status_idx').on(t.status)],
);

/** Raw per-device files captured during a session (screen, camera, mic, system audio). */
export const sourceTracks = sqliteTable(
  'source_tracks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => recordingSessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['screen', 'camera', 'mic', 'system'] }).notNull(),
    filePath: text('file_path').notNull(),
    mimeType: text('mime_type').notNull(),
    startOffsetMs: real('start_offset_ms'),
    bytesWritten: integer('bytes_written').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('tracks_session_idx').on(t.sessionId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

export const recordingTags = sqliteTable(
  'recording_tags',
  {
    recordingId: text('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.recordingId, t.tagId] })],
);

export type RecordingRow = typeof recordings.$inferSelect;
export type NewRecordingRow = typeof recordings.$inferInsert;
export type SessionRow = typeof recordingSessions.$inferSelect;
export type NewSessionRow = typeof recordingSessions.$inferInsert;
export type TrackRow = typeof sourceTracks.$inferSelect;
