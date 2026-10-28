// Builds the standalone PerDev app from a VSCodium Windows release zip:
//   - rebrands it (name, exe, icons, data folders) and turns off VSCodium's updater
//   - builds the PerDev AI extension in as a built-in extension
//   - runs in portable mode: all settings, chats and extensions stay in <out>\data
//
// Usage: npm run compile && node scripts/build-app.js [VSCodium.zip] [outDir]
// Defaults: newest E:\Tools\downloads\VSCodium-win32-x64-*.zip -> D:\PerDev
// (D: is the SSD; from the USB hard disk E: the app took minutes to start).
// Rebuilding keeps <outDir>\data (your settings and chats).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { NAME, PRODUCT, REMOVE, brandIcons, copyExtension, walk } = require('./branding');

const ROOT = path.resolve(__dirname, '..');
const RCEDIT = 'E:\\Tools\\rcedit\\rcedit-x64.exe';

const zip = process.argv[2] || newest('E:\\Tools\\downloads', /^VSCodium-win32-x64-.*\.zip$/);
const outDir = path.resolve(process.argv[3] || 'D:\\PerDev');
if (!zip || !fs.existsSync(zip)) fail(`VSCodium zip not found (${zip}). Download it first (see README).`);
if (!fs.existsSync(path.join(ROOT, 'out', 'extension.js'))) fail('Run "npm run compile" first.');

// Windows locks a running app's files; replacing them half-way breaks the install.
const running = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${NAME}.exe`, '/NH'], { encoding: 'utf8' });
if (running.toLowerCase().includes(`${NAME.toLowerCase()}.exe`)) fail(`${NAME} is running. Close it, then build again.`);

const stage = outDir + '.build';
step(`Extracting ${path.basename(zip)}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
// -m: don't restore timestamps (fails on exFAT drives like this E:).
execFileSync('tar', ['-xmf', zip, '-C', stage], { stdio: 'inherit' });

// --- product.json: identity, data folders, no VSCodium updater -----------------
const productPath = findFile(stage, 'product.json', (p) => p.includes(`${path.sep}resources${path.sep}app${path.sep}`));
const appDir = path.dirname(productPath);
step(`Rebranding ${path.relative(stage, productPath)}`);
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const exeOld = (product.win32ExeBasename || 'VSCodium') + '.exe';
Object.assign(product, PRODUCT, { win32ExeBasename: NAME });
// Without this, the built-in updater would replace PerDev with stock VSCodium.
for (const k of REMOVE) delete product[k];
fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'));

step('Building in the PerDev AI extension');
copyExtension(path.join(appDir, 'extensions', 'perdev'));

step('Applying PerDev icons');
const media = path.join(ROOT, 'media');
brandIcons(appDir);

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
function findFile(dir, name, pred) {
  for (const p of walk(dir)) if (path.basename(p) === name && pred(p)) return p;
  fail(`${name} not found in ${dir}`);
}
