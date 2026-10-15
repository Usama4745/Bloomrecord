import { create } from 'zustand';
import type { PlatformCapabilities, Settings, SettingsPatch } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { toast } from './toast-store';

export type Route =
  | { name: 'dashboard' }
  | { name: 'record' }
  | { name: 'library'; search?: string }
  | { name: 'player'; id: string }
  | { name: 'settings' };

interface AppState {
  route: Route;
  settings: Settings | null;
  platform: PlatformCapabilities | null;
  /** Navigation is locked while a recording is active. */
  navigationLocked: boolean;
  /** Bumped whenever the library changes so views refetch. */
  libraryVersion: number;
  navigate(route: Route): void;
  setNavigationLocked(locked: boolean): void;
  load(): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  setSettings(s: Settings): void;
  bumpLibrary(): void;
}

export const useAppStore = create<AppState>((set, get) => ({
  route: { name: 'dashboard' },
  settings: null,
  platform: null,
  navigationLocked: false,
  libraryVersion: 0,
  navigate(route) {
    if (get().navigationLocked && route.name !== 'record') {
      toast.info('Finish or stop the current recording first.');
      return;
    }
    set({ route });
  },
  setNavigationLocked(locked) {
    set({ navigationLocked: locked });
  },
  async load() {
    const [settings, platform] = await Promise.all([bloom.settings.get(), bloom.capture.platform()]);
    set({ settings, platform });
  },
  async updateSettings(patch) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } }); // optimistic
    try {
      set({ settings: await bloom.settings.update(patch) });
    } catch (err) {
      if (prev) set({ settings: prev });
      toast.error(`Could not save settings: ${errorMessage(err)}`);
    }
  },
  setSettings(settings) {
    set({ settings });
  },
  bumpLibrary() {
    set((s) => ({ libraryVersion: s.libraryVersion + 1 }));
  },
}));
