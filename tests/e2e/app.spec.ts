import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * End-to-end tests against the production Vite build (`npm run package`
 * produces .vite/), launched with the project's Electron binary. Chromium's
 * synthetic camera/microphone stand in for real devices; screen capture is real.
 */

const root = path.resolve(__dirname, '../..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-e2e-'));
const ffprobe = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const externalRequests: string[] = [];

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  if (!fs.existsSync(path.join(root, '.vite', 'build', 'main.cjs'))) throw new Error('Run `npm run package` first to build .vite/');
  // Hosts like VS Code export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, BLOOM_USER_DATA: userData, BLOOM_FAKE_MEDIA: '1', NODE_ENV: 'production' } as Record<string, string>,
  });
  // Offline guarantee: the app must never talk to the network.
  app.context().on('request', (req) => {
    const url = req.url();
    if (!/^(app|bloom-media|data|blob|devtools|chrome-extension|mediastream):/.test(url)) externalRequests.push(url);
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function probe(file: string) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
  };
}

async function setCountdownOff(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Countdown' }).click();
  await page.getByRole('option', { name: 'Off' }).click();
}

async function record(page: Page, mode: 'Camera only' | 'Screen + Camera', seconds: number) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Record' }).click();
  await page.getByRole('radio', { name: mode }).click();
  const start = page.getByTestId('start-recording');
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(seconds * 500);
  await page.getByTestId('pause-resume').click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  const pausedAt = await page.getByTestId('recording-timer').textContent();
  await page.waitForTimeout(1500);
  // Timer does not advance while paused.
  await expect(page.getByTestId('recording-timer')).toHaveText(pausedAt!);
  await page.getByTestId('pause-resume').click();
  await page.waitForTimeout(seconds * 500);
  await page.getByTestId('stop-recording').click();
  // Lands on the player; processing completes into a playable video.
  await expect(page.getByTestId('player-video')).toBeVisible({ timeout: 120_000 });
}

function latestOutput(): string {
  const dir = path.join(os.homedir(), 'Videos', 'BloomRecord');
  const db = path.join(userData, 'bloomrecord.db');
  expect(fs.existsSync(db)).toBe(true);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp4') && !f.startsWith('.'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0]!;
}

const createdFiles: string[] = [];

test.afterAll(() => {
  // Recordings from the e2e run are test data; remove them from the Videos folder.
  for (const f of createdFiles) fs.rmSync(f, { force: true });
});

test('launches offline with a secure, empty dashboard', async () => {
  const { app, page } = await launch();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByText('No recordings yet')).toBeVisible();

  // The renderer has no Node.js access; only the narrow bridge exists.
  const isolation = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bloomKeys: Object.keys((window as unknown as { bloom: object }).bloom).sort(),
  }));
  expect(isolation).toEqual({ require: 'undefined', process: 'undefined', bloomKeys: ['capture', 'jobs', 'library', 'on', 'recording', 'settings'] });

  // Main rejects malformed IPC input.
  const rejected = await page.evaluate(() =>
    (window as unknown as { bloom: { library: { rename: (id: string, t: string) => Promise<unknown> } } }).bloom.library
      .rename('not-a-uuid', 'x')
      .then(() => 'accepted')
      .catch((e: Error) => e.message),
  );
  expect(rejected).toMatch(/\[bloom:VALIDATION\]/);

  const webPrefs = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    // getLastWebPreferences is available on WebContents.
    const p = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox };
  });
  expect(webPrefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('BloomRecord is fully local.')).toBeVisible();
  await expect(page.getByText(/ffmpeg version/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  // Navigation away from the app is blocked (last: Playwright then waits on the cancelled navigation).
  await page.evaluate(() => {
    window.location.href = 'https://example.com';
  });
  await page.waitForTimeout(500);
  const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL());
  expect(url).toMatch(/^app:\/\/bloomrecord\//);
  await app.close();
});

test('records camera-only with pause/resume, processes to MP4, trims and exports', async () => {
  const { app, page } = await launch();
  await setCountdownOff(page);
  await record(page, 'Camera only', 4);

  const file = latestOutput();
  createdFiles.push(file);
  const info = probe(file);
  expect(info.streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
  expect(info.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
  expect(Number(info.format.duration)).toBeGreaterThan(2.5);

  // Trim the middle and save it into the library.
  await page.getByRole('slider', { name: /Trim start/ }).focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // +500ms
  await page.getByTestId('export-library').click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByTestId('recording-card')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByText('Trimmed', { exact: true })).toBeVisible();
  createdFiles.push(latestOutput());
  await app.close();
});

test('records the screen with a circular webcam bubble', async () => {
  const { app, page } = await launch();
  await record(page, 'Screen + Camera', 4);
  const file = latestOutput();
  createdFiles.push(file);
  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video')!;
  expect(video.codec_name).toBe('h264');
  expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  // Save one frame for visual inspection of the bubble.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'scale=960:-2', path.join(userData, 'screen-frame.jpg')]);
  console.log(`Frame saved to ${path.join(userData, 'screen-frame.jpg')} (${video.width}x${video.height})`);
  await app.close();
});

test('library persists across restarts and the app made no network requests', async () => {
  const { app, page } = await launch();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' }).click();
  await expect(page.getByTestId('recording-card')).toHaveCount(3);
  await page.getByRole('textbox', { name: 'Search recordings' }).fill('trimmed');
  await expect(page.getByTestId('recording-card')).toHaveCount(1);
  await app.close();
  expect(externalRequests).toEqual([]);
});
