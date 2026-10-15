import { useEffect, useMemo, useState } from 'react';
import { Camera, FolderOpen, Info, Mic, Monitor, MonitorPlay, Pause, Play, Square, Trash2, TriangleAlert, Video, X } from 'lucide-react';
import type { CaptureSource, FrameRate, RecordingMode, ResolutionPreset } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { useAudioLevel, useDeviceStream, useDevices } from '@/hooks/use-media';
import { useAppStore } from '@/stores/app-store';
import { useRecorderStore } from '@/stores/recorder-store';
import { toast } from '@/stores/toast-store';
import { cn, formatDuration } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Select, Tooltip } from '@/components/ui/overlays';
import { Badge, Card, Kbd, Label, Segmented, Switch } from '@/components/ui/primitives';
import { SourcePicker } from './source-picker';
import { BubblePositionPicker, CompositionPreview, MicMeter, PermissionNotice, StreamVideo } from './media-bits';

const NO_MIC = 'none';
const DEFAULT_DEVICE = 'default';
const isMac = navigator.userAgent.includes('Mac');
const MOD = isMac ? '⌘' : 'Ctrl';

export function RecorderPage() {
  const phase = useRecorderStore((s) => s.phase);
  const error = useRecorderStore((s) => s.error);
  const clearError = useRecorderStore((s) => s.clearError);
  const settings = useAppStore((s) => s.settings)!;
  const platform = useAppStore((s) => s.platform);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [mode, setMode] = useState<RecordingMode>(settings.defaultMode);
  const [source, setSource] = useState<CaptureSource | null>(null);
  const usesCamera = mode !== 'screen';
  const micId = settings.micDeviceId;
  const micEnabled = micId !== NO_MIC;
  const inSetup = phase === 'setup';

  // Live preview streams double as the recording streams, so the camera stays
  // warm and starts instantly. They are released when leaving this page.
  const camera = useDeviceStream('camera', usesCamera, settings.cameraDeviceId, mode === 'camera');
  const mic = useDeviceStream('mic', micEnabled, micId);
  const level = useAudioLevel(mic.stream);
  const devices = useDevices(`${camera.stream?.id ?? ''}${mic.stream?.id ?? ''}`);

  const [screenPermission, setScreenPermission] = useState<string>('granted');
  useEffect(() => {
    if (platform?.platform === 'darwin') bloom.capture.permissionStatus('screen').then(setScreenPermission).catch(() => {});
  }, [platform]);

  const cameraOptions = useMemo(
    () => [{ value: DEFAULT_DEVICE, label: 'Default camera' }, ...devices.cameras.map((d) => ({ value: d.deviceId, label: d.label }))],
    [devices.cameras],
  );
  const micOptions = useMemo(
    () => [
      { value: DEFAULT_DEVICE, label: 'Default microphone' },
      ...devices.microphones.filter((d) => d.deviceId !== 'default').map((d) => ({ value: d.deviceId, label: d.label })),
      { value: NO_MIC, label: 'No microphone' },
    ],
    [devices.microphones],
  );

  const canStart =
    inSetup &&
    (mode === 'camera' ? !!camera.stream : !!source) &&
    (mode !== 'screen-camera' || !!camera.stream) &&
    (!micEnabled || !!mic.stream || !!mic.error);

  const start = () => {
    if (!canStart) return;
    void useRecorderStore.getState().begin({
      mode,
      sourceId: mode === 'camera' ? null : (source?.id ?? null),
      sourceName: mode === 'camera' ? null : (source?.name ?? null),
      systemAudio: mode !== 'camera' && settings.systemAudio && !!platform?.systemAudio,
      camera: usesCamera ? camera.stream : null,
      mic: micEnabled ? mic.stream : null,
      resolution: settings.resolution,
      frameRate: settings.frameRate,
      quality: settings.quality,
      bubblePosition: settings.bubblePosition,
      bubbleSize: settings.bubbleSize,
      countdownSeconds: settings.countdownSeconds,
    });
  };

  if (!inSetup) return <RecordingStage camera={usesCamera ? camera.stream : null} micLevel={micEnabled ? level : null} />;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New recording</h1>
          <p className="text-sm text-muted-foreground">Choose what to capture, check your camera and mic, then hit record.</p>
        </div>
        <Segmented<RecordingMode>
          ariaLabel="Recording mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            void updateSettings({ defaultMode: m });
          }}
          options={[
            { value: 'screen-camera', label: 'Screen + Camera', icon: <MonitorPlay /> },
            { value: 'screen', label: 'Screen only', icon: <Monitor /> },
            { value: 'camera', label: 'Camera only', icon: <Camera /> },
          ]}
        />
      </header>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="flex-1" data-selectable>
            {error}
          </p>
          <button type="button" aria-label="Dismiss" onClick={clearError}>
            <X className="size-4 opacity-60" />
          </button>
        </div>
      )}
      {platform?.platform === 'darwin' && mode !== 'camera' && screenPermission !== 'granted' && (
        <PermissionNotice kind="screen" platform="darwin" message={platform.screenPermissionNote ?? ''} />
      )}
      {camera.denied && usesCamera && <PermissionNotice kind="camera" platform={platform?.platform} message={camera.error ?? ''} />}
      {mic.denied && micEnabled && <PermissionNotice kind="microphone" platform={platform?.platform} message={mic.error ?? ''} />}

      <div className="grid grid-cols-[1fr_340px] gap-6">
        <div className="flex flex-col gap-4">
          {mode === 'camera' ? (
            <Card className="overflow-hidden">
              <div className="relative aspect-video bg-black">
                <StreamVideo stream={camera.stream} mirrored className="size-full object-contain" />
                {!camera.stream && <CameraPlaceholder loading={camera.loading} error={camera.denied ? null : camera.error} />}
              </div>
            </Card>
          ) : (
            <Card className="p-4">
              <SourcePicker value={source} onChange={setSource} platform={platform} />
            </Card>
          )}
          {mode !== 'camera' && source && source.thumbnailDataUrl && (
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Preview</h2>
                <span className="truncate text-xs text-muted-foreground">{source.name}</span>
              </div>
              <CompositionPreview
                screen={<img src={source.thumbnailDataUrl} alt="" className="size-full object-contain" />}
                camera={mode === 'screen-camera' ? camera.stream : null}
                bubblePosition={settings.bubblePosition}
                bubbleSize={settings.bubbleSize}
              />
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {usesCamera && (
            <Card className="flex flex-col gap-3 p-4">
              <Label htmlFor="camera-select" className="flex items-center gap-2">
                <Video className="size-4 text-muted-foreground" /> Camera
              </Label>
              {mode === 'screen-camera' && (
                <div className="flex items-center gap-4">
                  <div className="relative size-24 shrink-0 overflow-hidden rounded-full bg-muted ring-2 ring-border">
                    <StreamVideo stream={camera.stream} mirrored className="size-full object-cover" />
                    {!camera.stream && <CameraPlaceholder loading={camera.loading} compact />}
                  </div>
                  <p className="text-xs text-muted-foreground">{camera.error && !camera.denied ? camera.error : 'Your camera appears as a round bubble on the recording.'}</p>
                </div>
              )}
              <Select
                id="camera-select"
                ariaLabel="Camera"
                value={settings.cameraDeviceId ?? DEFAULT_DEVICE}
                onValueChange={(v) => void updateSettings({ cameraDeviceId: v === DEFAULT_DEVICE ? null : v })}
                options={cameraOptions}
              />
            </Card>
          )}

          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="mic-select" className="flex items-center gap-2">
                <Mic className="size-4 text-muted-foreground" /> Microphone
              </Label>
              <MicMeter level={level} muted={!micEnabled || !mic.stream} />
            </div>
            <Select
              id="mic-select"
              ariaLabel="Microphone"
              value={micId ?? DEFAULT_DEVICE}
              onValueChange={(v) => void updateSettings({ micDeviceId: v === DEFAULT_DEVICE ? null : v })}
              options={micOptions}
            />
            {mic.error && !mic.denied && <p className="text-xs text-destructive">{mic.error}</p>}
            {mode !== 'camera' && (
              <div className="flex items-start justify-between gap-3 border-t pt-3">
                <div>
                  <Label htmlFor="sys-audio">System audio</Label>
                  <p className="mt-1 text-xs text-muted-foreground">{platform?.systemAudioNote}</p>
                </div>
                <Switch
                  id="sys-audio"
                  checked={settings.systemAudio && !!platform?.systemAudio}
                  disabled={!platform?.systemAudio}
                  onCheckedChange={(v) => void updateSettings({ systemAudio: v })}
                />
              </div>
            )}
          </Card>

          <Card className="flex flex-col gap-4 p-4">
            {mode !== 'camera' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Resolution</Label>
                  <Select<ResolutionPreset>
                    ariaLabel="Resolution"
                    value={settings.resolution}
                    onValueChange={(v) => void updateSettings({ resolution: v })}
                    options={[
                      { value: '720p', label: '720p' },
                      { value: '1080p', label: '1080p' },
                      { value: '1440p', label: '1440p' },
                      { value: '2160p', label: '4K' },
                      { value: 'native', label: 'Native' },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Frame rate</Label>
                  <Select
                    ariaLabel="Frame rate"
                    value={String(settings.frameRate)}
                    onValueChange={(v) => void updateSettings({ frameRate: Number(v) as FrameRate })}
                    options={[15, 24, 30, 60].map((f) => ({ value: String(f), label: `${f} fps` }))}
                  />
                </div>
              </div>
            )}
            {mode === 'screen-camera' && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Bubble size</Label>
                  <Segmented
                    ariaLabel="Bubble size"
                    value={settings.bubbleSize}
                    onChange={(v) => void updateSettings({ bubbleSize: v })}
                    options={[
                      { value: 'small', label: 'S' },
                      { value: 'medium', label: 'M' },
                      { value: 'large', label: 'L' },
                    ]}
                  />
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <Label className="text-xs text-muted-foreground">Position</Label>
                  <BubblePositionPicker value={settings.bubblePosition} onChange={(p) => void updateSettings({ bubblePosition: p })} />
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 border-t pt-3 text-xs">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={settings.outputDir} data-selectable>
                {settings.outputDir}
              </span>
              <Button
                variant="ghost"
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
                Change
              </Button>
            </div>
          </Card>

          <Button size="lg" variant="record" className="h-12 text-base" disabled={!canStart} onClick={start} data-testid="start-recording">
            <span className="size-3 rounded-full bg-white" /> Start recording
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="size-3" /> While recording: <Kbd>{MOD}+Shift+9</Kbd> pause · <Kbd>{MOD}+Shift+0</Kbd> stop
          </p>
        </div>
      </div>
    </div>
  );
}

function CameraPlaceholder({ loading, error, compact }: { loading: boolean; error?: string | null; compact?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-white/70">
      <Camera className={compact ? 'size-5' : 'size-8'} />
      {!compact && <span>{loading ? 'Starting camera…' : (error ?? 'Camera unavailable')}</span>}
    </div>
  );
}

function RecordingStage({ camera, micLevel }: { camera: MediaStream | null; micLevel: number | null }) {
  const { phase, countdown, elapsedMs, screenStream, warnings, mode } = useRecorderStore();
  const settings = useAppStore((s) => s.settings)!;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const recording = phase === 'recording';
  const paused = phase === 'paused';
  const busy = phase === 'stopping' || phase === 'acquiring';

  const stageContent =
    mode === 'camera' ? (
      <StreamVideo stream={camera} mirrored className="size-full object-contain" />
    ) : (
      <StreamVideo stream={screenStream} className="size-full object-contain" />
    );

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="relative min-h-0 flex-1">
        <CompositionPreview
          className="mx-auto h-full max-h-full w-auto max-w-full"
          screen={stageContent}
          camera={mode === 'screen-camera' ? camera : null}
          bubblePosition={settings.bubblePosition}
          bubbleSize={settings.bubbleSize}
        />
        {phase === 'countdown' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 rounded-xl bg-black/60 text-white backdrop-blur-sm">
            <div className="text-8xl font-bold tabular-nums" aria-live="assertive">
              {countdown}
            </div>
            <Button variant="secondary" onClick={() => useRecorderStore.getState().cancelCountdown()}>
              Cancel
            </Button>
          </div>
        )}
        {phase === 'acquiring' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50 text-sm text-white">Preparing capture…</div>
        )}
        {phase === 'stopping' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50 text-sm text-white">Saving recording…</div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {warnings.map((w, i) => (
            <p key={i} className="flex items-center gap-2 text-xs text-warning">
              <TriangleAlert className="size-3.5" /> {w}
            </p>
          ))}
        </div>
      )}

      <Card className="mx-auto flex w-full max-w-2xl items-center gap-4 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={cn('size-3 rounded-full', recording ? 'bg-recording animate-pulse-ring' : paused ? 'bg-warning' : 'bg-muted-foreground')} />
          <div>
            <div className="text-xl font-semibold tabular-nums" data-testid="recording-timer">
              {formatDuration(elapsedMs)}
            </div>
            <Badge tone={recording ? 'recording' : paused ? 'warning' : 'default'}>{recording ? 'Recording' : paused ? 'Paused' : phase === 'countdown' ? 'Starting' : 'Working'}</Badge>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center gap-2">
          <Mic className="size-4 text-muted-foreground" />
          <MicMeter level={paused ? 0 : (micLevel ?? 0)} muted={micLevel === null} />
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content="Discard recording">
            <Button variant="ghost" size="icon" aria-label="Discard recording" disabled={!(recording || paused)} onClick={() => setConfirmDiscard(true)}>
              <Trash2 />
            </Button>
          </Tooltip>
          <Tooltip content={`${paused ? 'Resume' : 'Pause'} (${MOD}+Shift+9)`}>
            <Button variant="outline" size="icon" aria-label={paused ? 'Resume' : 'Pause'} disabled={!(recording || paused) || busy} onClick={() => void useRecorderStore.getState().togglePause()} data-testid="pause-resume">
              {paused ? <Play /> : <Pause />}
            </Button>
          </Tooltip>
          <Tooltip content={`Stop and save (${MOD}+Shift+0)`}>
            <Button variant="record" disabled={!(recording || paused) || busy} onClick={() => void useRecorderStore.getState().stop()} data-testid="stop-recording">
              <Square className="fill-current" /> Stop
            </Button>
          </Tooltip>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this recording?"
        description="Everything captured in this session will be deleted. This cannot be undone."
        confirmLabel="Discard"
        destructive
        onConfirm={() => void useRecorderStore.getState().discard()}
      />
    </div>
  );
}
