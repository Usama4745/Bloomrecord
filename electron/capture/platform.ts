import type { MediaPermission, PermissionStatus, PlatformCapabilities } from '@shared/recording-types';

/** The pieces of Electron the platform layer needs, injected so the logic is testable. */
export interface PlatformElectron {
  getMediaAccessStatus?(kind: 'camera' | 'microphone' | 'screen'): string;
  askForMediaAccess?(kind: 'camera' | 'microphone'): Promise<boolean>;
  openExternal(url: string): Promise<void>;
}

/**
 * Platform-specific capture behaviour behind one interface: which audio
 * sources are capturable, how OS permissions are queried/requested, and
 * where the user fixes a denied permission.
 */
export interface CapturePlatform {
  capabilities(): PlatformCapabilities;
  permissionStatus(kind: MediaPermission): PermissionStatus;
  requestPermission(kind: MediaPermission): Promise<PermissionStatus>;
  openPermissionSettings(kind: MediaPermission): Promise<void>;
  /** Audio mode to hand to setDisplayMediaRequestHandler for system audio, or null if unsupported. */
  loopbackAudio(): 'loopback' | null;
}

function normalizeStatus(s: string | undefined): PermissionStatus {
  switch (s) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return s;
    default:
      return 'unknown';
  }
}

class WindowsPlatform implements CapturePlatform {
  constructor(
    private readonly e: PlatformElectron,
    private readonly arch: string,
  ) {}
  capabilities(): PlatformCapabilities {
    return {
      platform: 'win32',
      arch: this.arch,
      systemAudio: true,
      systemAudioNote: 'System audio is captured from the default output device (WASAPI loopback).',
      usesSystemPicker: false,
      screenPermissionNote: null,
      isWayland: false,
    };
  }
  permissionStatus(kind: MediaPermission): PermissionStatus {
    if (kind === 'screen') return 'granted';
    return normalizeStatus(this.e.getMediaAccessStatus?.(kind));
  }
  async requestPermission(kind: MediaPermission): Promise<PermissionStatus> {
    // Windows has no programmatic prompt; access is governed by Privacy settings.
    return this.permissionStatus(kind);
  }
  async openPermissionSettings(kind: MediaPermission): Promise<void> {
    const url = kind === 'camera' ? 'ms-settings:privacy-webcam' : kind === 'microphone' ? 'ms-settings:privacy-microphone' : null;
    if (url) await this.e.openExternal(url);
  }
  loopbackAudio(): 'loopback' {
    return 'loopback';
  }
}

class MacPlatform implements CapturePlatform {
  constructor(
    private readonly e: PlatformElectron,
    private readonly arch: string,
  ) {}
  capabilities(): PlatformCapabilities {
    return {
      platform: 'darwin',
      arch: this.arch,
      systemAudio: false,
      systemAudioNote:
        'Direct system-audio capture is not enabled on macOS in this version. To include it, install a loopback driver (e.g. BlackHole) and select it as the microphone.',
      usesSystemPicker: false,
      screenPermissionNote:
        'macOS requires Screen Recording permission. Enable BloomRecord in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.',
      isWayland: false,
    };
  }
  permissionStatus(kind: MediaPermission): PermissionStatus {
    return normalizeStatus(this.e.getMediaAccessStatus?.(kind));
  }
  async requestPermission(kind: MediaPermission): Promise<PermissionStatus> {
    if (kind !== 'screen' && this.e.askForMediaAccess) {
      await this.e.askForMediaAccess(kind);
    }
    // Screen recording cannot be requested directly; listing sources triggers the OS prompt once.
    return this.permissionStatus(kind);
  }
  async openPermissionSettings(kind: MediaPermission): Promise<void> {
    const anchor = kind === 'camera' ? 'Privacy_Camera' : kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
    await this.e.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  }
  loopbackAudio(): null {
    return null;
  }
}

class LinuxPlatform implements CapturePlatform {
  constructor(
    private readonly arch: string,
    private readonly wayland: boolean,
  ) {}
  capabilities(): PlatformCapabilities {
    return {
      platform: 'linux',
      arch: this.arch,
      systemAudio: false,
      systemAudioNote:
        'To include system audio on Linux, choose a “Monitor of …” input (PulseAudio/PipeWire) as the microphone.',
      usesSystemPicker: this.wayland,
      screenPermissionNote: this.wayland
        ? 'On Wayland, your desktop asks which screen or window to share each time a recording starts (xdg-desktop-portal + PipeWire).'
        : null,
      isWayland: this.wayland,
    };
  }
  permissionStatus(): PermissionStatus {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionStatus> {
    return 'granted';
  }
  async openPermissionSettings(): Promise<void> {
    /* no central settings page */
  }
  loopbackAudio(): null {
    return null;
  }
}

export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;
}

export function createCapturePlatform(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv,
  electron: PlatformElectron,
): CapturePlatform {
  if (platform === 'win32') return new WindowsPlatform(electron, arch);
  if (platform === 'darwin') return new MacPlatform(electron, arch);
  return new LinuxPlatform(arch, isWaylandSession(env));
}
