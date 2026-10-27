// Builds the standalone PerDev app from a VSCodium Windows release zip:
//   - rebrands it (name, exe, icons, data folders) and turns off VSCodium's updater
//   - builds the PerDev AI extension in as a built-in extension
//   - runs in portable mode: all settings, chats and extensions stay in <out>\data
//
// Usage: npm run compile && node scripts/build-app.js [VSCodium.zip] [outDir]
// Defaults: newest E:\Tools\downloads\VSCodium-win32-x64-*.zip -> E:\Tools\PerDev
// Rebuilding keeps <outDir>\data (your settings and chats).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RCEDIT = 'E:\\Tools\\rcedit\\rcedit-x64.exe';
const NAME = 'PerDev';

const zip = process.argv[2] || newest('E:\\Tools\\downloads', /^VSCodium-win32-x64-.*\.zip$/);
const outDir = path.resolve(process.argv[3] || 'E:\\Tools\\PerDev');
if (!zip || !fs.existsSync(zip)) fail(`VSCodium zip not found (${zip}). Download it first (see README).`);
if (!fs.existsSync(path.join(ROOT, 'out', 'extension.js'))) fail('Run "npm run compile" first.');

const stage = outDir + '.build';
step(`Extracting ${path.basename(zip)}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
execFileSync('tar', ['-xf', zip, '-C', stage], { stdio: 'inherit' });

// --- product.json: identity, data folders, no VSCodium updater -----------------
const productPath = findFile(stage, 'product.json', (p) => p.includes(`${path.sep}resources${path.sep}app${path.sep}`));
const appDir = path.dirname(productPath);
step(`Rebranding ${path.relative(stage, productPath)}`);
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const exeOld = (product.win32ExeBasename || 'VSCodium') + '.exe';
Object.assign(product, {
  nameShort: NAME,
  nameLong: NAME,
  applicationName: 'perdev',
  dataFolderName: '.perdev',
  win32MutexName: 'perdev',
  win32DirName: NAME,
  win32NameVersion: NAME,
  win32RegValueName: NAME,
  win32AppUserModelId: 'PerDev.PerDev',
  win32ShellNameShort: 'P&erDev',
  win32ExeBasename: NAME,
  urlProtocol: 'perdev',
  serverApplicationName: 'perdev-server',
  serverDataFolderName: '.perdev-server',
  tunnelApplicationName: 'perdev-tunnel',
});
// Without this, the built-in updater would replace PerDev with stock VSCodium.
for (const k of ['updateUrl', 'downloadUrl', 'releaseNotesUrl', 'reportIssueUrl', 'requestFeatureUrl', 'twitterUrl', 'licenseUrl', 'win32x64AppId', 'win32arm64AppId', 'win32x64UserAppId', 'win32arm64UserAppId']) {
  delete product[k];
}
fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'));

// --- Built-in PerDev extension ---------------------------------------------------
step('Building in the PerDev AI extension');
const extDir = path.join(appDir, 'extensions', 'perdev');
fs.rmSync(extDir, { recursive: true, force: true });
fs.mkdirSync(extDir, { recursive: true });
for (const item of ['package.json', 'README.md', 'media', 'training/perdev_format.json']) {
  fs.cpSync(path.join(ROOT, item), path.join(extDir, item), { recursive: true });
}
fs.cpSync(path.join(ROOT, 'out'), path.join(extDir, 'out'), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}test`) && !src.endsWith('.map'),
});

// --- Icons ------------------------------------------------------------------------
step('Applying PerDev icons');
const media = path.join(ROOT, 'media');
const svg = fs.readFileSync(path.join(media, 'logo.svg'), 'utf8');
const strokesOnly = (color, opacity) =>
  svg.replace(/<title>.*?<\/title>\s*/, '').replace(/<rect[^>]*\/>\s*/, '').replace('stroke="#2D5BFF"', `stroke="${color}" stroke-opacity="${opacity}"`);
for (const file of walk(appDir)) {
  const base = path.basename(file);
  if (base === 'code-icon.svg') fs.writeFileSync(file, svg);
  else if (/^letterpress-(dark|hcDark)\.svg$/.test(base)) fs.writeFileSync(file, strokesOnly('#ffffff', 0.08));
  else if (/^letterpress(-light|-hcLight)?\.svg$/.test(base)) fs.writeFileSync(file, strokesOnly('#000000', 0.08));
  else if (base === 'code.ico') fs.copyFileSync(path.join(media, 'perdev.ico'), file);
  else if (/^code_(70x70|150x150)\.png$/.test(base)) fs.copyFileSync(path.join(media, 'perdev-128.png'), file);
}

// --- Executable: rename, icon and version strings -------------------------------
const exePath = findFile(stage, exeOld, () => true);
const newExe = path.join(path.dirname(exePath), `${NAME}.exe`);
fs.renameSync(exePath, newExe);
if (fs.existsSync(RCEDIT)) {
  step('Setting PerDev.exe icon and details');
  execFileSync(RCEDIT, [newExe, '--set-icon', path.join(media, 'perdev.ico'),
    '--set-version-string', 'ProductName', NAME, '--set-version-string', 'FileDescription', NAME,
    '--set-version-string', 'CompanyName', NAME, '--set-version-string', 'InternalName', NAME,
    '--set-version-string', 'OriginalFilename', `${NAME}.exe`], { stdio: 'inherit' });
} else {
  console.warn(`  rcedit not found at ${RCEDIT}; PerDev.exe keeps the VSCodium icon.`);
}
// Command-line launcher: bin\codium.cmd -> bin\perdev.cmd
const binDir = path.join(path.dirname(newExe), 'bin');
for (const f of fs.existsSync(binDir) ? fs.readdirSync(binDir) : []) {
  const p = path.join(binDir, f);
  const ext = path.extname(f);
  if (!/^codium/i.test(f)) continue;
  const text = fs.readFileSync(p, 'utf8').split(exeOld).join(`${NAME}.exe`);
  fs.writeFileSync(path.join(binDir, 'perdev' + ext), text);
  fs.rmSync(p);
}

// --- Portable mode: keep user data on E: -----------------------------------------
const dataDir = path.join(outDir, 'data');
const settingsFile = path.join(dataDir, 'user-data', 'User', 'settings.json');
if (!fs.existsSync(settingsFile)) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'perdev.dataDir': path.join(dataDir, 'perdev'),
  }, null, 2));
}

// --- Swap the new build in, keeping data/ ------------------------------------------
step(`Installing to ${outDir}`);
const exeRel = path.relative(stage, newExe);
if (fs.existsSync(outDir)) {
  for (const f of fs.readdirSync(outDir)) if (f !== 'data') fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
} else {
  fs.mkdirSync(outDir, { recursive: true });
}
for (const f of fs.readdirSync(stage)) fs.renameSync(path.join(stage, f), path.join(outDir, f));
fs.rmSync(stage, { recursive: true, force: true });
// Portable data must sit next to the executable.
const exeDir = path.dirname(path.join(outDir, exeRel));
if (path.resolve(exeDir) !== outDir && !fs.existsSync(path.join(exeDir, 'data'))) fs.renameSync(dataDir, path.join(exeDir, 'data'));

console.log(`\nPerDev ${product.version ?? ''} built: ${path.join(outDir, exeRel)}`);

// --- helpers -------------------------------------------------------------------------
function step(msg) {
  console.log(`- ${msg}`);
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}
function newest(dir, re) {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') yield* walk(p);
    } else yield p;
  }
}
function findFile(dir, name, pred) {
  for (const p of walk(dir)) if (path.basename(p) === name && pred(p)) return p;
  fail(`${name} not found in ${dir}`);
}
