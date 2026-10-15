import { settingsSchema, settingsPatchSchema } from '@shared/validation';
import type { Settings, SettingsPatch } from '@shared/recording-types';
import type { AppDatabase } from './db';
import { settings as settingsTable } from './schema';

export function defaultSettings(outputDir: string): Settings {
  return {
    outputDir,
    defaultMode: 'screen-camera',
    resolution: '1080p',
    frameRate: 30,
    quality: 'high',
    cameraDeviceId: null,
    micDeviceId: null,
    systemAudio: false,
    bubblePosition: 'bottom-left',
    bubbleSize: 'medium',
    theme: 'system',
    countdownSeconds: 3,
    minimizeOnRecord: false,
  };
}

/**
 * Settings stored one key per row. Each value is validated on read; a corrupt
 * or out-of-range value falls back to its default rather than breaking startup.
 */
export class SettingsRepo {
  private readonly defaults: Settings;

  constructor(
    private readonly db: AppDatabase,
    defaultOutputDir: string,
  ) {
    this.defaults = defaultSettings(defaultOutputDir);
  }

  get(): Settings {
    const rows = this.db.select().from(settingsTable).all();
    const merged: Record<string, unknown> = { ...this.defaults };
    const shape = settingsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
    for (const row of rows) {
      const field = shape[row.key];
      if (!field) continue;
      try {
        const parsed = field.safeParse(JSON.parse(row.valueJson));
        if (parsed.success) merged[row.key] = parsed.data;
      } catch {
        /* keep default */
      }
    }
    return settingsSchema.parse(merged);
  }

  update(patch: SettingsPatch): Settings {
    const valid = settingsPatchSchema.parse(patch);
    this.write(valid);
    return this.get();
  }

  /** Only for main-process callers that already validated the path (native dialog). */
  setOutputDir(dir: string): Settings {
    this.write({ outputDir: settingsSchema.shape.outputDir.parse(dir) });
    return this.get();
  }

  private write(values: Record<string, unknown>): void {
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const valueJson = JSON.stringify(value);
        tx.insert(settingsTable)
          .values({ key, valueJson, updatedAt: now })
          .onConflictDoUpdate({ target: settingsTable.key, set: { valueJson, updatedAt: now } })
          .run();
      }
    });
  }
}
