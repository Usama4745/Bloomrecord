export type MediaErrorCode = 'MEDIA' | 'CANCELLED' | 'DISK_FULL' | 'NOT_FOUND' | 'IO';

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly details: { exitCode?: number | null; stderrTail?: string } = {},
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof MediaError && err.code === 'CANCELLED';
}

const PATTERNS: Array<{ re: RegExp; code: MediaErrorCode; message: string }> = [
  { re: /No space left on device|ENOSPC|disk full/i, code: 'DISK_FULL', message: 'The disk is full. Free up space and retry.' },
  { re: /Permission denied|Access is denied|EACCES|EPERM/i, code: 'IO', message: 'Permission denied while reading or writing a media file.' },
  { re: /No such file or directory|does not exist/i, code: 'NOT_FOUND', message: 'A media file could not be found.' },
  {
    re: /Invalid data found when processing input|EBML header parsing failed|moov atom not found|could not find codec parameters/i,
    code: 'MEDIA',
    message: 'A source file is damaged or incomplete and could not be decoded.',
  },
  { re: /matches no streams|Stream specifier .* matches no streams/i, code: 'MEDIA', message: 'An expected audio or video stream is missing from the source.' },
  { re: /Error (initializing|while opening) (filter|encoder)|Filter .* not found|No such filter/i, code: 'MEDIA', message: 'FFmpeg could not configure the processing pipeline.' },
  { re: /Unknown encoder|Encoder .* not found/i, code: 'MEDIA', message: 'The bundled FFmpeg lacks a required encoder.' },
];

/** Converts FFmpeg's stderr into a short, user-meaningful error while keeping the raw tail for diagnostics. */
export function classifyFfmpegFailure(stderrTail: string, exitCode: number | null): MediaError {
  for (const p of PATTERNS) {
    if (p.re.test(stderrTail)) {
      return new MediaError(p.code, `${p.message} ${lastMeaningfulLine(stderrTail)}`.trim(), { exitCode, stderrTail });
    }
  }
  const last = lastMeaningfulLine(stderrTail);
  return new MediaError('MEDIA', last ? `Media processing failed: ${last}` : `Media processing failed (exit code ${exitCode ?? 'unknown'}).`, {
    exitCode,
    stderrTail,
  });
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame|size|progress|out_time|bitrate|speed)=/.test(l) && l !== 'Conversion failed!');
  const line = lines.at(-1) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
