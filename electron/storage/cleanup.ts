import fs from 'node:fs';
import path from 'node:path';
import type { CleanupResult } from '@shared/recording-types';
import { readManifest } from '../recording/manifest';
import type { AppPaths } from './paths';
import type { RecordingsRepo } from './recordings-repo';
import type { SessionsRepo } from './sessions-repo';

async function removeTree(p: string, result: CleanupResult): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await fs.promises.readdir(p)) await removeTree(path.join(p, name), result);
    await fs.promises.rmdir(p).catch(() => {});
  } else {
    await fs.promises.rm(p, { force: true });
    result.removedFiles++;
    result.freedBytes += stat.size;
  }
}

/**
 * Removes temporary data that is no longer needed:
 *  - session folders of completed/discarded sessions, or folders with no
 *    database row and no valid manifest;
 *  - thumbnails whose recording no longer exists;
 *  - stale `.partial` outputs in the recordings folder (only when no job runs).
 * Recoverable (interrupted/failed) sessions are never touched.
 */
export async function cleanupTemporaryFiles(opts: {
  paths: AppPaths;
  sessions: SessionsRepo;
  recordings: RecordingsRepo;
  outputDir: string;
  activeSessionId: string | null;
  jobsRunning: boolean;
}): Promise<CleanupResult> {
  const result: CleanupResult = { removedFiles: 0, freedBytes: 0 };
  const byId = new Map(opts.sessions.listAll().map((s) => [s.id, s]));

  let dirs: string[] = [];
  try {
    dirs = await fs.promises.readdir(opts.paths.sessions);
  } catch {
    /* none */
  }
  for (const name of dirs) {
    if (name === opts.activeSessionId) continue;
    const dir = path.join(opts.paths.sessions, name);
    const row = byId.get(name);
    const abandoned = row ? row.status === 'completed' || row.status === 'discarded' : readManifest(dir) === null;
    if (abandoned) await removeTree(dir, result);
  }

  const known = new Set(opts.recordings.list({ limit: 100_000 }).map((r) => r.id));
  try {
    for (const name of await fs.promises.readdir(opts.paths.thumbnails)) {
      const id = path.basename(name, path.extname(name));
      if (!known.has(id)) await removeTree(path.join(opts.paths.thumbnails, name), result);
    }
  } catch {
    /* none */
  }

  if (!opts.jobsRunning) {
    try {
      for (const name of await fs.promises.readdir(opts.outputDir)) {
        if (/^\..+\.partial\.mp4$/.test(name)) await removeTree(path.join(opts.outputDir, name), result);
      }
    } catch {
      /* output folder missing */
    }
  }
  return result;
}
