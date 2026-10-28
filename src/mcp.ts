// A small MCP (Model Context Protocol) client over stdio, so tools from MCP
// servers (e.g. DroidLoop for Android emulators) become PerDev agent tools.
// No dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0.

import { ChildProcess, spawn } from 'child_process';
import { ToolSpec } from './llm';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  // Ask before each call (default true). Turn off for servers you trust.
  approve?: boolean;
  // When to offer its tools: always, or only in matching workspaces (see McpManager).
  when?: 'always' | 'android';
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface McpCallResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private stderrTail = '';
  instructions = '';
  tools: McpTool[] = [];

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly log: (line: string) => void = () => {},
  ) {}

  get running() {
    return !!this.proc && this.proc.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const p = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = p;
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => this.onData(chunk));
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
      this.log(`[${this.name}] ${d.trimEnd()}`);
    });
    p.on('exit', (code) => {
      this.log(`[${this.name}] exited with code ${code}`);
      for (const [, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new Error(`MCP server "${this.name}" exited (code ${code}). ${this.stderrTail.trim().slice(-300)}`));
      }
      this.pending.clear();
    });
    p.on('error', (e) => this.log(`[${this.name}] failed to start: ${e.message}`));

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'PerDev', version: '0.1.0' },
    }, 30_000);
    this.instructions = typeof init?.instructions === 'string' ? init.instructions : '';
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 30_000);
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    this.log(`[${this.name}] ready with ${this.tools.length} tools`);
  }

  // Long-running tools (Gradle builds, emulator boot) pass their own timeoutSec.
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const own = Number((args as any)?.timeoutSec);
    const timeoutMs = Math.max(Number.isFinite(own) ? (own + 60) * 1000 : 0, 300_000);
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content: any[] = Array.isArray(r?.content) ? r.content : [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const images = content.filter((c) => c.type === 'image' && c.data).map((c) => ({ data: c.data, mimeType: c.mimeType || 'image/png' }));
    return { text, images, isError: !!r?.isError };
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }

  private request(method: string, params: object, timeoutMs: number): Promise<any> {
    if (!this.proc?.stdin) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.name}" did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: object) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`[${this.name}] non-JSON output: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const w = this.pending.get(msg.id);
        if (!w) continue;
        this.pending.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(`MCP error from "${this.name}": ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else w.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // Server-to-client requests (sampling, roots...) aren't supported: say so.
        this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by PerDev' } }) + '\n');
      }
    }
  }
}

// Turns MCP tool definitions into the agent's tool specs.
export function toToolSpecs(tools: McpTool[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description ?? '').slice(0, 600),
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

// Text for the model from an MCP result. The local model can't see images, so
// images are shown to the user and the model is told how to read the screen instead.
export function resultText(r: McpCallResult): string {
  let text = r.text || (r.images.length ? '' : '(no output)');
  if (r.images.length) {
    text += `${text ? '\n' : ''}[${r.images.length} image(s) shown to the user in the chat. You cannot see images: use ui_tree to read the screen as text.]`;
  }
  return r.isError ? `Error: ${text}` : text;
}
