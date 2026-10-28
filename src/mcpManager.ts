// Runs the MCP servers listed in settings and offers their tools to the agent.
// Servers start on first use and stay up between requests.

import * as fs from 'fs';
import * as path from 'path';
import { ToolSpec } from './llm';
import { McpCallResult, McpClient, McpServerConfig, toToolSpecs } from './mcp';

export interface ExtraTools {
  specs: ToolSpec[];
  has(name: string): boolean;
  call(name: string, rawArgs: string): Promise<McpCallResult>;
  needsApproval(name: string): boolean;
  // Only looks (e.g. ui_tree); anything else may change the device or project.
  isReadOnly(name: string): boolean;
  // Extra system-prompt guidance for the tools on offer.
  notes: string;
}

// The local model works much better with fewer tools, so servers can list the
// ones to offer. DroidLoop's core build/run/see/drive/diagnose loop:
export const DEFAULT_TOOL_SETS: Record<string, string[]> = {
  droidloop: ['list_devices', 'start_emulator', 'build', 'install', 'launch', 'ui_tree', 'tap', 'type_text', 'press_key', 'scroll', 'wait_for', 'logcat', 'app_state', 'screenshot'],
};

// After these actions PerDev reads the screen (ui_tree) and attaches it to the
// result. Measured on the local 7B: told to call ui_tree after launch, it still
// answered "it's showing MainActivity" without looking, 4/4 times.
export const DEFAULT_OBSERVE_AFTER: Record<string, string[]> = {
  droidloop: ['launch', 'tap', 'long_press', 'type_text', 'press_key', 'scroll', 'swipe'],
};

// Tools that only look, never change anything: no need to ask first.
export const DEFAULT_READ_ONLY: Record<string, string[]> = {
  droidloop: ['list_devices', 'ui_tree', 'screenshot', 'logcat', 'app_state', 'wait_for', 'list_flows'],
};

const ANDROID_MARKERS = ['gradlew', 'gradlew.bat', 'settings.gradle', 'settings.gradle.kts', 'app/src/main/AndroidManifest.xml', 'AndroidManifest.xml'];

export function isAndroidProject(root: string): boolean {
  return ANDROID_MARKERS.some((m) => fs.existsSync(path.join(root, m)));
}

export class McpManager {
  private clients = new Map<string, McpClient>();

  constructor(private readonly log: (line: string) => void) {}

  // Tools for one agent request: starts the servers that apply to this workspace.
  async toolsFor(
    root: string,
    servers: Record<string, McpServerConfig & { tools?: string[]; readOnlyTools?: string[]; observeAfter?: string[] }>,
    userText: string,
  ): Promise<ExtraTools | undefined> {
    const byTool = new Map<string, { client: McpClient; approve: boolean; observe: boolean; readOnly: boolean }>();
    const specs: ToolSpec[] = [];
    const noteParts: string[] = [];
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (!cfg || cfg.enabled === false || !cfg.command) continue;
      const when = cfg.when ?? 'always';
      if (when === 'android' && !isAndroidProject(root) && !/\b(android|emulator|apk|phone|device|adb)\b/i.test(userText)) continue;
      let client = this.clients.get(name);
      try {
        if (!client) {
          client = new McpClient(name, { cwd: root, ...cfg }, this.log);
          this.clients.set(name, client);
        }
        if (!client.running) await client.start();
      } catch (e: any) {
        this.log(`[${name}] could not start: ${e?.message ?? e}`);
        continue;
      }
      const allow = cfg.tools ?? DEFAULT_TOOL_SETS[name];
      const offered = client.tools.filter((t) => !allow || allow.includes(t.name)).filter((t) => !byTool.has(t.name));
      const readOnly = cfg.readOnlyTools ?? DEFAULT_READ_ONLY[name] ?? [];
      const canObserve = client.tools.some((t) => t.name === 'ui_tree');
      const observeAfter = cfg.observeAfter ?? DEFAULT_OBSERVE_AFTER[name] ?? [];
      for (const t of offered) {
        byTool.set(t.name, {
          client,
          approve: cfg.approve !== false && !readOnly.includes(t.name),
          observe: canObserve && observeAfter.includes(t.name),
          readOnly: readOnly.includes(t.name),
        });
      }
      specs.push(...toToolSpecs(offered));
      if (client.instructions) noteParts.push(client.instructions.trim());
      if (offered.some((t) => t.name === 'ui_tree')) noteParts.push(ANDROID_NOTES);
    }
    if (specs.length === 0) return undefined;
    return {
      specs,
      notes: noteParts.join('\n\n'),
      has: (n) => byTool.has(n),
      needsApproval: (n) => byTool.get(n)?.approve ?? true,
      isReadOnly: (n) => byTool.get(n)?.readOnly ?? false,
      call: async (n, rawArgs) => {
        const entry = byTool.get(n)!;
        let args: Record<string, unknown> = {};
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {
          return { text: `arguments were not valid JSON: ${rawArgs}`, images: [], isError: true };
        }
        if (!entry.client.running) await entry.client.start();
        const result = await entry.client.callTool(n, args);
        if (!entry.observe || result.isError) return result;
        // Let the screen settle briefly, then show the model what it now looks like.
        await new Promise((r) => setTimeout(r, 400));
        try {
          const screen = await entry.client.callTool('ui_tree', args.device ? { device: args.device } : {});
          if (!screen.isError && screen.text) result.text = `${result.text}\n\nScreen now (ui_tree):\n${screen.text}`;
        } catch {
          // keep the action's own result
        }
        return result;
      },
    };
  }

  dispose() {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}

// How to use the Android tools well (adapted from DroidLoop's README tips).
const ANDROID_NOTES = `Android device tools (emulator or USB device):
- Loop: build -> install -> launch -> ui_tree -> tap/type_text -> wait_for -> logcat (crashesOnly) to check, fix and repeat.
- launch only starts the app; it does not tell you what is on the screen. To know what the screen shows, call ui_tree (text, with element ids and tap targets). You cannot see screenshots; they are only for the user.
- When the user asks you to do something in a running app (open a screen, add an item, press a button), operate the app's UI with ui_tree, tap and type_text. Only change the code if they ask for a code change.
- Element ids come from the latest ui_tree; call ui_tree again after the screen changes.
- If no device is connected, use list_devices, then start_emulator.`;
