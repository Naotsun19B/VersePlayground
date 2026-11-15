// Copyright (c) 2026 Naotsun

// Bundles the extension into dist/extension.js and the language server into dist/server.js, each with its runtime
// dependencies, so the .vsix needs no node_modules. Fails when dist/server.js would load vscode, which only exists
// inside the extension host: the server runs in a plain Node process and would only break at run time. Writes
// dist/ThirdPartyNotices.txt with the license of every package that ended up in either bundle, and copies the
// repository's LICENSE next to package.json, where vsce looks for it.
// Usage: node esbuild.mjs [--production] [--watch]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** The bundle of the language server, as esbuild names it in the metafile. */
const SERVER_OUTPUT = 'dist/server.js';

/** Returns the messages for every import of vscode that the language server bundle makes. */
function findVscodeImportsOfServer(metafile) {
  const serverOutput = metafile.outputs[SERVER_OUTPUT];
  if (serverOutput === undefined) {
    return [`${SERVER_OUTPUT} is missing from the build output.`];
  }

  return serverOutput.imports
    .filter((serverImport) => serverImport.path === 'vscode' || serverImport.path.startsWith('vscode/'))
    .map((serverImport) => `${SERVER_OUTPUT} imports "${serverImport.path}", which does not exist outside VS Code.`);
}

/** Reports a server bundle that imports vscode after every rebuild of the watch mode. */
const checkServerImportsPlugin = {
  name: 'check-server-imports',
  setup(build) {
    build.onEnd((result) => {
      if (result.metafile === undefined) {
        return;
      }

      for (const message of findVscodeImportsOfServer(result.metafile)) {
        console.error(`error: ${message}`);
      }
    });
  },
};

const buildOptions = {
  entryPoints: {
    extension: 'src/extension.ts',
    server: 'src/server/main.ts',
  },
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  format: 'cjs',
  // VS Code 1.91 runs extensions on Electron's Node 20, and the language server runs on the same Node.
  target: 'node20',
  // Provided by VS Code at run time. Only the extension may use it.
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  metafile: true,
  logLevel: 'info',
};

/** Writes the license texts of the npm packages whose files the bundles contain. */
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

/**
 * Copies the repository's LICENSE into the extension folder. vsce only packages files under this folder, and keeping
 * a copy in git would let the two drift apart, so the copy is made on every build and ignored by git.
 */
function copyRepositoryLicense() {
  fs.copyFileSync(path.join('..', 'LICENSE'), 'LICENSE');
}

if (isWatch) {
  const context = await esbuild.context({ ...buildOptions, plugins: [checkServerImportsPlugin] });
  await context.watch();
} else {
  const buildResult = await esbuild.build(buildOptions);
  const importMessages = findVscodeImportsOfServer(buildResult.metafile);
  if (importMessages.length > 0) {
    throw new Error(importMessages.join('\n'));
  }
  writeThirdPartyNotices(buildResult.metafile);
  copyRepositoryLicense();
}
