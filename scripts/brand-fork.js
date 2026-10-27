// Prepares a VSCodium checkout to build PerDev from source (used by
// .github/workflows/build-windows.yml before VSCodium's own build scripts run):
//   - PerDev identity merged into VSCodium's product.json overrides
//   - PerDev icons in src/stable (copied over the VS Code source by prepare_vscode.sh)
//   - the PerDev AI extension added as a built-in extension
// Usage: npm run compile && node scripts/brand-fork.js <vscodium-dir>

const fs = require('fs');
const path = require('path');
const { PRODUCT, REMOVE, brandIcons, copyExtension } = require('./branding');

const dir = path.resolve(process.argv[2] || 'vscodium');
if (!fs.existsSync(path.join(dir, 'prepare_vscode.sh'))) {
  console.error(`${dir} is not a VSCodium checkout`);
  process.exit(1);
}

// prepare_vscode.sh deep-merges this file over the product.json it generates.
// null removes VSCodium's update/issue URLs (falsy values disable them).
const overridesPath = path.join(dir, 'product.json');
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
Object.assign(overrides, PRODUCT);
for (const k of REMOVE) overrides[k] = null;
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2));

const stable = path.join(dir, 'src', 'stable');
const icons = brandIcons(stable);
copyExtension(path.join(stable, 'extensions', 'perdev'));

console.log(`PerDev branding applied to ${dir}: product overrides, ${icons} icon files, built-in extension.`);
