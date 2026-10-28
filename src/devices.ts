// Android devices for testing: USB phones and emulators, via the Android SDK's
// own adb and emulator. Can create an emulator from a system image already on
// the PC (no download). No VS Code imports.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { androidSdkDir } from './androidTemplate';

export interface Device {
  serial: string;
  state: string; // device, offline, unauthorized
  model: string;
  kind: 'usb' | 'emulator';
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

function sdkTool(rel: string): string | undefined {
  const sdk = androidSdkDir();
  const p = sdk && path.join(sdk, rel);
  return p && fs.existsSync(p) ? p : undefined;
}

function run(file: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout }, (_e, out) => resolve(String(out ?? ''))));
}

// `adb devices -l` lines like: "R5CY72BFREA  device usb:1-1 product:x model:SM_S938B device:y"
export function parseAdbDevices(out: string): Device[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      const model = (l.match(/model:(\S+)/)?.[1] ?? serial).replace(/_/g, ' ');
      return { serial, state, model, kind: serial.startsWith('emulator-') ? 'emulator' : 'usb' } as Device;
    });
}

export async function listDevices(): Promise<Device[]> {
  const adb = sdkTool(path.join('platform-tools', exe('adb')));
  if (!adb) return [];
  return parseAdbDevices(await run(adb, ['devices', '-l']));
}

export async function listAvds(): Promise<string[]> {
  const emulator = sdkTool(path.join('emulator', exe('emulator')));
  if (!emulator) return [];
  return (await run(emulator, ['-list-avds'])).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.includes(' '));
}

// Starts an emulator window. It keeps running after PerDev closes, like any app.
export function startEmulator(avd: string): boolean {
  const emulator = sdkTool(path.join('emulator', exe('emulator')));
  if (!emulator) return false;
  const p = spawn(emulator, ['-avd', avd, '-no-snapshot-save'], { detached: true, stdio: 'ignore', windowsHide: false });
  p.unref();
  return true;
}

// Waits until a newly started emulator has fully booted.
export async function waitForBoot(timeoutMs = 240_000): Promise<Device | undefined> {
  const adb = sdkTool(path.join('platform-tools', exe('adb')));
  if (!adb) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const emu = (await listDevices()).find((d) => d.kind === 'emulator' && d.state === 'device');
    if (emu && (await run(adb, ['-s', emu.serial, 'shell', 'getprop', 'sys.boot_completed'])).trim() === '1') return emu;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}

export interface SystemImage {
  api: string; // e.g. android-36
  tag: string; // e.g. google_apis_playstore
  abi: string; // e.g. x86_64
  dir: string;
}

// System images already installed in the SDK, best first (newest stable API, x86_64).
export function installedSystemImages(): SystemImage[] {
  const sdk = androidSdkDir();
  const root = sdk && path.join(sdk, 'system-images');
  if (!root || !fs.existsSync(root)) return [];
  const out: SystemImage[] = [];
  for (const api of fs.readdirSync(root)) {
    for (const tag of fs.readdirSync(path.join(root, api))) {
      for (const abi of fs.readdirSync(path.join(root, api, tag))) {
        const dir = path.join(root, api, tag, abi);
        if (fs.existsSync(path.join(dir, 'system.img'))) out.push({ api, tag, abi, dir });
      }
    }
  }
  const apiNum = (a: string) => Number(a.replace(/[^\d.]/g, '')) || 0;
  // Prefer whole API levels (android-36 over preview 36.1) and x86_64.
  return out.sort(
    (a, b) =>
      Number(Number.isInteger(apiNum(b.api))) - Number(Number.isInteger(apiNum(a.api))) ||
      apiNum(b.api) - apiNum(a.api) ||
      Number(b.abi === 'x86_64') - Number(a.abi === 'x86_64'),
  );
}

export const PERDEV_AVD = 'PerDev_Phone';

// Creates an emulator (AVD) from an installed system image, without Android
// Studio's AVD manager. Screen is drawn in software (swiftshader) so it doesn't
// compete with the local AI model for GPU memory.
export function createAvd(img: SystemImage, name = PERDEV_AVD, home = os.homedir()): string {
  const avdRoot = process.env.ANDROID_AVD_HOME || path.join(home, '.android', 'avd');
  const avdDir = path.join(avdRoot, `${name}.avd`);
  fs.mkdirSync(avdDir, { recursive: true });
  const sysdir = `system-images${path.sep}${img.api}${path.sep}${img.tag}${path.sep}${img.abi}${path.sep}`;
  const config: Record<string, string> = {
    AvdId: name,
    'avd.ini.displayname': name.replace(/_/g, ' '),
    'avd.ini.encoding': 'UTF-8',
    'abi.type': img.abi,
    'hw.cpu.arch': img.abi.startsWith('arm') ? 'arm64' : 'x86_64',
    'image.sysdir.1': sysdir,
    'tag.id': img.tag,
    'tag.display': img.tag === 'google_apis_playstore' ? 'Google Play' : img.tag,
    'PlayStore.enabled': String(img.tag.includes('playstore')),
    target: img.api,
    'hw.device.name': 'pixel_7',
    'hw.device.manufacturer': 'Google',
    'hw.lcd.width': '1080',
    'hw.lcd.height': '2400',
    'hw.lcd.density': '420',
    'hw.ramSize': '2048',
    'vm.heapSize': '256',
    'disk.dataPartition.size': '6G',
    'hw.keyboard': 'yes',
    'hw.sensors.orientation': 'yes',
    'hw.accelerometer': 'yes',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'swiftshader_indirect',
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    showDeviceFrame: 'no',
  };
  fs.writeFileSync(path.join(avdDir, 'config.ini'), Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(
    path.join(avdRoot, `${name}.ini`),
    ['avd.ini.encoding=UTF-8', `path=${avdDir}`, `path.rel=avd${path.sep}${name}.avd`, `target=${img.api}`, ''].join('\n'),
  );
  return name;
}
