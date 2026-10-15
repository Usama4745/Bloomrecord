import fs from 'node:fs';
import path from 'node:path';

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export interface ResolveOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  /** Optional override directory (tests / diagnostics). */
  overrideDir?: string | undefined;
}

/**
 * FFmpeg and FFprobe are bundled with the app: in packages they live in
 * <resources>/ffmpeg, in development in <project>/resources/ffmpeg (populated
 * by scripts/prepare-ffmpeg.mjs). The system PATH is never consulted.
 */
export function resolveFfmpegBinaries(opts: ResolveOptions): FfmpegBinaries {
  const exe = opts.platform === 'win32' ? '.exe' : '';
  const dir =
    opts.overrideDir ??
    (opts.isPackaged ? path.join(opts.resourcesPath, 'ffmpeg') : path.join(opts.appPath, 'resources', 'ffmpeg'));
  return {
    ffmpeg: path.join(dir, `ffmpeg${exe}`),
    ffprobe: path.join(dir, `ffprobe${exe}`),
  };
}

export function assertBinariesExist(bins: FfmpegBinaries): void {
  for (const [name, p] of Object.entries(bins)) {
    if (!fs.existsSync(p)) throw new Error(`Bundled ${name} not found at ${p}`);
  }
}
