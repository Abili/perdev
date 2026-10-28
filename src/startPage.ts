// PerDev's start screen: "What are you building today?" with project cards.
// Opens when PerDev starts without a folder, and from "PerDev: New Project".

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CATEGORIES, checkAvailability, PROJECT_TYPES, writeStarterFiles } from './projectTypes';

export interface PendingProject {
  folder: string;
  typeId: string;
  name: string;
  description: string;
  command?: string;
}

const PENDING_KEY = 'perdev.pendingProject';
const RECENT_KEY = 'perdev.recentProjects';

export class StartPage {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly context: vscode.ExtensionContext) {}

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('perdev.start', 'Welcome to PerDev', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perdev-128.png');
    panel.onDidDispose(() => (this.panel = undefined));
    panel.webview.html = startHtml(nonce());
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private async onMessage(m: any) {
    const post = (msg: object) => this.panel?.webview.postMessage(msg);
    if (m.type === 'ready') {
      post({
        type: 'init',
        categories: CATEGORIES,
        types: PROJECT_TYPES.map(({ id, category, title, blurb, icon, setup }) => ({
          id, category, title, blurb, icon,
          downloads: setup.kind === 'command' ? setup.downloads : 'nothing (PerDev writes a small starter)',
        })),
        availability: await checkAvailability(),
        location: defaultLocation(),
        recent: this.recent().filter((r) => fs.existsSync(r.folder)).slice(0, 6),
      });
    } else if (m.type === 'browse') {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create projects here' });
      if (picked?.[0]) post({ type: 'location', location: picked[0].fsPath });
    } else if (m.type === 'openFolder') {
      await vscode.commands.executeCommand('vscode.openFolder');
    } else if (m.type === 'openRecent') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(String(m.folder)));
    } else if (m.type === 'install') {
      await vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
    } else if (m.type === 'create') {
      const error = await this.create(String(m.typeId), String(m.name ?? '').trim(), String(m.location ?? '').trim(), String(m.description ?? '').trim());
      if (error) post({ type: 'createError', message: error });
    }
  }

  // Makes the folder, writes a starter or queues the official generator, then
  // opens the folder; the rest continues in resumePendingProject after reload.
  private async create(typeId: string, name: string, location: string, description: string): Promise<string | undefined> {
    const type = PROJECT_TYPES.find((t) => t.id === typeId);
    if (!type) return 'Unknown project type.';
    if (!name) return 'Give the project a name.';
    if (/[<>:"/\\|?*]/.test(name)) return 'The name can\'t contain < > : " / \\ | ? *';
    if (!location) return 'Choose where to create it.';
    const folder = path.join(location, name);
    if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) return `${folder} already exists and isn't empty. Pick another name.`;
    try {
      fs.mkdirSync(folder, { recursive: true });
      if (type.setup.kind === 'files') writeStarterFiles(folder, type.setup.files(name));
    } catch (e: any) {
      return `Couldn't create ${folder}: ${e?.message ?? e}`;
    }
    const pending: PendingProject = {
      folder,
      typeId,
      name,
      description,
      command: type.setup.kind === 'command' ? type.setup.command(name) : undefined,
    };
    await this.context.globalState.update(PENDING_KEY, pending);
    await this.addRecent(folder, type.title);
    await vscode.workspace.getConfiguration('perdev').update('projectsFolder', location, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder));
    return undefined;
  }

  private recent(): { folder: string; type: string; when: string }[] {
    return this.context.globalState.get(RECENT_KEY, []);
  }

  private async addRecent(folder: string, type: string) {
    const list = this.recent().filter((r) => r.folder !== folder);
    list.unshift({ folder, type, when: new Date().toISOString() });
    await this.context.globalState.update(RECENT_KEY, list.slice(0, 12));
  }
}

function defaultLocation(): string {
  const configured = vscode.workspace.getConfiguration('perdev').get<string>('projectsFolder', '');
  return configured || path.join(os.homedir(), 'PerDevProjects');
}

