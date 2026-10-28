// What the start screen offers to build: categories, cards, how to check the
// tools each needs, and how to set each one up. No VS Code imports.

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { androidProjectFiles, androidWrapperCommand } from './androidTemplate';

export type Category = 'mobile' | 'web' | 'backend';

export interface Requirement {
  label: string;
  // A command to look for on PATH, or files where it may be installed.
  command?: string;
  paths?: string[];
  installUrl: string;
}

export interface ProjectType {
  id: string;
  category: Category;
  title: string;
  blurb: string;
  icon: string; // key into the start page's icon set
  requires: Requirement[];
  // Only possible on these platforms (iOS needs a Mac).
  platforms?: NodeJS.Platform[];
  platformNote?: string;
  // How to set up the project in the new folder: an official generator run in a
  // visible terminal, or small starter files PerDev writes itself (no download).
  setup:
    | { kind: 'command'; command: (name: string) => string; downloads: string }
    // Starter files, optionally followed by a command (e.g. generating the Gradle wrapper).
    | { kind: 'files'; files: (name: string) => Record<string, string>; command?: (name: string) => string | undefined; downloads?: string };
  // What to ask the agent once the project exists.
  agentPrompt: string;
}

const NODE: Requirement = { label: 'Node.js', command: 'node', installUrl: 'https://nodejs.org' };
const PYTHON: Requirement = { label: 'Python', command: 'python', installUrl: 'https://www.python.org/downloads/' };
const FLUTTER: Requirement = { label: 'Flutter SDK', command: 'flutter', installUrl: 'https://docs.flutter.dev/get-started/install/windows' };
const ANDROID_STUDIO: Requirement = {
  label: 'Android Studio',
  paths: ['C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe', 'C:\\Program Files\\Android\\Android Studio1\\bin\\studio64.exe'],
  installUrl: 'https://developer.android.com/studio',
};

// npm package names must be lowercase, URL-safe.
export function packageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-_.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'my-app';
}
// Dart/Flutter package names: lowercase with underscores.
function dartName(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(n) ? n : `app_${n || 'project'}`;
}

