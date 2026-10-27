// Sidebar chat panel. The webview only renders; all logic lives in the extension host.

import * as vscode from 'vscode';
import { Agent, AgentEvent } from './agent';
import { TrainingLogger } from './logger';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'perdev.chat';
  private view?: vscode.WebviewView;
  private agent?: Agent;

  constructor(private readonly logger: TrainingLogger) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(nonce());
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') await this.send(String(msg.text ?? ''));
      else if (msg.type === 'stop') this.stop();
      else if (msg.type === 'new') this.newChat();
    });
  }

  newChat() {
    this.agent?.stop();
    this.agent?.reset();
    this.post({ type: 'clear' });
  }

  stop() {
    this.agent?.stop();
  }

  private post(msg: object) {
    this.view?.webview.postMessage(msg);
  }

  private async send(text: string) {
    if (!text.trim()) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'event', event: { type: 'error', message: 'Open a folder first. PerDev works inside a workspace.' } });
      this.post({ type: 'event', event: { type: 'done', outcome: 'error' } });
      return;
    }
    if (!this.agent) this.agent = new Agent(root);
    if (this.agent.running) return;

    const c = vscode.workspace.getConfiguration('perdev');
    const cfg = {
      baseUrl: c.get<string>('baseUrl', 'http://localhost:11434/v1'),
      apiKey: c.get<string>('apiKey', 'ollama'),
      model: c.get<string>('chatModel', 'perdev-coder'),
    };
    this.post({ type: 'user', text });
    const outcome = await this.agent.run(
      withEditorContext(text),
      cfg,
      {
        maxSteps: c.get<number>('agent.maxSteps', 25),
        maxContextChars: c.get<number>('agent.maxContextChars', 40000),
        approveCommands: c.get<boolean>('agent.approveCommands', true),
        approveEdits: c.get<boolean>('agent.approveEdits', false),
      },
      (event: AgentEvent) => this.post({ type: 'event', event }),
    );
    await this.logger.logSession(cfg.model, this.agent.messages, outcome);
  }
}

// Tell the model which file the user is looking at, plus any selection.
function withEditorContext(text: string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return text;
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const sel = editor.selection;
  let ctx = `\n\n[Context: the user has ${rel} open`;
  if (!sel.isEmpty) {
    const selected = editor.document.getText(sel).slice(0, 4000);
    ctx += ` with lines ${sel.start.line + 1}-${sel.end.line + 1} selected:\n\`\`\`\n${selected}\n\`\`\``;
  }
  return text + ctx + ']';
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(n: string) {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px 10px; }
  .msg { margin: 0 0 12px; line-height: 1.5; word-wrap: break-word; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
  .assistant p { margin: 0 0 6px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  details.tool { margin: 0 0 8px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 8px; font-size: 0.92em; }
  details.tool summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  details.tool.running summary::after { content: ' …'; }
  details.tool pre { max-height: 240px; overflow: auto; white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 30%; padding: 0 16px; }
  #composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; gap: 6px; align-items: flex-end; }
  textarea { flex: 1; resize: none; min-height: 34px; max-height: 160px; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 7px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<div id="log"><div class="empty" id="empty">Ask PerDev to explain, fix or build something in this workspace.<br><br>Runs on your own local model.</div></div>
<div id="composer">
  <textarea id="input" rows="1" placeholder="Ask or give a task (Enter to send, Shift+Enter for newline)"></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  let current = null, currentText = '', running = false;
  const tools = {};

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function md(src) {
    const parts = src.split(/\`\`\`/);
    return parts.map((p, i) => {
      if (i % 2 === 1) { const nl = p.indexOf('\\n'); return '<pre><code>' + esc(nl >= 0 ? p.slice(nl + 1) : p) + '</code></pre>'; }
      return esc(p).replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .split(/\\n{2,}/).map(x => x.trim() ? '<p>' + x.replace(/\\n/g, '<br>') + '</p>' : '').join('');
    }).join('');
  }
  function add(cls, htmlStr) {
    document.getElementById('empty')?.remove();
    const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = htmlStr; log.appendChild(d);
    log.scrollTop = log.scrollHeight; return d;
  }
  function setRunning(r) { running = r; sendBtn.textContent = r ? 'Stop' : 'Send'; sendBtn.className = r ? 'secondary' : ''; }
  function send() {
    if (running) { vscode.postMessage({ type: 'stop' }); return; }
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.style.height = 'auto';
    vscode.postMessage({ type: 'send', text });
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  function summarize(name, args) {
    try { const a = JSON.parse(args || '{}'); return name + ' ' + (a.path || a.command || a.regex || a.pattern || ''); } catch { return name; }
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'clear') { log.innerHTML = '<div class="empty" id="empty">New chat. What should we build?</div>'; current = null; return; }
    if (data.type === 'user') { add('user', esc(data.text)); setRunning(true); current = null; return; }
    if (data.type !== 'event') return;
    const e = data.event;
    if (e.type === 'text') {
      if (!current) { current = add('assistant', ''); currentText = ''; }
      currentText += e.delta; current.innerHTML = md(currentText); log.scrollTop = log.scrollHeight;
    } else if (e.type === 'assistant_end') {
      if (current && !currentText.trim()) current.remove();
      current = null;
    } else if (e.type === 'tool_start') {
      const d = document.createElement('details'); d.className = 'tool running';
      d.innerHTML = '<summary>' + esc(summarize(e.name, e.args)) + '</summary><pre>' + esc(e.args || '') + '</pre>';
      document.getElementById('empty')?.remove(); log.appendChild(d); tools[e.id] = d; log.scrollTop = log.scrollHeight;
    } else if (e.type === 'tool_end') {
      const d = tools[e.id]; if (!d) return;
      d.classList.remove('running');
      const failed = e.result.startsWith('Error:');
      if (failed) d.querySelector('summary').classList.add('error');
      d.querySelector('pre').textContent = e.result;
    } else if (e.type === 'error') {
      add('error', esc(e.message));
    } else if (e.type === 'done') {
      setRunning(false); current = null;
      if (e.outcome === 'stopped') add('error', 'Stopped.');
    }
  });
</script>
</body>
</html>`;
}
