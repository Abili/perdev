// Official documentation lookup for the agent, via DevDocs (devdocs.io), which
// serves the official docs of hundreds of languages and libraries (Python, MDN
// JavaScript/HTML/CSS/Web APIs, Node.js, React, Rust, Go, ...) in one format.
// Built for slow connections: only small search indexes and single pages are
// downloaded, and everything is cached on disk.

import * as fs from 'fs/promises';
import * as path from 'path';

const CATALOG_URL = 'https://devdocs.io/docs.json';
const DOCS_URL = 'https://documents.devdocs.io';
const CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const INDEX_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_SECTION_CHARS = 6000;

interface DocSet {
  name: string;
  slug: string;
  version?: string;
  release?: string;
  alias?: string;
}
interface IndexEntry {
  name: string;
  path: string;
  type: string;
}

// What the model is likely to say, mapped to DevDocs names.
const ALIASES: Record<string, string> = {
  py: 'python', js: 'javascript', ecmascript: 'javascript', ts: 'typescript', nodejs: 'node.js', node: 'node.js',
  'web apis': 'web apis', webapi: 'web apis', browser: 'web apis', dom: 'web apis', golang: 'go', 'c++': 'c++', cpp: 'c++',
  java: 'openjdk', jdk: 'openjdk', sh: 'bash', shell: 'bash', reactjs: 'react', vuejs: 'vue', np: 'numpy', pd: 'pandas',
};

export class DocsLookup {
  constructor(
    private readonly cacheDir: string,
    private readonly fetchText: (url: string) => Promise<string> = httpGet,
  ) {}

  // Run the lookup_docs tool. Returns text for the model.
  async lookup(args: { docs?: string; query?: string; page?: string }): Promise<string> {
    const docs = (args.docs ?? '').trim();
    if (!docs) return 'Error: say which documentation to search in "docs", e.g. "python", "javascript", "node", "react".';
    const set = await this.resolveSet(docs);
    if (typeof set === 'string') return set;

    if (args.page) {
      const section = await this.readPage(set, args.page);
      return `${set.name} ${set.release ?? ''} documentation: ${args.page}\n\n${section}`;
    }
    const query = (args.query ?? '').trim();
    if (!query) return 'Error: give a "query" (e.g. "str.join") or a "page" from an earlier lookup.';
    const index = await this.index(set);
    const hits = rank(index, query).slice(0, 7);
    if (hits.length === 0) return `No matches for "${query}" in the ${set.name} documentation. Try a shorter or different name.`;
    const best = hits[0];
    const section = await this.readPage(set, best.path);
    const others = hits.slice(1).map((h) => `- ${h.name} (${h.type}) page: ${h.path}`).join('\n');
    return (
      `${set.name} ${set.release ?? ''} documentation, best match: ${best.name} (page: ${best.path})\n\n${section}` +
      (others ? `\n\nOther matches (pass one as "page" to read it):\n${others}` : '')
    );
  }

  async resolveSet(name: string): Promise<DocSet | string> {
    const catalog = await this.cached<DocSet[]>('catalog.json', CATALOG_URL, CATALOG_MAX_AGE_MS);
    return pickDocSet(catalog, name);
  }

  private async index(set: DocSet): Promise<IndexEntry[]> {
    const idx = await this.cached<{ entries: IndexEntry[] }>(`${safe(set.slug)}/index.json`, `${DOCS_URL}/${set.slug}/index.json`, INDEX_MAX_AGE_MS);
    return idx.entries ?? [];
  }

  private async readPage(set: DocSet, pagePath: string): Promise<string> {
    const [file, fragment] = pagePath.split('#');
    const rel = `${safe(set.slug)}/pages/${safe(file)}.html`;
    const html = await this.cachedText(rel, `${DOCS_URL}/${set.slug}/${file}.html`, Infinity);
    return extractSection(html, fragment, MAX_SECTION_CHARS);
  }

  private async cached<T>(rel: string, url: string, maxAge: number): Promise<T> {
    return JSON.parse(await this.cachedText(rel, url, maxAge)) as T;
  }

  private async cachedText(rel: string, url: string, maxAge: number): Promise<string> {
    const file = path.join(this.cacheDir, rel);
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs < maxAge) return await fs.readFile(file, 'utf8');
    } catch {
      // not cached yet
    }
    let text: string;
    try {
      text = await this.fetchText(url);
    } catch (e) {
      // Offline or slow: an old copy beats nothing.
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        throw e;
      }
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    return text;
  }
}