// After the new folder opens: run the generator in a visible terminal and put
// the request in the agent's chat box, ready to send.
export async function resumePendingProject(
  context: vscode.ExtensionContext,
  prefillChat: (text: string) => void,
  shellPath: string | undefined,
  shellKind: string,
) {
  const pending = context.globalState.get<PendingProject>(PENDING_KEY);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!pending || !root || path.resolve(root).toLowerCase() !== path.resolve(pending.folder).toLowerCase()) return;
  await context.globalState.update(PENDING_KEY, undefined);
  const type = PROJECT_TYPES.find((t) => t.id === pending.typeId);
  if (!type) return;

  if (pending.command) {
    const term = vscode.window.createTerminal({ name: 'PerDev setup', cwd: root, shellPath });
    term.show();
    // Windows PowerShell 5.1 has no &&; cmd does.
    term.sendText(shellKind === 'powershell' ? `cmd /c "${pending.command.replace(/"/g, '\\"')}"` : pending.command);
  }
  await vscode.commands.executeCommand('workbench.view.extension.perdev');
  const ask = pending.description ? `${type.agentPrompt}\n\n${pending.description}` : `${type.agentPrompt}\n\n(Describe what the app should do.)`;
  // The chat view may still be loading; give it a moment.
  setTimeout(() => prefillChat(ask), 1200);
  vscode.window.showInformationMessage(
    pending.command
      ? `${pending.name} is being set up in the terminal. When it finishes, press Send in the PerDev chat to start building.`
      : `${pending.name} is ready. Press Send in the PerDev chat to start building.`,
  );
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// Simple monochrome glyphs (drawn with currentColor).
const ICONS: Record<string, string> = {
  react: '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="1.4"/><ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(120 12 12)"/>',
  flutter: '<path d="M14.5 2 4.5 12l3 3L20.5 2z"/><path d="M14.5 11 9 16.5l5.5 5.5h6L15 16.5l5.5-5.5z"/>',
  android: '<path d="M6 10h12v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M6.5 9a5.5 5.5 0 0 1 11 0z"/><path d="M8 4l1.5 2.2M16 4l-1.5 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="9.5" cy="7.3" r=".8" fill="var(--tile)"/><circle cx="14.5" cy="7.3" r=".8" fill="var(--tile)"/>',
  apple: '<path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.9-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.2.8 1.1 1.7 2.3 2.9 2.3 1.2-.1 1.6-.8 3-.8s1.8.8 3 .8c1.3 0 2.1-1.1 2.8-2.2.9-1.3 1.3-2.5 1.3-2.6-.1 0-2.5-.9-2.5-3.8zM14.1 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.6-1.3z"/>',
  html: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9 16V8l7 9M15 8v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  node: '<path d="M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 8v8M9 10l3-2 3 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  python: '<path d="M11.8 2.5c-4.6 0-4.3 2-4.3 2v2.1h4.4v.6H5.8S2.8 6.9 2.8 11.6s2.6 4.5 2.6 4.5H7v-2.2s-.1-2.6 2.6-2.6h4.4s2.5 0 2.5-2.4v-4S16.8 2.5 11.8 2.5zM9.4 3.9a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z"/><path d="M12.2 21.5c4.6 0 4.3-2 4.3-2v-2.1h-4.4v-.6h6.1s3 .3 3-4.4-2.6-4.5-2.6-4.5H17v2.2s.1 2.6-2.6 2.6H10s-2.5 0-2.5 2.4v4s-.4 2.4 4.7 2.4zm2.4-1.4a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z"/>',
};

const LOGO = '<svg viewBox="40 24 190 210" width="30" height="30" fill="none" stroke="#2D5BFF" stroke-linecap="round" stroke-linejoin="round"><path d="M84 48 V212" stroke-width="22"/><path d="M84 48 H146 C190 48 206 76 206 104 C206 134 184 150 150 150 H92" stroke-width="20"/><path d="M90 140 C98 104 118 88 140 88 C150 88 157 92 162 100" stroke-width="16"/></svg>';

