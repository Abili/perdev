// Sidebar chat panel. The webview only renders; all logic lives in the extension host.

import * as vscode from 'vscode';
import { Agent, AgentEvent } from './agent';
import { LlmConfig } from './llm';
import { TrainingLogger } from './logger';
import { ChatSession, newSessionId, SessionStore, titleFrom } from './sessions';
import { resolveShell, ShellPreference } from './shell';
import { workspaceOverview } from './prompt';
import { DocsLookup } from './docs';
import { McpManager } from './mcpManager';
import { describeActivity } from './activity';
import * as path from 'path';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'perdev.chat';
  private view?: vscode.WebviewView;
  private agent?: Agent;
  private session: ChatSession = blankSession();

  constructor(
    private readonly logger: TrainingLogger,
    private readonly store: SessionStore,
    private readonly mcp: McpManager,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(nonce());
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') await this.send(String(msg.text ?? ''));
      else if (msg.type === 'stop') this.stop();
      else if (msg.type === 'new') this.newChat();
      else if (msg.type === 'branch') await this.branch();
      else if (msg.type === 'openSession') await this.openSession(String(msg.id));
    });
  }

  // Put text in the chat box (e.g. a new project's first request), ready to send.
  prefill(text: string) {
    this.post({ type: 'prefill', text });
  }

  newChat() {
    this.agent?.stop();
    this.agent?.reset();
    this.session = blankSession();
    this.post({ type: 'clear' });
    this.postUsage();
  }

  stop() {
    this.agent?.stop();
  }

  private post(msg: object) {
    this.view?.webview.postMessage(msg);
  }

  private settings() {
    const c = vscode.workspace.getConfiguration('perdev');
    const cfg: LlmConfig = {
      baseUrl: c.get<string>('baseUrl', 'http://127.0.0.1:8780/v1'),
      apiKey: c.get<string>('apiKey', 'local'),
      model: c.get<string>('chatModel', 'perdev-coder'),
    };
    return {
      c,
      cfg,
      maxContextChars: c.get<number>('agent.maxContextChars', 40000),
      branchAt: c.get<number>('agent.suggestNewChatAt', 0.75),
    };
  }

  private getAgent(): Agent | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'event', event: { type: 'error', message: 'No project is open yet. Start one from the PerDev start screen (rocket button above, or "PerDev: New Project"), or open a folder.' } });
      this.post({ type: 'event', event: { type: 'done', outcome: 'error' } });
      return undefined;
    }
    if (!this.agent) {
      const pref = vscode.workspace.getConfiguration('perdev').get<ShellPreference>('agent.shell', 'auto');
      this.agent = new Agent(root, resolveShell(pref));
    }
    return this.agent;
  }

  // One cache for downloaded doc indexes and pages, next to the chats.
  private docsLookup?: DocsLookup;
  private docs(): DocsLookup {
    this.docsLookup ??= new DocsLookup(path.join(this.logger.dir, 'docs'));
    return this.docsLookup;
  }

  private postUsage() {
    const { maxContextChars, branchAt } = this.settings();
    const ratio = this.agent ? this.agent.usage(maxContextChars) : 0;
    const hasChat = this.session.messages.some((m) => m.role === 'user');
    this.post({ type: 'usage', ratio, branchAt, canBranch: hasChat });
  }

  private async persist() {
    if (!this.agent) return;
    this.session.messages = this.agent.messages;
    this.session.title = titleFrom(this.agent.messages);
    await this.store.save(this.session);
  }

  private async send(text: string) {
    if (!text.trim()) return;
    const agent = this.getAgent();
    if (!agent || agent.running) return;
    const { c, cfg, maxContextChars } = this.settings();

    this.post({ type: 'user', text });
    // First message of a chat: tell the model what's in the workspace.
    const firstMessage = !agent.messages.some((m) => m.role === 'user');
    const overview = firstMessage ? workspaceOverview(await listWorkspace()) : '';
    // Tools from MCP servers in settings (e.g. DroidLoop), for workspaces they apply to.
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const emitStatus = (t: string) => this.post({ type: 'event', event: { type: 'status', text: t } });
    await waitForModel(cfg.baseUrl, emitStatus, agent);
    const servers = c.get<Record<string, unknown>>('mcpServers', {});
    if (Object.keys(servers).length) emitStatus('Getting tools ready…');
    const extra = await this.mcp.toolsFor(root, servers as any, text);
    const outcome = await agent.run(
      withEditorContext(text) + overview,
      cfg,
      {
        maxSteps: c.get<number>('agent.maxSteps', 25),
        maxContextChars,
        approveCommands: c.get<boolean>('agent.approveCommands', true),
        approveEdits: c.get<boolean>('agent.approveEdits', false),
        docs: c.get<boolean>('docs.enabled', true) ? this.docs() : undefined,
        extra,
        confirm: async (title, detail) =>
          (await vscode.window.showWarningMessage(title, { modal: true, detail: detail.slice(0, 1500) }, 'Allow')) === 'Allow',
      },
      (event: AgentEvent) => {
        // Save after every step so a long or stuck run is never lost.
        if (event.type === 'step') void this.persist();
        else this.post({ type: 'event', event });
      },
    );
    await this.persist();
    this.postUsage();
    await this.logger.logSession(cfg.model, agent.messages, outcome);
  }

  // Continue this chat in a new one that carries a handoff note and links back here.
  async branch() {
    const agent = this.getAgent();
    if (!agent || agent.running) return;
    if (!this.session.messages.some((m) => m.role === 'user')) {
      vscode.window.showInformationMessage('Nothing to carry over yet: this chat is empty.');
      return;
    }
    const { cfg, maxContextChars } = this.settings();
    await this.persist();
    const parent = this.session;

    this.post({ type: 'branching' });
    let summary = '';
    try {
      summary = await agent.summarize(cfg, maxContextChars, (d) => this.post({ type: 'handoff_text', delta: d }));
    } catch (e: any) {
      const stopped = e?.name === 'AbortError';
      this.post({ type: 'event', event: { type: 'error', message: stopped ? 'Stopped. Still in the same chat.' : `Could not write the handoff note: ${e?.message ?? e}` } });
      this.post({ type: 'event', event: { type: 'done', outcome: 'error' } });
      return;
    }
    if (!summary) {
      this.post({ type: 'event', event: { type: 'error', message: 'The model returned an empty handoff note. Still in the same chat.' } });
      this.post({ type: 'event', event: { type: 'done', outcome: 'error' } });
      return;
    }

    agent.reset({ parentTitle: parent.title, summary });
    this.session = {
      ...blankSession(),
      parentId: parent.id,
      parentTitle: parent.title,
      carriedSummary: summary,
      messages: agent.messages,
    };
    this.session.title = `${parent.title} (continued)`;
    await this.store.save(this.session);

    this.post({ type: 'clear' });
    this.post({ type: 'branch_card', parentId: parent.id, parentTitle: parent.title, summary });
    this.postUsage();
  }

  // Reopen a saved chat (e.g. the parent of a branch) and keep working in it.
  async openSession(id: string) {
    const agent = this.getAgent();
    if (!agent || agent.running) return;
    const s = await this.store.load(id);
    if (!s) {
      vscode.window.showWarningMessage('That chat could not be found on disk.');
      return;
    }
    if (this.session.messages.some((m) => m.role === 'user')) await this.persist();
    this.session = s;
    agent.messages = s.messages;

    this.post({ type: 'clear' });
    if (s.parentId && s.carriedSummary) {
      this.post({ type: 'branch_card', parentId: s.parentId, parentTitle: s.parentTitle ?? 'earlier chat', summary: s.carriedSummary });
    }
    for (const m of s.messages) {
      if (m.role === 'user') {
        this.post({ type: 'user', text: stripEditorContext(m.content ?? '') });
      } else if (m.role === 'assistant') {
        if (m.content) this.post({ type: 'event', event: { type: 'text', delta: m.content } });
        this.post({ type: 'event', event: { type: 'assistant_end' } });
        for (const tc of m.tool_calls ?? []) {
          this.post({ type: 'event', event: { type: 'tool_start', id: tc.id, name: tc.function.name, args: tc.function.arguments, label: describeActivity(tc.function.name, tc.function.arguments) } });
        }
      } else if (m.role === 'tool') {
        this.post({ type: 'event', event: { type: 'tool_end', id: m.tool_call_id, result: m.content ?? '' } });
      }
    }
    this.post({ type: 'event', event: { type: 'done', outcome: 'done' } });
    this.postUsage();
  }

  async showHistory() {
    const items = (await this.store.list()).map((s) => ({
      label: s.title,
      description: s.parentTitle ? `branched from "${s.parentTitle}"` : '',
      detail: new Date(s.updatedAt).toLocaleString(),
      id: s.id,
    }));
    if (!items.length) {
      vscode.window.showInformationMessage('No saved chats yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a previous PerDev chat' });
    if (pick) await this.openSession(pick.id);
  }
}

