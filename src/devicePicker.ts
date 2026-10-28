// Status bar device picker: which phone or emulator the agent builds, installs
// and tests on. Shown in Android projects.

import * as vscode from 'vscode';
import { createAvd, Device, installedSystemImages, listAvds, listDevices, PERDEV_AVD, startEmulator, waitForBoot } from './devices';
import { isAndroidProject } from './mcpManager';

const KEY = 'perdev.device';

export interface SelectedDevice {
  serial: string;
  label: string;
}

export class DevicePicker implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item.command = 'perdev.selectDevice';
    context.subscriptions.push(vscode.commands.registerCommand('perdev.selectDevice', () => this.pick()));
    void this.refresh();
  }

  // The device the agent should use, if it is still connected.
  async selected(): Promise<SelectedDevice | undefined> {
    const saved = this.context.globalState.get<SelectedDevice>(KEY);
    const devices = await listDevices();
    const ready = devices.filter((d) => d.state === 'device');
    if (saved && ready.some((d) => d.serial === saved.serial)) return saved;
    // Nothing chosen (or it went away): use the only connected device, if there is one.
    if (ready.length === 1) return { serial: ready[0].serial, label: describe(ready[0]) };
    return undefined;
  }

  async refresh() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || !isAndroidProject(root)) {
      this.item.hide();
      return;
    }
    const d = await this.selected();
    this.item.text = d ? `$(device-mobile) ${d.label}` : '$(device-mobile) Choose a device';
    this.item.tooltip = d ? `PerDev tests the app on ${d.label} (${d.serial}). Click to change.` : 'Choose the phone or emulator PerDev tests the app on';
    this.item.show();
  }

  async pick() {
    const [devices, avds] = await Promise.all([listDevices(), listAvds()]);
    const running = new Set(devices.filter((d) => d.kind === 'emulator').map((d) => d.model));
    type Item = vscode.QuickPickItem & { run: () => Promise<void> };
    const items: Item[] = [];
    for (const d of devices) {
      items.push({
        label: `$(${d.kind === 'usb' ? 'device-mobile' : 'vm'}) ${describe(d)}`,
        description: d.state === 'device' ? d.serial : `${d.serial} · ${d.state}`,
        detail: d.state === 'unauthorized' ? 'Allow USB debugging on the phone (check its screen), then refresh.' : undefined,
        run: async () => this.save({ serial: d.serial, label: describe(d) }),
      });
    }
    for (const avd of avds.filter((a) => !running.has(a))) {
      items.push({ label: `$(play) Start emulator: ${avd.replace(/_/g, ' ')}`, run: () => this.boot(avd) });
    }
    const img = installedSystemImages()[0];
    if (!avds.length && img) {
      items.push({
        label: '$(add) Create an emulator',
        description: `${img.api.replace('android-', 'Android ')}, from the system image already on this PC (no download)`,
        run: async () => {
          createAvd(img);
          await this.boot(PERDEV_AVD);
        },
      });
    }
    items.push({ label: '$(refresh) Refresh', run: () => this.pick() });
    if (!devices.length && !avds.length && !img) {
      items.unshift({
        label: '$(info) No phone or emulator found',
        detail: 'Connect a phone with USB debugging on, or install an Android system image in Android Studio.',
        run: async () => {},
      });
    }
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Where should PerDev run and test the app?' });
    await choice?.run();
  }

  private async boot(avd: string) {
    if (!startEmulator(avd)) {
      vscode.window.showErrorMessage('PerDev could not find the Android emulator in the SDK.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting ${avd.replace(/_/g, ' ')}… (the first boot takes a few minutes)` },
      async () => {
        const emu = await waitForBoot();
        if (emu) await this.save({ serial: emu.serial, label: avd.replace(/_/g, ' ') });
        else vscode.window.showWarningMessage('The emulator is taking long to start. Check its window, then choose it from the device list.');
      },
    );
  }

  private async save(d: SelectedDevice) {
    await this.context.globalState.update(KEY, d);
    await this.refresh();
  }

  dispose() {
    this.item.dispose();
  }
}

function describe(d: Device): string {
  return d.kind === 'emulator' ? `Emulator (${d.serial})` : d.model;
}
