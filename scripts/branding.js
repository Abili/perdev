// PerDev branding shared by the quick build (scripts/build-app.js, patches a
// VSCodium release) and the source build (scripts/brand-fork.js, patches a
// VSCodium checkout before compiling).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const NAME = 'PerDev';

// product.json identity. New Windows app/registry ids so PerDev never collides
// with a VSCodium or VS Code install.
const PRODUCT = {
  nameShort: NAME,
  nameLong: NAME,
  applicationName: 'perdev',
  dataFolderName: '.perdev',
  linuxIconName: 'perdev',
  urlProtocol: 'perdev',
  serverApplicationName: 'perdev-server',
  serverDataFolderName: '.perdev-server',
  darwinBundleIdentifier: 'dev.perdev.PerDev',
  win32AppUserModelId: 'PerDev.PerDev',
  win32DirName: NAME,
  win32MutexName: 'perdev',
  win32NameVersion: NAME,
  win32RegValueName: NAME,
  win32ShellNameShort: 'P&erDev',
  win32AppId: '{{5B8E3B7A-2F4C-4E8B-9C61-7A2D9E40C1A1}',
  win32x64AppId: '{{8C1F6D2E-4A7B-4F3C-B5D9-1E6A2C8F0B3D}',
  win32arm64AppId: '{{2D9A4E6F-8B1C-4C7D-A3E5-6F0B8D2C4A9E}',
  win32UserAppId: '{{E4B7C1D9-3F6A-4B2E-8D5C-9A1F7E3B6C20}',
  win32x64UserAppId: '{{7A3C9E1F-5D2B-4E8A-B6C4-0F9D3A7E5B18}',
  win32arm64UserAppId: '{{C6E2A8B4-1D9F-4A3C-9E7B-5B0D2F8A6C34}',
  tunnelApplicationName: 'perdev-tunnel',
  win32TunnelServiceMutex: 'perdev-tunnelservice',
  win32TunnelMutex: 'perdev-tunnel',
  win32ContextMenu: {
    x64: { clsid: '3F8A1C6E-9B2D-4E7A-A5C3-8D1F6B4E2A90' },
    arm64: { clsid: 'A1D7E3B9-6C4F-4A2E-8B5D-2E9C7F1A3B64' },
  },
};

// Fields that would point PerDev at VSCodium's updates, issue tracker, etc.
const REMOVE = ['updateUrl', 'downloadUrl', 'releaseNotesUrl', 'reportIssueUrl', 'requestFeatureUrl', 'twitterUrl', 'licenseUrl'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') yield* walk(p);
    } else yield p;
  }
}

// Replace product icons and the editor watermark anywhere under dir.
function brandIcons(dir) {
  const svg = fs.readFileSync(path.join(MEDIA, 'logo.svg'), 'utf8');
  const strokesOnly = (color, opacity) =>
    svg
      .replace(/<title>.*?<\/title>\s*/, '')
      .replace(/<rect[^>]*\/>\s*/, '')
      .replace('stroke="#2D5BFF"', `stroke="${color}" stroke-opacity="${opacity}"`);
  let n = 0;
  for (const file of walk(dir)) {
    const base = path.basename(file);
    const copy = (src) => (fs.copyFileSync(path.join(MEDIA, src), file), n++);
    const write = (text) => (fs.writeFileSync(file, text), n++);
    if (base === 'code-icon.svg' || (base === 'code.svg' && file.includes(`${path.sep}linux${path.sep}`))) write(svg);
    else if (/^letterpress-(dark|hcDark)\.svg$/.test(base)) write(strokesOnly('#ffffff', 0.08));
    else if (/^letterpress(-light|-hcLight)?\.svg$/.test(base)) write(strokesOnly('#000000', 0.08));
    else if (base === 'code.ico' || base === 'favicon.ico') copy('perdev.ico');
    else if (/^code_(70x70|150x150)\.png$/.test(base)) copy('perdev-128.png');
    else if (base === 'code-192.png' || (base === 'code.png' && file.includes(`${path.sep}linux${path.sep}`))) copy('perdev-256.png');
    else if (base === 'code-512.png') copy('perdev-512.png');
  }
  return n;
}

// Copy the compiled PerDev AI extension (run `npm run compile` first).
function copyExtension(dest) {
  if (!fs.existsSync(path.join(ROOT, 'out', 'extension.js'))) throw new Error('Run "npm run compile" first.');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['package.json', 'README.md', 'media', 'training/perdev_format.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  }
  fs.cpSync(path.join(ROOT, 'out'), path.join(dest, 'out'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}test`) && !src.endsWith('.map'),
  });
  // Used by VS Code's build to decide which files ship (no runtime dependencies).
  fs.writeFileSync(path.join(dest, '.vscodeignore'), 'src/**\n**/*.map\n**/test/**\n');
}

module.exports = { NAME, PRODUCT, REMOVE, brandIcons, copyExtension, walk };