export function startHtml(n: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: #090b12; --bg2: #0e1220; --card: #121726; --card-hi: #161c2e; --line: #1f2740; --line-hi: #2d5bff;
    --text: #e8ebf4; --muted: #8b93ab; --faint: #5b6480; --accent: #2d5bff; --accent-soft: rgba(45, 91, 255, .14);
    --ok: #3ccf8e; --warn: #f0b44c; --off: #6b7280; --tile: #121726;
    --radius: 16px; --shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 12px 30px -18px rgba(0,0,0,.8);
  }
  body.vscode-light {
    --bg: #f5f7fc; --bg2: #eef2fb; --card: #ffffff; --card-hi: #ffffff; --line: #e1e6f2; --text: #0b0d14; --muted: #5a6278;
    --faint: #8a91a6; --accent-soft: rgba(45, 91, 255, .09); --tile: #ffffff; --shadow: 0 10px 24px -18px rgba(20,30,60,.35);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh; color: var(--text); background:
      radial-gradient(1200px 520px at 50% -180px, rgba(45, 91, 255, .22), transparent 70%),
      radial-gradient(700px 360px at 92% 8%, rgba(120, 70, 255, .10), transparent 70%), var(--bg);
    font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 40px 64px; }
  header { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 17px; letter-spacing: .2px; }
  .ghost { background: transparent; color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; font: inherit; cursor: pointer; transition: border-color .15s, background .15s; }
  .ghost:hover { border-color: var(--accent); background: var(--accent-soft); }
  .hero { text-align: center; padding: 64px 0 40px; }
  .hero h1 { margin: 0 0 12px; font-size: 40px; line-height: 1.1; font-weight: 700; letter-spacing: -.8px; }
  .hero h1 span { background: linear-gradient(90deg, #5d82ff, #2d5bff 45%, #8a63ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero p { margin: 0 auto; max-width: 560px; color: var(--muted); font-size: 15.5px; }
  .tabs { display: flex; gap: 8px; justify-content: center; margin: 0 0 28px; flex-wrap: wrap; }
  .tab { border: 1px solid var(--line); background: var(--card); color: var(--muted); border-radius: 999px; padding: 7px 16px; font: inherit; cursor: pointer; transition: all .15s; }
  .tab:hover { color: var(--text); }
  .tab[aria-selected="true"] { color: #fff; background: var(--accent); border-color: var(--accent); }
  section { margin-bottom: 36px; }
  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.4px; color: var(--faint); font-weight: 600; margin: 0 0 14px; }
  section h2 small { text-transform: none; letter-spacing: 0; color: var(--faint); font-weight: 400; margin-left: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  .card {
    position: relative; text-align: left; background: linear-gradient(180deg, var(--card-hi), var(--card)); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 18px 18px 16px; color: var(--text); font: inherit; cursor: pointer; box-shadow: var(--shadow);
    transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; display: flex; flex-direction: column; gap: 10px; min-height: 172px;
  }
  .card:hover:not([aria-disabled="true"]), .card:focus-visible { transform: translateY(-3px); border-color: var(--line-hi); box-shadow: 0 0 0 1px var(--line-hi), 0 18px 40px -22px rgba(45,91,255,.7); outline: none; }
  .card[aria-disabled="true"] { cursor: not-allowed; opacity: .55; }
  .icon { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: #6f8dff; }
  body.vscode-light .icon { color: var(--accent); }
  .icon svg { width: 24px; height: 24px; fill: currentColor; }
  .card h3 { margin: 2px 0 0; font-size: 15.5px; font-weight: 620; }
  .card p { margin: 0; color: var(--muted); font-size: 13px; flex: 1; }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px rgba(60,207,142,.15); }
  .chip.warn::before { background: var(--warn); box-shadow: 0 0 0 3px rgba(240,180,76,.15); }
  .chip.off::before { background: var(--off); box-shadow: none; }
  .bottom { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; margin-top: 8px; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
  .panel h3 { margin: 0 0 10px; font-size: 14px; font-weight: 620; }
  .recent { list-style: none; margin: 0; padding: 0; }
  .recent li button { width: 100%; text-align: left; background: none; border: 0; border-radius: 10px; padding: 8px 10px; color: var(--text); font: inherit; cursor: pointer; display: flex; justify-content: space-between; gap: 10px; }
  .recent li button:hover { background: var(--accent-soft); }
  .recent .path { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--faint); margin: 4px 0 0; }
  .facts { margin: 0; padding: 0; list-style: none; color: var(--muted); display: grid; gap: 8px; }
  .facts li::before { content: "✓"; color: var(--ok); margin-right: 8px; }
  /* Create sheet */
  .scrim { position: fixed; inset: 0; background: rgba(4, 6, 12, .55); backdrop-filter: blur(3px); opacity: 0; pointer-events: none; transition: opacity .2s; }
  .scrim.open { opacity: 1; pointer-events: auto; }
  .sheet { position: fixed; top: 0; right: 0; height: 100%; width: min(460px, 100%); background: var(--bg2); border-left: 1px solid var(--line);
    transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1); padding: 28px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .sheet.open { transform: none; }
  .sheet .head { display: flex; align-items: center; gap: 12px; }
  .sheet h2 { margin: 0; font-size: 20px; }
  label { display: grid; gap: 6px; font-size: 12.5px; color: var(--muted); }
  input, textarea { width: 100%; background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  textarea { min-height: 110px; resize: vertical; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  .note { font-size: 12.5px; color: var(--muted); background: var(--card); border: 1px dashed var(--line); border-radius: 10px; padding: 10px 12px; }
  .err { color: #ff7b7b; font-size: 13px; min-height: 18px; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: auto; }
  .primary { background: var(--accent); color: #fff; border: 0; border-radius: 10px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; box-shadow: 0 8px 20px -10px rgba(45,91,255,.9); }
  .primary:hover { filter: brightness(1.1); }
  footer { text-align: center; color: var(--faint); font-size: 12px; margin-top: 40px; }
  @media (max-width: 720px) { .wrap { padding: 20px; } .hero h1 { font-size: 30px; } .bottom { grid-template-columns: 1fr; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">${LOGO}<span>PerDev</span></div>
    <button class="ghost" id="openFolder">Open folder…</button>
  </header>
  <div class="hero">
    <h1>What are you <span>building</span> today?</h1>
    <p>Pick a starting point. PerDev sets up the project, then its AI agent, running on your own computer, builds it with you.</p>
  </div>
  <div class="tabs" role="tablist" id="tabs"></div>
  <div id="sections"></div>
  <div class="bottom">
    <div class="panel"><h3>Recent projects</h3><ul class="recent" id="recent"></ul></div>
    <div class="panel"><h3>Private by design</h3><ul class="facts"><li>Runs on your own AI model</li><li>Your code never leaves this PC</li><li>Free, with no account needed</li></ul></div>
  </div>
  <footer>Tip: you can come back here any time with “PerDev: New Project”.</footer>
</div>

<div class="scrim" id="scrim"></div>
<aside class="sheet" id="sheet" aria-hidden="true">
  <div class="head"><div class="icon" id="sheetIcon"></div><div><h2 id="sheetTitle"></h2><div class="chip" id="sheetChip"></div></div></div>
  <label>Project name<input id="name" placeholder="my-app" autocomplete="off"></label>
  <label>Location<div class="row"><input id="location"><button class="ghost" id="browse">Browse…</button></div></label>
  <label>Describe your app (optional)<textarea id="desc" placeholder="e.g. A to-do list with due dates and reminders. Clean, minimal look."></textarea></label>
  <div class="note" id="sheetNote"></div>
  <div class="err" id="err"></div>
  <div class="actions"><button class="ghost" id="cancel">Cancel</button><button class="primary" id="create">Create project</button></div>
</aside>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const ICONS = ${JSON.stringify(ICONS)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[k] || ICONS.html) + '</svg>';
  let state = null, current = null, filter = 'all';

  function chip(a) {
    if (!a) return '';
    if (a.note) return '<span class="chip off">Needs a Mac</span>';
    if (!a.ok) return '<span class="chip warn">Needs ' + esc(a.missing.map((m) => m.label).join(', ')) + '</span>';
    return '<span class="chip">Ready to go</span>';
  }

  function render() {
    const cats = state.categories;
    $('tabs').innerHTML = [{ id: 'all', title: 'Everything' }, ...cats].map((c) =>
      '<button class="tab" role="tab" aria-selected="' + (filter === c.id) + '" data-tab="' + c.id + '">' + esc(c.title) + '</button>').join('');
    $('sections').innerHTML = cats.filter((c) => filter === 'all' || filter === c.id).map((c) => {
      const cards = state.types.filter((t) => t.category === c.id).map((t) => {
        const a = state.availability[t.id];
        const disabled = a && a.note;
        return '<button class="card" data-id="' + t.id + '"' + (disabled ? ' aria-disabled="true" title="' + esc(a.note) + '"' : '') + '>' +
          '<div class="icon">' + svg(t.icon) + '</div><h3>' + esc(t.title) + '</h3><p>' + esc(disabled ? a.note : t.blurb) + '</p>' + chip(a) + '</button>';
      }).join('');
      return '<section><h2>' + esc(c.title) + '<small>' + esc(c.blurb) + '</small></h2><div class="grid">' + cards + '</div></section>';
    }).join('');
    const recent = state.recent || [];
    $('recent').innerHTML = recent.length
      ? recent.map((r) => '<li><button data-folder="' + esc(r.folder) + '"><span>' + esc(r.folder.split(/[\\\\/]/).pop()) +
          ' <span class="path">' + esc(r.type) + '</span></span><span class="path">' + esc(r.folder) + '</span></button></li>').join('')
      : '<p class="empty">Projects you create will show up here.</p>';
  }

  function openSheet(id) {
    const t = state.types.find((x) => x.id === id);
    const a = state.availability[id];
    if (!t || (a && a.note)) return;
    current = t;
    $('sheetIcon').innerHTML = svg(t.icon);
    $('sheetTitle').textContent = 'New ' + t.title + ' project';
    $('sheetChip').outerHTML = '<div id="sheetChip">' + chip(a) + '</div>';
    let note = 'Setup downloads ' + esc(t.downloads) + '.';
    if (a && !a.ok) note = 'You need ' + a.missing.map((m) => '<a href="#" data-install="' + esc(m.installUrl) + '">' + esc(m.label) + '</a>').join(', ') +
      ' installed first. You can still create the folder now and finish setup later.<br><br>' + note;
    $('sheetNote').innerHTML = note;
    $('err').textContent = '';
    if (!$('name').value) $('name').value = 'my-' + t.id.split('-')[0] + '-app';
    $('scrim').classList.add('open'); $('sheet').classList.add('open'); $('sheet').setAttribute('aria-hidden', 'false');
    setTimeout(() => $('name').select(), 50);
  }
  function closeSheet() { $('scrim').classList.remove('open'); $('sheet').classList.remove('open'); $('sheet').setAttribute('aria-hidden', 'true'); }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]'); if (tab) { filter = tab.dataset.tab; render(); return; }
    const card = e.target.closest('.card'); if (card) { openSheet(card.dataset.id); return; }
    const rec = e.target.closest('[data-folder]'); if (rec) { vscode.postMessage({ type: 'openRecent', folder: rec.dataset.folder }); return; }
    const inst = e.target.closest('[data-install]'); if (inst) { e.preventDefault(); vscode.postMessage({ type: 'install', url: inst.dataset.install }); }
  });
  $('scrim').onclick = closeSheet; $('cancel').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  $('openFolder').onclick = () => vscode.postMessage({ type: 'openFolder' });
  $('browse').onclick = () => vscode.postMessage({ type: 'browse' });
  $('create').onclick = () => {
    $('err').textContent = '';
    $('create').disabled = true; $('create').textContent = 'Creating…';
    vscode.postMessage({ type: 'create', typeId: current.id, name: $('name').value, location: $('location').value, description: $('desc').value });
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'init') { state = data; $('location').value = data.location; render(); }
    if (data.type === 'location') $('location').value = data.location;
    if (data.type === 'createError') { $('err').textContent = data.message; $('create').disabled = false; $('create').textContent = 'Create project'; }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