async function httpGet(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'PerDev (https://github.com/Abili/perdev)' }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function safe(p: string): string {
  return p.replace(/[^A-Za-z0-9._~/-]/g, '_').replace(/\.\.+/g, '_');
}

// Finds the doc set for a name like "python", "python 3.12", "js" or "node".
// Picks the newest version unless one is given.
export function pickDocSet(catalog: DocSet[], requested: string): DocSet | string {
  const q = requested.toLowerCase().trim();
  const exact = catalog.find((d) => d.slug.toLowerCase() === q);
  if (exact) return exact;
  const m = q.match(/^(.*?)[\s~@-]*v?(\d+(?:\.\d+)*)$/);
  const baseName = (m ? m[1] : q).trim();
  const wantVersion = m ? m[2] : undefined;
  const name = ALIASES[baseName] ?? baseName;
  const candidates = catalog.filter(
    (d) => d.name.toLowerCase() === name || d.slug.split('~')[0].toLowerCase() === name || (d.alias ?? '').toLowerCase() === baseName,
  );
  if (candidates.length === 0) {
    const near = catalog
      .filter((d) => d.name.toLowerCase().includes(name) || d.slug.includes(name))
      .slice(0, 8)
      .map((d) => d.slug);
    return `Error: no documentation named "${requested}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Try e.g. python, javascript, typescript, node, react, html, css, dom, rust, go.'}`;
  }
  if (wantVersion) {
    const v = candidates.find((d) => (d.release ?? '').startsWith(wantVersion) || (d.version ?? '').startsWith(wantVersion) || d.slug.endsWith(`~${wantVersion}`));
    if (v) return v;
  }
  return [...candidates].sort((a, b) => compareVersions(b.release ?? b.version ?? '', a.release ?? a.version ?? ''))[0];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Best index entries for a query like "str.join", "join string", "Array map".
export function rank(entries: IndexEntry[], query: string): IndexEntry[] {
  // DevDocs names JavaScript methods "Array.map", not "Array.prototype.map".
  const q = query.toLowerCase().replace(/\(\)$/, '').replace(/\.prototype\./g, '.').trim();
  const words = q.split(/[\s.,:#/]+/).filter(Boolean);
  const scored: { e: IndexEntry; s: number }[] = [];
  for (const e of entries) {
    const n = e.name.toLowerCase().replace(/\(\)$/, '');
    let s = 0;
    if (n === q) s = 100;
    else if (n.endsWith('.' + q) || n.endsWith(' ' + q)) s = 80;
    else if (n.startsWith(q)) s = 60;
    else if (n.includes(q)) s = 45;
    else if (words.length > 1 && words.every((w) => n.includes(w))) s = 30;
    else if (words.some((w) => w.length > 2 && n.split(/[\s.]+/).includes(w))) s = 10;
    if (s > 0) scored.push({ e, s: s - n.length / 100 });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.e);
}

// The part of a doc page about one entry (from its anchor to the next
// same-level entry or heading), as plain text. Whole page if no anchor.
export function extractSection(html: string, fragment: string | undefined, maxChars: number): string {
  let part = html;
  if (fragment) {
    const at = html.search(new RegExp(`id=["']${escapeRe(fragment)}["']`));
    if (at >= 0) {
      const tagStart = html.lastIndexOf('<', at);
      const tagName = (html.slice(tagStart + 1).match(/^[a-zA-Z0-9]+/) ?? ['div'])[0].toLowerCase();
      const rest = html.slice(tagStart);
      // Stop at the next sibling entry (same tag with an id) or the next heading.
      const stop = new RegExp(`<(${tagName}|h[1-4])\\b[^>]*\\bid=`, 'gi');
      stop.lastIndex = 1;
      const next = stop.exec(rest);
      part = next ? rest.slice(0, next.index) : rest;
    }
  }
  const text = htmlToText(part);
  return text.length > maxChars ? text.slice(0, maxChars) + '\n... [section truncated; ask for a more specific page]' : text;
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => `\n\`\`\`\n${decode(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => '`' + c.replace(/<[^>]+>/g, '') + '`')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => '\n\n' + '#'.repeat(Math.min(Number(n) + 1, 4)) + ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|dt|dd|tr|h[1-6]|ul|ol|table|section|dl)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  // Code blocks were decoded already; decode the rest without touching them twice.
  s = s
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) => (i % 2 ? chunk : decode(chunk)))
    .join('');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
