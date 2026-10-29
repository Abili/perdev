// A browser the agent can test web apps with: Edge or Chrome already on the PC,
// run headless with its own temporary profile (never the user's), driven over
// the Chrome DevTools Protocol. No downloads, no dependencies.

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

export interface PageCheck {
  url: string;
  title: string;
  status?: number;
  text: string;
  consoleErrors: string[];
  failedRequests: string[];
  screenshot?: string; // base64 JPEG, for the user
}

export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && fs.existsSync(p));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export class HeadlessBrowser {
  private proc?: ChildProcess;
  private port = 0;
  private profile = '';

  private async start() {
    if (this.proc && this.proc.exitCode === null) return;
    const exe = findBrowser();
    if (!exe) throw new Error('No Edge or Chrome found on this PC for testing web pages.');
    this.port = await freePort();
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perdev-browser-'));
    this.proc = spawn(
      exe,
      ['--headless=new', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,800', 'about:blank'],
      { stdio: 'ignore', windowsHide: true },
    );
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('The test browser did not start.');
  }

  // Opens url in a fresh tab and reports what a person would notice.
  async check(url: string, waitMs = 20_000): Promise<PageCheck> {
    await this.start();
    const target: any = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not connect to the test browser.'));
    });
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const requestUrls = new Map<string, string>();
    let status: number | undefined;
    let loaded: () => void = () => {};
    const loadedP = new Promise<void>((r) => (loaded = r));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m.result ?? m);
        pending.delete(m.id);
        return;
      }
      if (m.method === 'Page.loadEventFired') loaded();
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
        consoleErrors.push(m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        consoleErrors.push(`Uncaught ${(d.exception?.description ?? d.text ?? 'error').split('\n')[0]}`.slice(0, 300));
      }
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (m.params.type === 'Document' && status === undefined) status = r.status;
        // Browsers ask for /favicon.ico on their own; a missing one is just noise.
        if (r.status >= 400 && !/\/favicon\.ico(\?|$)/i.test(r.url)) failedRequests.push(`${r.status} ${r.url}`.slice(0, 200));
      }
      if (m.method === 'Network.requestWillBeSent') requestUrls.set(m.params.requestId, m.params.request?.url ?? '');
      if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
        failedRequests.push(`${m.params.errorText} ${requestUrls.get(m.params.requestId) ?? ''} (${m.params.type ?? 'request'})`.slice(0, 300));
      }
    };
    const send = (method: string, params: object = {}) =>
      new Promise<any>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    try {
      await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
      await send('Page.navigate', { url });
      await Promise.race([loadedP, new Promise((r) => setTimeout(r, waitMs))]);
      await new Promise((r) => setTimeout(r, 800)); // let scripts render
      const evalStr = async (expr: string) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value ?? '';
      const title = String(await evalStr('document.title'));
      const finalUrl = String(await evalStr('location.href'));
      const text = String(await evalStr('document.body ? document.body.innerText : ""')).replace(/\n{3,}/g, '\n\n').slice(0, 3000);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      return { url: finalUrl || url, title, status, text, consoleErrors: [...new Set(consoleErrors)].slice(0, 15), failedRequests: [...new Set(failedRequests)].slice(0, 15), screenshot: shot?.data };
    } finally {
      ws.close();
      fetch(`http://127.0.0.1:${this.port}/json/close/${target.id}`).catch(() => {});
    }
  }

  dispose() {
    this.proc?.kill();
    this.proc = undefined;
    if (this.profile) fs.rm(this.profile, { recursive: true, force: true, maxRetries: 5 }, () => {});
  }
}

// What the model reads after a page check.
export function describeCheck(c: PageCheck): string {
  const missing = missingFiles(c.failedRequests);
  const lines = [
    // The 7B otherwise told the user to add the files and checked again, in a loop.
    ...(missing.length
      ? [
          `PROBLEM: the page uses files that don't exist: ${missing.join(', ')}. Fix this yourself now; don't ask the user. ` +
            "Create the missing files, or change the page so it doesn't need them (for pictures, use inline SVG, CSS or emoji instead of <img> files).",
        ]
      : []),
    `Opened ${c.url}${c.status ? ` (HTTP ${c.status})` : ''}. Title: "${c.title || '(none)'}".`,
  ];
  lines.push(c.consoleErrors.length ? `Console errors:\n- ${c.consoleErrors.join('\n- ')}` : 'No console errors.');
  if (c.failedRequests.length) lines.push(`Failed requests:\n- ${c.failedRequests.join('\n- ')}`);
  lines.push(`Visible text:\n${c.text.trim() || '(the page shows no text)'}`);
  lines.push('[A screenshot was shown to the user. You cannot see images; use the text and errors above.]');
  return lines.join('\n\n');
}

// File names of local files that failed to load ("net::ERR_FILE_NOT_FOUND file:///.../dog1.jpg (Image)", "404 http://localhost:8000/x.css").
export function missingFiles(failed: string[]): string[] {
  const names = failed
    .filter((f) => /ERR_FILE_NOT_FOUND|^404 /.test(f))
    .map((f) => f.match(/(?:file:|https?:)\/\/\S+/)?.[0])
    .filter((u): u is string => !!u)
    .map((u) => {
      try {
        return decodeURIComponent(new URL(u).pathname).split('/').pop() || u;
      } catch {
        return u;
      }
    });
  return [...new Set(names)];
}
