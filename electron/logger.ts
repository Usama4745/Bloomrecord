import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Local-only diagnostic log in <userData>/logs/main.log. Nothing is ever uploaded. */
export function createLogger(logDir: string): (msg: string, err?: unknown) => void {
  const file = path.join(logDir, 'main.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
  return (msg, err) => {
    const detail = err instanceof Error ? ` ${err.name}: ${err.message}\n${err.stack ?? ''}` : err !== undefined ? ` ${String(err)}` : '';
    const line = `${new Date().toISOString()} ${msg}${detail}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* ignore */
    }
    if (process.env.NODE_ENV !== 'production') console.log(line.trimEnd());
  };
}
