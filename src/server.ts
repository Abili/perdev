// Starts local llama.cpp servers (chat + autocomplete) when they aren't already
// running, and stops them when VS Code closes.

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';

interface ServerSpec {
  label: string;
  url: string;
  model: string;
  args: string[];
}

export class LocalServers implements vscode.Disposable {
  private procs: ChildProcess[] = [];
  private output = vscode.window.createOutputChannel('PerDev Servers');

  async ensureRunning(): Promise<void> {
    const c = vscode.workspace.getConfiguration('perdev');
    if (!c.get<boolean>('server.autoStart', true)) return;
    const exe = c.get<string>('server.llamaServerPath', '');
    if (!exe || !fs.existsSync(exe)) {
      this.output.appendLine(`llama-server not found at "${exe}". Set perdev.server.llamaServerPath.`);
      return;
    }
    const device = c.get<string>('server.device', '');
    const common = ['-ngl', '99', ...(device ? ['--device', device] : [])];
    const lora = c.get<string>('server.chatLoraPath', '');
    if (lora && !fs.existsSync(lora)) {
      this.output.appendLine(`chat: LoRA adapter not found at "${lora}"; starting without it.`);
    }
    const loraArgs = lora && fs.existsSync(lora) ? ['--lora', lora] : [];

    const specs: ServerSpec[] = [
      {
        label: 'chat',
        url: c.get<string>('baseUrl', '').replace(/\/v1\/?$/, ''),
        model: c.get<string>('server.chatModelPath', ''),
        args: ['--jinja', '-c', String(c.get<number>('server.chatContext', 16384)), '--alias', c.get<string>('chatModel', 'perdev-coder'), ...loraArgs, ...common],
      },
      {
        label: 'autocomplete',
        url: c.get<string>('autocomplete.url', ''),
        model: c.get<string>('server.autocompleteModelPath', ''),
        args: ['-c', '4096', '-np', '1', ...common],
      },
    ];

    for (const s of specs) {
      if (!s.url || !s.model) continue;
      const status = await probe(s.url, s.model);
      if (status === 'ours') {
        this.output.appendLine(`${s.label}: already running at ${s.url}`);
        continue;
      }
      if (status === 'other') {
        const msg = `PerDev: ${s.url} is already used by another program, so the ${s.label} server can't start there. Change the port in PerDev's settings.`;
        this.output.appendLine(msg);
        vscode.window.showWarningMessage(msg);
        continue;
      }
      if (!fs.existsSync(s.model)) {
        // Downloads write to <name>.part and are renamed when complete.
        const note = fs.existsSync(s.model + '.part') ? ' (still downloading)' : '';
        this.output.appendLine(`${s.label}: model file missing${note}: ${s.model}; not starting.`);
        continue;
      }
      const u = new URL(s.url);
      const args = ['-m', s.model, '--host', u.hostname, '--port', u.port || '8780', ...s.args];
      this.output.appendLine(`${s.label}: starting ${exe} ${args.join(' ')}`);
      const p = spawn(exe, args, { windowsHide: true });
      p.stdout?.on('data', (d) => this.output.append(`[${s.label}] ${d}`));
      p.stderr?.on('data', (d) => this.output.append(`[${s.label}] ${d}`));
      p.on('exit', (code) => this.output.appendLine(`${s.label}: exited with code ${code}`));
      this.procs.push(p);
    }
  }

  showLog() {
    this.output.show();
  }

  dispose() {
    for (const p of this.procs) p.kill();
    this.procs = [];
    this.output.dispose();
  }
}

// 'ours': a llama.cpp server already serving this model file; 'free': nothing
// listening; 'other': something else owns the port.
async function probe(base: string, modelPath: string): Promise<'ours' | 'free' | 'other'> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/props`, { signal: AbortSignal.timeout(1500) });
  } catch (e: any) {
    const code = e?.cause?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'free' : e?.name === 'TimeoutError' ? 'other' : 'free';
  }
  try {
    const props: any = await res.json();
    const served = String(props.model_path ?? '').toLowerCase().replace(/\//g, '\\');
    return served && served === modelPath.toLowerCase().replace(/\//g, '\\') ? 'ours' : 'other';
  } catch {
    return 'other';
  }
}
