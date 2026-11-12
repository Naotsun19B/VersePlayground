// Bundles the extension and its runtime dependencies into dist/extension.js, so the .vsix needs no node_modules, and
// writes dist/ThirdPartyNotices.txt with the license of every package that ended up in the bundle.
// Usage: node esbuild.mjs [--production] [--watch]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  // VS Code 1.91 runs extensions on Electron's Node 20.
  target: 'node20',
  // Provided by VS Code at run time.
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  metafile: true,
  logLevel: 'info',
};

/** Writes the license texts of the npm packages whose files the bundle contains. */
function writeThirdPartyNotices(metafile) {
  const packageNames = new Set();
  for (const inputPath of Object.keys(metafile.inputs)) {
    const packageMatch = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(inputPath);
    if (packageMatch !== null) {
      packageNames.add(packageMatch[1]);
    }
  }

  const sections = [...packageNames].sort().map((packageName) => {
    const packageDir = path.join('node_modules', packageName);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const licenseFileName = fs.readdirSync(packageDir).find((fileName) => /^licen[cs]e/i.test(fileName));
    if (licenseFileName === undefined) {
      throw new Error(`${packageName} has no license file to include in ThirdPartyNotices.txt.`);
    }
    const licenseText = fs.readFileSync(path.join(packageDir, licenseFileName), 'utf8').trim();
    return `${packageName} ${packageJson.version} (${packageJson.license})\n\n${licenseText}\n`;
  });

  const header = 'Verse Playground bundles the following packages.\n';
  const separator = `\n${'-'.repeat(80)}\n\n`;
  fs.writeFileSync('dist/ThirdPartyNotices.txt', `${header}${separator}${sections.join(separator)}`);
}

if (isWatch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
} else {
  const buildResult = await esbuild.build(buildOptions);
  writeThirdPartyNotices(buildResult.metafile);
}
