import { spawn } from 'node:child_process';
import path from 'node:path';
import { classifyFfmpegFailure, MediaError } from './errors';

export interface RunOptions {
  signal?: AbortSignal | undefined;
  onStdoutLine?: (line: string) => void;
  /** Collect stdout into the result (bounded). */
  collectStdout?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderrTail: string;
}

const MAX_STDOUT = 16 * 1024 * 1024;
const STDERR_TAIL_LINES = 60;

/**
 * Spawns a bundled media binary with an argument array (never a shell), so
 * paths and user input are never interpreted by a shell. Rejects with a
 * MediaError on non-zero exit, timeout or cancellation.
 */
export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (!path.isAbsolute(bin)) return Promise.reject(new MediaError('IO', 'Media binary path must be absolute'));
  if (opts.signal?.aborted) return Promise.reject(new MediaError('CANCELLED', 'Cancelled'));

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stdoutBuf = '';
    const stderrLines: string[] = [];
    let stderrBuf = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const kill = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (opts.collectStdout && stdout.length < MAX_STDOUT) stdout += chunk;
      if (opts.onStdoutLine) {
        stdoutBuf += chunk;
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(stdoutBuf.slice(0, idx).replace(/\r$/, ''));
          stdoutBuf = stdoutBuf.slice(idx + 1);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        stderrLines.push(stderrBuf.slice(0, idx).replace(/\r$/, ''));
        if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    child.on('error', (err) => finish(() => reject(new MediaError('IO', `Could not start ${path.basename(bin)}: ${err.message}`))));
    child.on('close', (code) => {
      if (stderrBuf) stderrLines.push(stderrBuf);
      if (stdoutBuf && opts.onStdoutLine) opts.onStdoutLine(stdoutBuf);
      const stderrTail = stderrLines.join('\n');
      finish(() => {
        if (cancelled) reject(new MediaError('CANCELLED', 'Cancelled'));
        else if (timedOut) reject(new MediaError('MEDIA', `${path.basename(bin)} timed out`, { stderrTail }));
        else if (code !== 0) reject(classifyFfmpegFailure(stderrTail, code));
        else resolve({ stdout, stderrTail });
      });
    });
  });
}
