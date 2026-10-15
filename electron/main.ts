import path from 'node:path';
import { app, BrowserWindow, dialog, globalShortcut, nativeTheme, session } from 'electron';
import started from 'electron-squirrel-startup';
import { IpcEvents, type IpcEvent, type IpcEventPayloads } from '@shared/ipc-contracts';
import type { RecordingStatusEvent, Settings } from '@shared/recording-types';
import { createAppContext, type AppContext } from './app-context';
import { registerIpcHandlers } from './ipc/handlers';
import { assertBinariesExist, resolveFfmpegBinaries } from './media/binaries';
import { createTrustedOrigins, hardenAllWebContents, installCspHeaders, installPermissionHandlers } from './security/hardening';
import { APP_HOST, APP_SCHEME, handleAppProtocol, handleMediaProtocol, registerSchemes } from './security/protocols';

// Squirrel.Windows install/uninstall hooks.
if (started) app.quit();

registerSchemes();

if (process.env.BLOOM_USER_DATA) app.setPath('userData', path.resolve(process.env.BLOOM_USER_DATA));
// Automated tests drive recording with Chromium's synthetic camera/microphone.
if (process.env.BLOOM_FAKE_MEDIA === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

const SHORTCUT_PAUSE = 'CommandOrControl+Shift+9';
const SHORTCUT_STOP = 'CommandOrControl+Shift+0';

let mainWindow: BrowserWindow | null = null;
let ctx: AppContext | null = null;
let quitConfirmed = false;

function send<E extends IpcEvent>(event: E, payload: IpcEventPayloads[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload);
  }
}

function applyTheme(s: Settings): void {
  nativeTheme.themeSource = s.theme;
}

function updateShortcuts(e: RecordingStatusEvent): void {
  const capturing = e.status === 'recording' || e.status === 'paused';
  if (capturing && !globalShortcut.isRegistered(SHORTCUT_STOP)) {
    globalShortcut.register(SHORTCUT_PAUSE, () => send(IpcEvents.shortcut, { action: 'toggle-pause' }));
    globalShortcut.register(SHORTCUT_STOP, () => send(IpcEvents.shortcut, { action: 'stop' }));
  } else if (!capturing) {
    globalShortcut.unregister(SHORTCUT_PAUSE);
    globalShortcut.unregister(SHORTCUT_STOP);
  }
}

function createWindow(context: AppContext): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    show: false,
    title: 'BloomRecord',
    autoHideMenuBar: true,
    // Matches --background (brand-tinted) so there is no flash before the UI paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c1517' : '#f7fafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Recording keeps running while the window is minimized or hidden.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.on('close', (event) => {
    if (quitConfirmed || !context.recording.isCapturing()) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep recording', 'Quit and keep for recovery'],
      defaultId: 0,
      cancelId: 0,
      title: 'Recording in progress',
      message: 'A recording is in progress.',
      detail: 'If you quit now, everything captured so far is kept and can be recovered the next time you open BloomRecord.',
    });
    if (choice === 1) {
      const id = context.recording.activeSessionId;
      void (id ? context.recording.abort(id, 'The app was closed during recording.') : Promise.resolve()).finally(() => {
        quitConfirmed = true;
        win.close();
      });
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  }
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined;
    const origins = createTrustedOrigins(devUrl);
    hardenAllWebContents(origins);
    installPermissionHandlers(session.defaultSession, origins);
    if (devUrl) installCspHeaders(session.defaultSession, true);

    const bins = resolveFfmpegBinaries({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
    });
    try {
      assertBinariesExist(bins);
    } catch (err) {
      dialog.showErrorBox('BloomRecord cannot start', `${(err as Error).message}\n\nReinstall the application.`);
      app.quit();
      return;
    }

    const context = createAppContext({
      userData: app.getPath('userData'),
      defaultOutputDir: path.join(app.getPath('videos'), 'BloomRecord'),
      bins,
      origins,
      send: (event, payload) => {
        if (event === IpcEvents.recordingStatus) onRecordingStatus(payload as RecordingStatusEvent);
        send(event, payload);
      },
      onSettingsChanged: applyTheme,
    });
    ctx = context;
    applyTheme(context.settings.get());

    if (!devUrl) handleAppProtocol(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`));
    handleMediaProtocol((kind, id) => context.library.resolveMedia(kind, id));
    context.broker.install(session.defaultSession);
    registerIpcHandlers(context, () => mainWindow);

    const recovered = context.recording.recoverAfterCrash();
    if (recovered.interrupted || recovered.imported) {
      context.log(`Startup recovery: ${recovered.interrupted} interrupted, ${recovered.imported} imported from manifests`);
    }

    mainWindow = createWindow(context);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(context);
    });
  });

  function onRecordingStatus(e: RecordingStatusEvent): void {
    updateShortcuts(e);
    if (e.status === 'recording' && ctx && mainWindow) {
      const s = ctx.settings.get();
      const row = ctx.sessionsRepo.get(e.sessionId);
      // Minimize only when the session has just started (no pauses yet) and something other than the camera is captured.
      if (s.minimizeOnRecord && row && row.mode !== 'camera' && row.pausesJson === '[]' && e.activeDurationMs < 1000) {
        mainWindow.minimize();
      }
    }
  }

  app.on('before-quit', (event) => {
    if (!ctx || quitConfirmed) return;
    const busy = ctx.jobs.list().some((j) => j.status === 'running' || j.status === 'queued');
    if (!busy) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Keep processing', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is still being processed.',
      detail: 'If you quit, processing stops. Your raw recording is kept and you can retry from the library.',
    });
    if (choice === 1) {
      quitConfirmed = true;
      ctx.jobs.cancelAll();
      void ctx.jobs.whenIdle().finally(() => app.quit());
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try {
      ctx?.database.close();
    } catch {
      /* ignore */
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
