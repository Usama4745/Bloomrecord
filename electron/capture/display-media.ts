import { desktopCapturer, type DesktopCapturerSource, type Session } from 'electron';
import type { CaptureSource } from '@shared/recording-types';
import type { CapturePlatform } from './platform';

/** Source id the renderer passes when the OS picker (Wayland portal) chooses the source. */
export const SYSTEM_PICKER_SOURCE = 'system-picker';
const PENDING_TTL_MS = 20_000;

export async function listCaptureSources(types: Array<'screen' | 'window'>, excludeIds: Set<string>): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !excludeIds.has(s.id) && s.name.trim() !== '')
    .map((s) => ({
      id: s.id,
      name: s.name.slice(0, 512),
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      displayId: s.display_id || null,
    }));
}

/**
 * Bridges our in-app source picker to getDisplayMedia(): the renderer first
 * names the source over IPC, then calls getDisplayMedia(), and this handler
 * hands Chromium that exact source (plus loopback audio where supported).
 * A pending selection is single-use and expires quickly; any other
 * getDisplayMedia() call is denied.
 */
export class DisplayMediaBroker {
  private pending: { sourceId: string; systemAudio: boolean; expires: number } | null = null;

  constructor(private readonly platform: CapturePlatform) {}

  prepare(sourceId: string, systemAudio: boolean): void {
    this.pending = { sourceId, systemAudio, expires: Date.now() + PENDING_TTL_MS };
  }

  install(session: Session): void {
    session.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const p = this.pending;
        this.pending = null;
        const deny = () => callback({} as Parameters<typeof callback>[0]);
        if (!p || p.expires < Date.now()) return deny();
        void (async () => {
          try {
            const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
            const source: DesktopCapturerSource | undefined =
              p.sourceId === SYSTEM_PICKER_SOURCE ? sources[0] : sources.find((s) => s.id === p.sourceId);
            if (!source) return deny();
            const loopback = p.systemAudio ? this.platform.loopbackAudio() : null;
            callback(loopback ? { video: source, audio: loopback } : { video: source });
          } catch {
            deny();
          }
        })();
      },
      { useSystemPicker: false },
    );
  }
}
