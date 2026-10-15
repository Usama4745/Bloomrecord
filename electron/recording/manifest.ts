import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { recordingModeSchema, trackKindSchema } from '@shared/validation';

export const MANIFEST_FILE = 'manifest.json';

/**
 * Written next to the raw track files on every state change, atomically.
 * Lets a session be recovered even if its database row is lost.
 */
export const manifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.uuid(),
  status: z.string().max(32),
  mode: recordingModeSchema,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  pauses: z.array(z.object({ startedAt: z.number(), endedAt: z.number().nullable() })).max(10_000),
  options: z.record(z.string(), z.unknown()),
  tracks: z
    .array(
      z.object({
        kind: trackKindSchema,
        file: z.string().max(255),
        mimeType: z.string().max(128),
        offsetMs: z.number().nullable(),
      }),
    )
    .max(4),
});

export type SessionManifest = z.infer<typeof manifestSchema>;

export function writeManifest(dir: string, manifest: SessionManifest): void {
  const target = path.join(dir, MANIFEST_FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, target);
}

export function readManifest(dir: string): SessionManifest | null {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Track files must be plain names inside the session directory.
    if (parsed.data.tracks.some((t) => path.basename(t.file) !== t.file)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