function blankSession(): ChatSession {
  const now = new Date().toISOString();
  return { id: newSessionId(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
}

// Before a request: if the local model is still loading (or starting), say so
// instead of sitting silent. Returns as soon as it answers.
async function waitForModel(baseUrl: string, status: (t: string) => void, agent: Agent) {
  const health = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/health';
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && agent) {
    try {
      const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
      if (res.status !== 503) return; // ready (or a server without /health)
      status('Loading the AI model… (the first start takes about 30 s)');
    } catch {
      status('Waiting for the AI model to start…');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function stripEditorContext(text: string): string {
  return text.replace(/\n\n\[(Context|Workspace)[\s\S]*$/, '');
}

async function listWorkspace(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build,.venv,venv,__pycache__,.vscode}/**', 200);
  return uris.map((u) => vscode.workspace.asRelativePath(u));
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
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
  .activity { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 0.92em; margin: 2px 0 12px; }
  .activity .spin { width: 12px; height: 12px; flex: none; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  .activity .label { background: linear-gradient(90deg, var(--vscode-descriptionForeground) 35%, var(--vscode-foreground) 50%, var(--vscode-descriptionForeground) 65%); background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 2.2s linear infinite; }
  .activity .secs { margin-left: auto; opacity: .7; font-variant-numeric: tabular-nums; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }
  details.think { margin: 0 0 10px; border-left: 2px solid var(--vscode-descriptionForeground); padding-left: 8px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  details.think summary { cursor: pointer; }
  details.think .t { white-space: pre-wrap; max-height: 220px; overflow-y: auto; margin-top: 4px; }
  @media (prefers-reduced-motion: reduce) { .activity .spin, .activity .label { animation: none; } .activity .label { color: var(--vscode-descriptionForeground); } }
  .shot img { max-width: 100%; max-height: 420px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 30%; padding: 0 16px; }
  .branch { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; margin: 0 0 12px; font-size: 0.92em; }
  .branch .head { color: var(--vscode-descriptionForeground); }
  .branch details { margin-top: 6px; }
  .branch details summary { cursor: pointer; }
  .branch .note { white-space: pre-wrap; margin-top: 6px; }
  .handoff { border-left: 2px dashed var(--vscode-descriptionForeground); padding-left: 8px; white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
  a, .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; background: none; border: none; padding: 0; font: inherit; }
  a:hover, .link:hover { text-decoration: underline; background: none; }
  #banner { display: none; margin: 0 8px 6px; padding: 8px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,.5)); font-size: 0.92em; }
  #banner button { margin-top: 6px; }
  #meter { display: flex; align-items: center; gap: 8px; padding: 0 8px 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  #meterBar { flex: 1; height: 4px; border-radius: 2px; background: var(--vscode-input-background); overflow: hidden; }
  #meterFill { height: 100%; width: 0; background: var(--vscode-progressBar-background); transition: width .3s; }
  #meterFill.warn { background: var(--vscode-editorWarning-foreground); }
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
<div id="banner">This chat is getting long, so the model will start forgetting older details.<br><button id="branchBtn">Continue in a new chat</button> <span class="link" id="dismissBtn">Not now</span></div>
<div id="meter" title="How much of the model's memory this chat uses"><span id="meterLabel">Context 0%</span><div id="meterBar"><div id="meterFill"></div></div><span class="link" id="branchLink" title="Start a new chat that carries a summary of this one">New branch</span></div>
<div id="composer">
  <textarea id="input" rows="1" placeholder="Ask or give a task (Enter to send, Shift+Enter for newline)"></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const banner = document.getElementById('banner');
  let current = null, currentText = '', running = false, dismissed = false, lastUsage = null;
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
  // Live activity line: what the agent is doing, with elapsed time.
  let activity = null, startedAt = 0, ticker = null, thinkEl = null, thinkStart = 0;
  function tick() { if (activity) activity.querySelector('.secs').textContent = Math.floor((Date.now() - startedAt) / 1000) + 's'; }
  function showActivity(text) {
    if (!activity) {
      activity = document.createElement('div'); activity.className = 'activity'; activity.setAttribute('role', 'status');
      activity.innerHTML = '<span class="spin"></span><span class="label"></span><span class="secs"></span>';
    }
    activity.querySelector('.label').textContent = text;
    log.appendChild(activity); tick(); log.scrollTop = log.scrollHeight;
  }
  function keepActivityLast() { if (activity) { log.appendChild(activity); log.scrollTop = log.scrollHeight; } }
  function startActivity(text) { startedAt = Date.now(); clearInterval(ticker); ticker = setInterval(tick, 1000); showActivity(text); }
  function stopActivity() { clearInterval(ticker); ticker = null; if (activity) activity.remove(); activity = null; }
  function endThinking() {
    if (!thinkEl) return;
    thinkEl.open = false;
    thinkEl.querySelector('summary').textContent = 'Thought for ' + Math.max(1, Math.round((Date.now() - thinkStart) / 1000)) + 's';
    thinkEl = null;
  }
  function setRunning(r) { running = r; sendBtn.textContent = r ? 'Stop' : 'Send'; sendBtn.className = r ? 'secondary' : ''; if (lastUsage) showUsage(lastUsage); }
  function send() {
    if (running) { vscode.postMessage({ type: 'stop' }); return; }
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.style.height = 'auto';
    vscode.postMessage({ type: 'send', text });
  }
  function branch() { if (!running) { banner.style.display = 'none'; vscode.postMessage({ type: 'branch' }); } }
  sendBtn.onclick = send;
  document.getElementById('branchBtn').onclick = branch;
  document.getElementById('branchLink').onclick = branch;
  document.getElementById('dismissBtn').onclick = () => { dismissed = true; banner.style.display = 'none'; };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  function showUsage(u) {
    lastUsage = u;
    const pct = Math.round(u.ratio * 100);
    const fill = document.getElementById('meterFill');
    fill.style.width = Math.min(100, pct) + '%';
    fill.className = u.ratio >= u.branchAt ? 'warn' : '';
    document.getElementById('meterLabel').textContent = pct >= 100 ? 'Context full (trimming old details)' : 'Context ' + pct + '%';
    document.getElementById('branchLink').style.display = u.canBranch ? '' : 'none';
    banner.style.display = (u.canBranch && u.ratio >= u.branchAt && !dismissed && !running) ? 'block' : 'none';
  }

  function summarize(name, args) {
    try { const a = JSON.parse(args || '{}'); return name + ' ' + (a.path || a.command || a.regex || a.pattern || ''); } catch { return name; }
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'prefill') { input.value = data.text; input.dispatchEvent(new Event('input')); input.focus(); return; }
    if (data.type === 'clear') { log.innerHTML = '<div class="empty" id="empty">New chat. What should we build?</div>'; current = null; dismissed = false; return; }
    if (data.type === 'usage') { showUsage(data); return; }
    if (data.type === 'user') { add('user', esc(data.text)); setRunning(true); current = null; startActivity('Starting…'); return; }
    if (data.type === 'branching') {
      setRunning(true);
      current = add('handoff', '<strong>Writing a handoff note for the new chat…</strong>\\n'); currentText = '';
      return;
    }
    if (data.type === 'handoff_text') {
      currentText += data.delta; current.innerHTML = '<strong>Writing a handoff note for the new chat…</strong>\\n' + esc(currentText);
      log.scrollTop = log.scrollHeight; return;
    }
    if (data.type === 'branch_card') {
      setRunning(false); current = null;
      const d = add('branch', '');
      d.innerHTML = '<div class="head">↳ Continued from <span class="link" data-id="' + esc(data.parentId) + '">' + esc(data.parentTitle) + '</span></div>' +
        '<details><summary>What was carried over</summary><div class="note">' + esc(data.summary) + '</div></details>';
      d.querySelector('.link').onclick = (e) => vscode.postMessage({ type: 'openSession', id: e.target.dataset.id });
      return;
    }
    if (data.type !== 'event') return;
    const e = data.event;
    if (e.type === 'status') {
      if (running) showActivity(e.text);
    } else if (e.type === 'thinking') {
      if (!thinkEl) {
        thinkEl = document.createElement('details'); thinkEl.className = 'think'; thinkEl.open = true; thinkStart = Date.now();
        thinkEl.innerHTML = '<summary>Thinking…</summary><div class="t"></div>';
        document.getElementById('empty')?.remove(); log.appendChild(thinkEl);
      }
      const t = thinkEl.querySelector('.t'); t.textContent += e.delta; t.scrollTop = t.scrollHeight;
      keepActivityLast();
    } else if (e.type === 'text') {
      endThinking();
      if (!current) { current = add('assistant', ''); currentText = ''; }
      currentText += e.delta; current.innerHTML = md(currentText);
      if (activity) showActivity('Writing a reply…'); else log.scrollTop = log.scrollHeight;
    } else if (e.type === 'assistant_end') {
      endThinking();
      if (current && !currentText.trim()) current.remove();
      current = null;
    } else if (e.type === 'tool_start') {
      const d = document.createElement('details'); d.className = 'tool running';
      d.innerHTML = '<summary>' + esc(e.label || summarize(e.name, e.args)) + '</summary><pre>' + esc(e.args || '') + '</pre>';
      document.getElementById('empty')?.remove(); log.appendChild(d); tools[e.id] = d; log.scrollTop = log.scrollHeight;
      keepActivityLast();
    } else if (e.type === 'tool_end') {
      const d = tools[e.id]; if (!d) return;
      d.classList.remove('running');
      const failed = e.result.startsWith('Error:');
      if (failed) d.querySelector('summary').classList.add('error');
      d.querySelector('pre').textContent = e.result;
    } else if (e.type === 'error') {
      add('error', esc(e.message));
      keepActivityLast();
    } else if (e.type === 'image') {
      const d = add('shot', '');
      const img = document.createElement('img');
      img.src = 'data:' + e.mimeType + ';base64,' + e.data;
      img.alt = 'Device screenshot';
      d.appendChild(img);
      keepActivityLast();
    } else if (e.type === 'done') {
      endThinking(); stopActivity();
      setRunning(false); current = null;
      if (e.outcome === 'stopped') add('error', 'Stopped.');
    }
  });
</script>
</body>
</html>`;
}
