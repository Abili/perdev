// Starts local llama.cpp servers (autocomplete + chat) when they aren't already
// running, and stops them when VS Code closes. Servers start one at a time,
// smallest first, so they don't compete for the disk, and a status bar item
// shows progress.

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';

interface ServerSpec {
  label: string;
  url: string;
  model: string;
  args: string[];
}

const LOAD_TIMEOUT_MS = 180_000;

export class LocalServers implements vscode.Disposable {
  private procs: ChildProcess[] = [];
  private output = vscode.window.createOutputChannel('PerDev Servers');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.status.command = 'perdev.startServers';
  }

  async ensureRunning(): Promise<void> {
    const c = vscode.workspace.getConfiguration('perdev');
    if (!c.get<boolean>('server.autoStart', true)) return;
    const exe = c.get<string>('server.llamaServerPath', '');
    if (!exe || !fs.existsSync(exe)) {
      this.output.appendLine(`llama-server not found at "${exe}". Set perdev.server.llamaServerPath.`);
      this.setStatus('error', 'llama-server not found (see PerDev settings)');
      return;
    }
    const device = c.get<string>('server.device', '');
    const common = ['-ngl', '99', ...(device ? ['--device', device] : [])];
    const lora = c.get<string>('server.chatLoraPath', '');
    if (lora && !fs.existsSync(lora)) {
      this.output.appendLine(`chat: LoRA adapter not found at "${lora}"; starting without it.`);
    }
    const loraArgs = lora && fs.existsSync(lora) ? ['--lora', lora] : [];

    // Small autocomplete model first: it's ready in seconds and is what you notice while typing.
    const specs: ServerSpec[] = [
      {
        label: 'autocomplete',
        url: c.get<string>('autocomplete.url', ''),
        model: c.get<string>('server.autocompleteModelPath', ''),
        args: ['-c', '4096', '-np', '1', ...common],
      },
      {
        label: 'chat',
        url: c.get<string>('baseUrl', '').replace(/\/v1\/?$/, ''),
        model: c.get<string>('server.chatModelPath', ''),
        args: ['--jinja', '-c', String(c.get<number>('server.chatContext', 16384)), '--alias', c.get<string>('chatModel', 'perdev-coder'), ...loraArgs, ...common],
      },
    ];

    const problems: string[] = [];
    for (const s of specs) {
      if (!s.url || !s.model) continue;
      const state = await probe(s.url, s.model);
      if (state === 'ours') {
        this.output.appendLine(`${s.label}: already running at ${s.url}`);
        continue;
      }
      if (state === 'loading') {
        this.setStatus('loading', `loading ${s.label} model…`);
        if (!(await waitReady(s.url, LOAD_TIMEOUT_MS))) problems.push(`${s.label} did not finish loading`);
        continue;
      }
      if (state === 'other') {
        const msg = `PerDev: ${s.url} is already used by another program, so the ${s.label} server can't start there. Change the port in PerDev's settings.`;
        this.output.appendLine(msg);
        vscode.window.showWarningMessage(msg);
        problems.push(`${s.label} port in use`);
        continue;
      }
      if (!fs.existsSync(s.model)) {
        // Downloads write to <name>.part and are renamed when complete.
        const note = fs.existsSync(s.model + '.part') ? ' (still downloading)' : '';
        this.output.appendLine(`${s.label}: model file missing${note}: ${s.model}; not starting.`);
        problems.push(`${s.label} model missing${note}`);
        continue;
      }
      const u = new URL(s.url);
      const args = ['-m', s.model, '--host', u.hostname, '--port', u.port || '8780', ...s.args];
      this.output.appendLine(`${s.label}: starting ${exe} ${args.join(' ')}`);
      this.setStatus('loading', `loading ${s.label} model…`);
      const started = Date.now();
      const p = spawn(exe, args, { windowsHide: true });
      p.stdout?.on('data', (d) => this.output.append(`[${s.label}] ${d}`));
      p.stderr?.on('data', (d) => this.output.append(`[${s.label}] ${d}`));
      p.on('exit', (code) => this.output.appendLine(`${s.label}: exited with code ${code}`));
      this.procs.push(p);
      if (await waitReady(s.url, LOAD_TIMEOUT_MS, p)) {
        this.output.appendLine(`${s.label}: ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } else {
        problems.push(`${s.label} failed to start`);
      }
    }
    if (problems.length) this.setStatus('error', problems.join('; '));
    else this.setStatus('ready', 'local AI ready');
  }

  private setStatus(kind: 'loading' | 'ready' | 'error', detail: string) {
    const icon = kind === 'loading' ? '$(sync~spin)' : kind === 'ready' ? '$(check)' : '$(warning)';
    this.status.text = `${icon} PerDev${kind === 'loading' ? ': loading AI' : ''}`;
    this.status.tooltip = `PerDev: ${detail}. Click to start the local model servers again.`;
    this.status.show();
  }

  showLog() {
    this.output.show();
  }

  dispose() {
    for (const p of this.procs) p.kill();
    this.procs = [];
    this.output.dispose();
    this.status.dispose();
  }
}

// 'ours': a llama.cpp server already serving this model file; 'loading': a
// llama.cpp server still loading a model; 'free': nothing listening; 'other':
// something else owns the port.
async function probe(base: string, modelPath: string): Promise<'ours' | 'loading' | 'free' | 'other'> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/props`, { signal: AbortSignal.timeout(1500) });
  } catch (e: any) {
    const code = e?.cause?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'free' : e?.name === 'TimeoutError' ? 'other' : 'free';
  }
  try {
    const props: any = await res.json();
    if (res.status === 503 && /loading/i.test(JSON.stringify(props))) return 'loading';
    const served = String(props.model_path ?? '').toLowerCase().replace(/\//g, '\\');
    return served && served === modelPath.toLowerCase().replace(/\//g, '\\') ? 'ours' : 'other';
  } catch {
    return 'other';
  }
}

// Polls llama.cpp's /health until the model is loaded (200), the process exits, or time runs out.
async function waitReady(base: string, timeoutMs: number, proc?: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) return false;
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
