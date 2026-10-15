import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Runtime node_modules that cannot be bundled by Vite (native addons).
// Everything else is bundled into .vite/build.
const NATIVE_RUNTIME_MODULES = ['better-sqlite3'];

function isIgnored(file: string): boolean {
  if (!file) return false;
  if (file === '/package.json' || file.startsWith('/.vite')) return false;
  if (file === '/node_modules') return false;
  for (const mod of NATIVE_RUNTIME_MODULES) {
    const base = `/node_modules/${mod}`;
    if (file === base) return false;
    if (file.startsWith(`${base}/`)) {
      const rel = file.slice(base.length + 1);
      const keep = rel === 'package.json' || rel === 'LICENSE' || rel.startsWith('lib') || rel.startsWith('prebuilds');
      return !keep;
    }
  }
  return true;
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'BloomRecord',
    executableName: 'bloomrecord',
    appBundleId: 'app.bloomrecord.desktop',
    appCategoryType: 'public.app-category.video',
    icon: 'resources/icons/icon',
    asar: true,
    // FFmpeg/FFprobe for the build target (see scripts/prepare-ffmpeg.mjs).
    extraResource: ['resources/ffmpeg'],
    // macOS privacy usage strings shown in permission prompts.
    extendInfo: {
      NSCameraUsageDescription:
        'BloomRecord uses your camera to record your webcam bubble. Recordings never leave this device.',
      NSMicrophoneUsageDescription:
        'BloomRecord uses your microphone to record narration. Recordings never leave this device.',
    },
    // Keep only the Vite output, package.json and the native runtime modules.
    ignore: isIgnored,
  },
  rebuildConfig: {
    // better-sqlite3 ships N-API prebuilds; never rebuild it from source.
    ignoreModules: NATIVE_RUNTIME_MODULES,
  },
  hooks: {
    // Drop prebuilt binaries for other platforms from the package.
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform, arch) => {
      const dir = path.join(buildPath, 'node_modules', 'better-sqlite3', 'prebuilds');
      if (!fs.existsSync(dir)) throw new Error('better-sqlite3 prebuilds missing from package');
      const keep = `${platform}-${arch}.node`;
      for (const f of fs.readdirSync(dir)) if (f !== keep) fs.rmSync(path.join(dir, f));
      if (!fs.existsSync(path.join(dir, keep))) throw new Error(`No better-sqlite3 prebuild for ${platform}-${arch}`);
    },
    // Refuse to package FFmpeg binaries built for a different target.
    prePackage: async (_config, platform, arch) => {
      const target = JSON.parse(fs.readFileSync('resources/ffmpeg/target.json', 'utf8'));
      if (target.platform !== platform || target.arch !== arch) {
        throw new Error(
          `resources/ffmpeg contains ${target.platform}-${target.arch} binaries but packaging ${platform}-${arch}. ` +
            'Run scripts/prepare-ffmpeg.mjs with BLOOM_TARGET_PLATFORM/BLOOM_TARGET_ARCH.',
        );
      }
    },
  },
  makers: [
    new MakerSquirrel({ name: 'BloomRecord', setupIcon: 'resources/icons/icon.ico' }),
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    new MakerDMG({ icon: 'resources/icons/icon.icns' }, ['darwin']),
    new MakerDeb({ options: { icon: 'resources/icons/icon.png', categories: ['AudioVideo', 'Video'] } }),
    new MakerRpm({ options: { icon: 'resources/icons/icon.png', categories: ['AudioVideo', 'Video'] } }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'electron/main.ts', config: 'vite.main.config.mts', target: 'main' },
        { entry: 'electron/preload.ts', config: 'vite.preload.config.mts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
