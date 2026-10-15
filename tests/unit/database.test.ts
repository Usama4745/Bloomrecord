import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type DatabaseHandle } from '../../electron/storage/db';
import { RecordingsRepo } from '../../electron/storage/recordings-repo';
import { parsePauses, SessionsRepo } from '../../electron/storage/sessions-repo';
import { SettingsRepo } from '../../electron/storage/settings-repo';
import { settings as settingsTable } from '../../electron/storage/schema';

let h: DatabaseHandle;
beforeEach(() => {
  h = openDatabase(':memory:');
});
afterEach(() => h.close());

function rec(repo: RecordingsRepo, title: string, extra: Partial<Parameters<RecordingsRepo['create']>[0]> = {}) {
  return repo.create({
    id: randomUUID(),
    title,
    filePath: `/videos/${title}.mp4`,
    status: 'ready',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
}

describe('migrations', () => {
  it('creates all tables and is idempotent', () => {
    const tables = (h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['recordings', 'recording_sessions', 'source_tracks', 'settings', 'tags', 'recording_tags', '__migrations']));
    expect(runMigrations(h.sqlite, [{ id: '0000_init', sql: 'SELECT 1' }])).toEqual([]);
  });

  it('applies new migrations once, atomically', () => {
    expect(runMigrations(h.sqlite, [{ id: '0001_x', sql: 'CREATE TABLE x (a int);--> statement-breakpoint\nCREATE TABLE y (b int);' }])).toEqual(['0001_x']);
    expect(runMigrations(h.sqlite, [{ id: '0001_x', sql: 'CREATE TABLE x (a int);' }])).toEqual([]);
    expect(() => runMigrations(h.sqlite, [{ id: '0002_bad', sql: 'CREATE TABLE z (a int);--> statement-breakpoint\nNOT SQL' }])).toThrow();
    const z = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='z'").get();
    expect(z).toBeUndefined();
  });
});

describe('recordings repository', () => {
  it('creates, updates, lists, searches and sorts', () => {
    const repo = new RecordingsRepo(h.db);
    const a = rec(repo, 'Alpha demo', { createdAt: 1, durationMs: 5000, fileSize: 100 });
    rec(repo, 'beta walkthrough', { createdAt: 2, durationMs: 1000, fileSize: 300 });
    rec(repo, 'Gamma 100% done_', { createdAt: 3, durationMs: null, fileSize: 200 });

    expect(repo.list().map((r) => r.title)).toEqual(['Gamma 100% done_', 'beta walkthrough', 'Alpha demo']);
    expect(repo.list({ sort: 'oldest' })[0]!.id).toBe(a.id);
    expect(repo.list({ sort: 'title' }).map((r) => r.title)).toEqual(['Alpha demo', 'beta walkthrough', 'Gamma 100% done_']);
    expect(repo.list({ sort: 'duration' })[0]!.title).toBe('Alpha demo');
    expect(repo.list({ sort: 'size' })[0]!.title).toBe('beta walkthrough');
    expect(repo.list({ search: 'DEMO' }).map((r) => r.title)).toEqual(['Alpha demo']);
    // LIKE wildcards in the search term are literal.
    expect(repo.list({ search: '%' }).map((r) => r.title)).toEqual(['Gamma 100% done_']);
    expect(repo.list({ search: '_' }).map((r) => r.title)).toEqual(['Gamma 100% done_']);
    expect(repo.list({ limit: 1 })).toHaveLength(1);

    const updated = repo.update(a.id, { title: 'Renamed' });
    expect(updated?.title).toBe('Renamed');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(repo.stats()).toEqual({ count: 3, totalBytes: 600 });
    expect(repo.delete(a.id)).toBe(true);
    expect(repo.get(a.id)).toBeUndefined();
    expect(repo.delete(a.id)).toBe(false);
  });

  it('finds processing recordings and by session', () => {
    const repo = new RecordingsRepo(h.db);
    const sid = randomUUID();
    rec(repo, 'p', { status: 'processing', sessionId: sid });
    expect(repo.listProcessing()).toHaveLength(1);
    expect(repo.findBySession(sid)?.title).toBe('p');
  });
});

describe('sessions repository', () => {
  it('stores sessions, tracks, offsets and byte counts', () => {
    const repo = new SessionsRepo(h.db);
    const id = randomUUID();
    repo.create({ id, status: 'recording', mode: 'screen', optionsJson: '{}', tempDir: '/tmp/s', startedAt: 10 });
    repo.addTrack(id, 'screen', '/tmp/s/screen.webm', 'video/webm');
    repo.addTrack(id, 'mic', '/tmp/s/mic.webm', 'audio/webm');
    repo.setTrackOffset(id, 'mic', 42.5);
    repo.setTrackBytes(id, 'screen', 1000);
    repo.setTrackBytes(id, 'mic', 24);
    expect(repo.tracks(id).find((t) => t.kind === 'mic')?.startOffsetMs).toBe(42.5);
    expect(repo.totalBytes(id)).toBe(1024);
    expect(repo.listByStatus(['recording'])).toHaveLength(1);
    repo.update(id, { status: 'interrupted' });
    expect(repo.listByStatus(['recording'])).toHaveLength(0);
    repo.delete(id);
    expect(repo.tracks(id)).toHaveLength(0); // cascade
  });

  it('parses pause intervals defensively', () => {
    expect(parsePauses('[{"startedAt":1,"endedAt":2},{"startedAt":3}]')).toEqual([
      { startedAt: 1, endedAt: 2 },
      { startedAt: 3, endedAt: null },
    ]);
    expect(parsePauses('garbage')).toEqual([]);
    expect(parsePauses('{"a":1}')).toEqual([]);
  });
});

describe('settings repository', () => {
  it('returns defaults, persists patches and rejects invalid values', () => {
    const repo = new SettingsRepo(h.db, '/home/me/Videos/BloomRecord');
    expect(repo.get().outputDir).toBe('/home/me/Videos/BloomRecord');
    expect(repo.get().frameRate).toBe(30);
    expect(repo.update({ frameRate: 60, theme: 'dark' }).frameRate).toBe(60);
    expect(() => repo.update({ frameRate: 59 as 60 })).toThrow();
    expect(() => repo.update({ outputDir: '/etc' } as never)).toThrow();
    expect(repo.setOutputDir('/mnt/rec').outputDir).toBe('/mnt/rec');
    expect(new SettingsRepo(h.db, '/other').get()).toMatchObject({ frameRate: 60, theme: 'dark', outputDir: '/mnt/rec' });
  });

  it('falls back to defaults for corrupt stored values', () => {
    const repo = new SettingsRepo(h.db, '/v');
    h.db.insert(settingsTable).values({ key: 'frameRate', valueJson: '"fast"', updatedAt: 0 }).run();
    h.db.insert(settingsTable).values({ key: 'theme', valueJson: '{not json', updatedAt: 0 }).run();
    h.db.insert(settingsTable).values({ key: 'unknownKey', valueJson: '1', updatedAt: 0 }).run();
    expect(repo.get()).toMatchObject({ frameRate: 30, theme: 'system' });
  });
});
