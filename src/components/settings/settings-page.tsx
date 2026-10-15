import { useEffect, useState } from 'react';
import { Brush, FolderOpen, HardDrive, Info, Laptop, Moon, ShieldCheck, Sun, Video, Wrench } from 'lucide-react';
import type { Diagnostics, FrameRate, QualityPreset, ResolutionPreset } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { useLibraryStats } from '@/hooks/use-library';
import { useDevices } from '@/hooks/use-media';
import { useAppStore } from '@/stores/app-store';
import { toast } from '@/stores/toast-store';
import { formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/overlays';
import { Card, Label, Segmented, Switch } from '@/components/ui/primitives';
import { BubblePositionPicker } from '@/components/recorder/media-bits';
import { BackgroundPicker } from '@/components/recorder/background-picker';

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h2>
      <div className="flex flex-col divide-y">{children}</div>
    </Card>
  );
}

function Row({ label, hint, children, htmlFor }: { label: string; hint?: React.ReactNode; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings)!;
  const update = useAppStore((s) => s.updateSettings);
  const devices = useDevices();
  const stats = useLibraryStats();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const loadDiag = () => bloom.settings.diagnostics().then(setDiag).catch(() => {});
  useEffect(() => {
    void loadDiag();
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">All settings are stored locally on this device.</p>
      </header>

      <Section icon={<FolderOpen />} title="Storage">
        <Row label="Recordings folder" hint={<span data-selectable>{settings.outputDir}</span>}>
          <Button variant="ghost" size="sm" onClick={() => bloom.settings.openOutputDir().catch((err) => toast.error(errorMessage(err)))}>
            Open
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const next = await bloom.settings.chooseOutputDir();
                if (next) useAppStore.getState().setSettings(next);
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Change…
          </Button>
        </Row>
        <Row
          label="Storage usage"
          hint={stats ? `${stats.recordingCount} recordings · ${formatBytes(stats.totalBytes)} used · ${stats.freeBytes != null ? `${formatBytes(stats.freeBytes)} free` : 'free space unknown'}` : '—'}
        >
          <HardDrive className="size-4 text-muted-foreground" />
        </Row>
        <Row label="Temporary files" hint={diag ? `${formatBytes(diag.tempBytes)} of raw capture data (recoverable sessions are never removed)` : '—'}>
          <Button
            variant="outline"
            size="sm"
            disabled={cleaning}
            onClick={async () => {
              setCleaning(true);
              try {
                const r = await bloom.settings.cleanupTemp();
                toast.success(r.removedFiles ? `Removed ${r.removedFiles} files (${formatBytes(r.freedBytes)}).` : 'Nothing to clean up.');
                void loadDiag();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setCleaning(false);
              }
            }}
          >
            Clean up
          </Button>
        </Row>
      </Section>

      <Section icon={<Video />} title="Recording defaults">
        <Row label="Resolution" hint="Recordings are never upscaled.">
          <Select<ResolutionPreset>
            ariaLabel="Default resolution"
            className="w-36"
            value={settings.resolution}
            onValueChange={(v) => void update({ resolution: v })}
            options={[
              { value: '720p', label: '720p' },
              { value: '1080p', label: '1080p' },
              { value: '1440p', label: '1440p' },
              { value: '2160p', label: '4K' },
              { value: 'native', label: 'Native' },
            ]}
          />
        </Row>
        <Row label="Frame rate">
          <Select
            ariaLabel="Default frame rate"
            className="w-36"
            value={String(settings.frameRate)}
            onValueChange={(v) => void update({ frameRate: Number(v) as FrameRate })}
            options={[15, 24, 30, 60].map((f) => ({ value: String(f), label: `${f} fps` }))}
          />
        </Row>
        <Row label="Video quality" hint="Higher quality produces larger files.">
          <Select<QualityPreset>
            ariaLabel="Video quality"
            className="w-36"
            value={settings.quality}
            onValueChange={(v) => void update({ quality: v })}
            options={[
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Small file' },
            ]}
          />
        </Row>
        <Row label="Camera">
          <Select
            ariaLabel="Default camera"
            className="w-56"
            value={settings.cameraDeviceId ?? 'default'}
            onValueChange={(v) => void update({ cameraDeviceId: v === 'default' ? null : v })}
            options={[{ value: 'default', label: 'Default camera' }, ...devices.cameras.map((d) => ({ value: d.deviceId, label: d.label }))]}
          />
        </Row>
        <Row label="Microphone">
          <Select
            ariaLabel="Default microphone"
            className="w-56"
            value={settings.micDeviceId ?? 'default'}
            onValueChange={(v) => void update({ micDeviceId: v === 'default' ? null : v })}
            options={[
              { value: 'default', label: 'Default microphone' },
              ...devices.microphones.filter((d) => d.deviceId !== 'default').map((d) => ({ value: d.deviceId, label: d.label })),
              { value: 'none', label: 'No microphone' },
            ]}
          />
        </Row>
        <Row label="Webcam bubble" hint="Size and corner of the circular camera overlay.">
          <Segmented
            ariaLabel="Default bubble size"
            value={settings.bubbleSize}
            onChange={(v) => void update({ bubbleSize: v })}
            options={[
              { value: 'small', label: 'S' },
              { value: 'medium', label: 'M' },
              { value: 'large', label: 'L' },
            ]}
          />
          <BubblePositionPicker value={settings.bubblePosition} onChange={(p) => void update({ bubblePosition: p })} />
        </Row>
        <div className="flex flex-col gap-3 py-3">
          <div>
            <Label>Camera background</Label>
            <div className="mt-1 text-xs text-muted-foreground">Blur or replace what's behind you. Runs entirely on this computer.</div>
          </div>
          <BackgroundPicker settings={settings} />
        </div>
        <Row label="Countdown before recording" htmlFor="countdown">
          <Select
            id="countdown"
            ariaLabel="Countdown"
            className="w-28"
            value={String(settings.countdownSeconds)}
            onValueChange={(v) => void update({ countdownSeconds: Number(v) })}
            options={[0, 3, 5, 10].map((n) => ({ value: String(n), label: n === 0 ? 'Off' : `${n} s` }))}
          />
        </Row>
        <Row label="Minimize window while recording the screen" htmlFor="minimize">
          <Switch id="minimize" checked={settings.minimizeOnRecord} onCheckedChange={(v) => void update({ minimizeOnRecord: v })} />
        </Row>
      </Section>

      <Section icon={<Brush />} title="Appearance">
        <Row label="Theme">
          <Segmented
            ariaLabel="Theme"
            value={settings.theme}
            onChange={(v) => void update({ theme: v })}
            options={[
              { value: 'system', label: 'System', icon: <Laptop /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'dark', label: 'Dark', icon: <Moon /> },
            ]}
          />
        </Row>
      </Section>

      <Section icon={<ShieldCheck />} title="Privacy">
        <div className="text-sm leading-relaxed text-muted-foreground">
          <p>
            BloomRecord is fully local. Your recordings, thumbnails, library database and settings never leave this computer. The app makes no network
            requests: there is no account, no cloud storage, no license check, and no analytics or telemetry. Camera, microphone and screen are only accessed
            while you are setting up or making a recording.
          </p>
        </div>
      </Section>

      <Section icon={<Wrench />} title="About & diagnostics">
        {diag ? (
          <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1.5 py-1 text-xs" data-selectable>
            <dt className="text-muted-foreground">Version</dt>
            <dd>{diag.appVersion}</dd>
            <dt className="text-muted-foreground">Platform</dt>
            <dd>
              {diag.platform} ({diag.arch})
            </dd>
            <dt className="text-muted-foreground">Electron / Chromium</dt>
            <dd>
              {diag.electron} / {diag.chrome}
            </dd>
            <dt className="text-muted-foreground">FFmpeg</dt>
            <dd className="truncate" title={diag.ffmpegVersion ?? ''}>
              {diag.ffmpegVersion ?? 'not found'}
            </dd>
            <dt className="text-muted-foreground">FFprobe</dt>
            <dd className="truncate">{diag.ffprobeVersion ?? 'not found'}</dd>
            <dt className="text-muted-foreground">App data</dt>
            <dd className="truncate" title={diag.userDataDir}>
              {diag.userDataDir}
            </dd>
            <dt className="text-muted-foreground">Database</dt>
            <dd className="truncate" title={diag.databasePath}>
              {diag.databasePath}
            </dd>
          </dl>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5" /> Loading…
          </p>
        )}
      </Section>
    </div>
  );
}