export const PROJECT_TYPES: ProjectType[] = [
  // ---- Mobile
  {
    id: 'react-native',
    category: 'mobile',
    title: 'React Native',
    blurb: 'iOS and Android apps in JavaScript/TypeScript, with Expo.',
    icon: 'react',
    requires: [NODE],
    setup: { kind: 'command', command: () => 'npx create-expo-app@latest . --template blank-typescript', downloads: 'about 150 MB of packages' },
    agentPrompt: 'This is a new Expo (React Native) app. Build what I describe below, starting from App.tsx.',
  },
  {
    id: 'flutter',
    category: 'mobile',
    title: 'Flutter',
    blurb: 'One Dart codebase for Android, iOS, web and desktop.',
    icon: 'flutter',
    requires: [FLUTTER],
    setup: { kind: 'command', command: (n) => `flutter create --project-name ${dartName(n)} .`, downloads: 'nothing extra once Flutter is installed' },
    agentPrompt: 'This is a new Flutter app. Build what I describe below, starting from lib/main.dart.',
  },
  {
    id: 'android',
    category: 'mobile',
    title: 'Android (Kotlin)',
    blurb: 'Native Android with Kotlin and Jetpack Compose. Test it on your phone or an emulator.',
    icon: 'android',
    requires: [ANDROID_STUDIO],
    setup: {
      kind: 'files',
      files: (n) => androidProjectFiles(n),
      // gradlew comes from a Gradle already on this PC, offline.
      command: () => androidWrapperCommand(),
      downloads: 'nothing if Android builds have run on this PC before (the build tools are cached); otherwise a few hundred MB on the first build',
    },
    agentPrompt:
      'This is a new Android app (Kotlin, Jetpack Compose) with a working MainActivity under app/src/main/java. Build what I describe below by writing the Kotlin files, then build it and test it on the device.',
  },
  {
    id: 'ios',
    category: 'mobile',
    title: 'iOS (Swift)',
    blurb: 'Native iPhone and iPad apps with SwiftUI.',
    icon: 'apple',
    requires: [],
    platforms: ['darwin'],
    platformNote: 'Building iOS apps needs a Mac with Xcode. On Windows, choose React Native or Flutter to reach iPhones too.',
    setup: { kind: 'files', files: (n) => ({ 'PERDEV.md': `# ${n}\n\nCreate the project in Xcode, then reopen this folder in PerDev.\n` }) },
    agentPrompt: 'This will be an iOS app in SwiftUI. Build what I describe below.',
  },
  // ---- Web
  {
    id: 'static-site',
    category: 'web',
    title: 'Website (HTML, CSS, JS)',
    blurb: 'A plain, fast website. No build step, nothing to download.',
    icon: 'html',
    requires: [],
    setup: {
      kind: 'files',
      files: (n) => ({
        'index.html': `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${n}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>${n}</h1>\n    <p>Your site starts here.</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
        'style.css': `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; }\nmain { max-width: 720px; margin: 4rem auto; padding: 0 1rem; }\n`,
        'app.js': `// Your site's JavaScript.\n`,
      }),
    },
    agentPrompt: 'This is a new static website (index.html, style.css, app.js). Build what I describe below.',
  },
  {
    id: 'react-vite',
    category: 'web',
    title: 'React (Vite)',
    blurb: 'A single-page web app with React and TypeScript.',
    icon: 'react',
    requires: [NODE],
    setup: { kind: 'command', command: () => 'npm create vite@latest . -- --template react-ts && npm install', downloads: 'about 60 MB of packages' },
    agentPrompt: 'This is a new React + TypeScript app (Vite). Build what I describe below, starting from src/App.tsx.',
  },
  {
    id: 'nextjs',
    category: 'web',
    title: 'Next.js',
    blurb: 'Full-stack React with pages, routing and server code.',
    icon: 'next',
    requires: [NODE],
    setup: { kind: 'command', command: () => 'npx create-next-app@latest . --ts --eslint --app --src-dir --use-npm --yes', downloads: 'about 200 MB of packages' },
    agentPrompt: 'This is a new Next.js app (App Router, TypeScript). Build what I describe below.',
  },
  // ---- Backend & scripts
  {
    id: 'node-api',
    category: 'backend',
    title: 'Node.js API',
    blurb: 'A small JSON API with Node\'s built-in HTTP server. No packages needed.',
    icon: 'node',
    requires: [NODE],
    setup: {
      kind: 'files',
      files: (n) => ({
        'package.json': JSON.stringify({ name: packageName(n), version: '0.1.0', private: true, type: 'module', scripts: { start: 'node server.js', test: 'node --test' } }, null, 2) + '\n',
        'server.js': `import { createServer } from 'node:http';\n\nconst port = process.env.PORT || 3000;\n\nconst server = createServer((req, res) => {\n  if (req.url === '/health') {\n    res.writeHead(200, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ ok: true }));\n  }\n  res.writeHead(404, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({ error: 'Not found' }));\n});\n\nserver.listen(port, () => console.log(\`Listening on http://localhost:\${port}\`));\n`,
      }),
    },
    agentPrompt: 'This is a new Node.js API (server.js, no dependencies yet). Build what I describe below and add tests with node --test.',
  },
  {
    id: 'python-api',
    category: 'backend',
    title: 'Python API (FastAPI)',
    blurb: 'A typed Python web API with automatic docs.',
    icon: 'python',
    requires: [PYTHON],
    setup: {
      kind: 'files',
      files: () => ({
        'requirements.txt': 'fastapi\nuvicorn[standard]\n',
        'main.py': `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n\n# Run with: uvicorn main:app --reload\n`,
      }),
    },
    agentPrompt: 'This is a new FastAPI project (main.py, requirements.txt). Build what I describe below. Dependencies are installed with: pip install -r requirements.txt',
  },
  {
    id: 'python-script',
    category: 'backend',
    title: 'Python script',
    blurb: 'Automation, data work or a command-line tool. Nothing to download.',
    icon: 'python',
    requires: [PYTHON],
    setup: {
      kind: 'files',
      files: () => ({
        'main.py': `def main():\n    print("Hello from PerDev")\n\n\nif __name__ == "__main__":\n    main()\n`,
        'test_main.py': `import unittest\n\nimport main\n\n\nclass MainTest(unittest.TestCase):\n    def test_runs(self):\n        main.main()\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
      }),
    },
    agentPrompt: 'This is a new Python project (main.py, test_main.py). Build what I describe below and keep the tests passing (python -m unittest).',
  },
];

export const CATEGORIES: { id: Category; title: string; blurb: string }[] = [
  { id: 'mobile', title: 'Mobile', blurb: 'Apps for phones and tablets' },
  { id: 'web', title: 'Web', blurb: 'Sites and web apps' },
  { id: 'backend', title: 'Backend & scripts', blurb: 'APIs, tools and automation' },
];

export interface Availability {
  ok: boolean;
  missing: Requirement[];
  note?: string;
}

// Which project types can be set up on this PC, checked once per start page.
export async function checkAvailability(platform = process.platform): Promise<Record<string, Availability>> {
  const commands = [...new Set(PROJECT_TYPES.flatMap((t) => t.requires.map((r) => r.command).filter(Boolean) as string[]))];
  const found = new Map<string, boolean>(await Promise.all(commands.map(async (c) => [c, await onPath(c)] as [string, boolean])));
  const out: Record<string, Availability> = {};
  for (const t of PROJECT_TYPES) {
    if (t.platforms && !t.platforms.includes(platform)) {
      out[t.id] = { ok: false, missing: [], note: t.platformNote };
      continue;
    }
    const missing = t.requires.filter((r) => (r.command ? !found.get(r.command) : !(r.paths ?? []).some((p) => fs.existsSync(p))));
    out[t.id] = { ok: missing.length === 0, missing };
  }
  return out;
}

function onPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => execFile(finder, [command], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err)));
}

// Writes a starter's files (never overwriting existing ones). Returns what was written.
export function writeStarterFiles(dir: string, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    written.push(rel);
  }
  return written;
}
