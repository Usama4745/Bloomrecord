import fs from 'node:fs';
import path from 'node:path';

/** All app-owned locations. Media recordings go to the user-chosen output folder instead. */
export interface AppPaths {
  userData: string;
  database: string;
  thumbnails: string;
  /** Raw per-track capture files for in-progress or recoverable sessions. */
  sessions: string;
  logs: string;
  /** User-supplied webcam background images. */
  backgrounds: string;
}

export function createAppPaths(userData: string): AppPaths {
  const paths: AppPaths = {
    userData,
    database: path.join(userData, 'bloomrecord.db'),
    thumbnails: path.join(userData, 'thumbnails'),
    sessions: path.join(userData, 'sessions'),
    logs: path.join(userData, 'logs'),
    backgrounds: path.join(userData, 'backgrounds'),
  };
  for (const dir of [paths.userData, paths.thumbnails, paths.sessions, paths.logs, paths.backgrounds]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Total size of all files under `dir` (0 if it does not exist). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await directorySize(p);
    else if (e.isFile()) {
      try {
        total += (await fs.promises.stat(p)).size;
      } catch {
        /* file vanished */
      }
    }
  }
  return total;
}

/** Free bytes on the volume holding `dir`, or null if it cannot be determined. */
export async function freeSpace(dir: string): Promise<number | null> {
  try {
    let probe = dir;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const s = await fs.promises.statfs(probe);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function fileSizeOrNull(p: string): Promise<number | null> {
  try {
    const s = await fs.promises.stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}
