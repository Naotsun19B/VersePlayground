// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { buildWorkspaceProject, toSourceFolders, USER_VERSE_PATH } from '../src/verse-project.ts';

/** A cut-down VNI.vproject with the shape UnrealBuildTool writes. */
const VNI_PROJECT_TEXT = JSON.stringify({
  packages: [
    {
      desc: {
        name: 'Engine/VerseCmd',
        publicName: '',
        dirPath: 'E:\\Engine\\Source\\Programs\\VerseCmd\\Verse',
        settings: {
          versePath: '/Verse.org/Verse',
          verseScope: 'PublicAPI',
          dependencyPackages: ['Verse/Verse', 'VerseSpatialMath/VerseSpatialMath'],
          vniDestDir: 'E:\\Engine\\Intermediate\\VNI',
          enableVNI: true,
        },
      },
      readOnly: true,
    },
    {
      desc: {
        name: 'Verse/Verse',
        publicName: '',
        dirPath: 'E:\\Engine\\Plugins\\Verse\\Verse\\Source\\Verse\\Verse',
        settings: { versePath: '/Verse.org', verseScope: 'PublicAPI', dependencyPackages: [], enableVNI: false },
      },
      readOnly: true,
    },
    {
      desc: {
        name: 'VerseSpatialMath/VerseSpatialMath',
        publicName: '',
        dirPath: 'E:\\Engine\\Plugins\\Verse\\VerseSpatialMath',
        settings: { versePath: '/Verse.org', verseScope: 'PublicAPI', dependencyPackages: ['Verse/Verse'] },
      },
      readOnly: true,
    },
  ],
});

test('leaves out the excluded engine packages and every dependency on them', () => {
  const workspaceProject = buildWorkspaceProject(VNI_PROJECT_TEXT, [], 'C:\\Storage\\vni');
  const packageNames = workspaceProject.packages.map((packageEntry) => packageEntry.desc.name);
  assert.deepEqual(packageNames, ['Engine/VerseCmd', 'Verse/Verse']);
  assert.deepEqual(workspaceProject.packages[0].desc.settings.dependencyPackages, ['Verse/Verse']);
});

test('enables VNI for engine packages and sends its output outside the engine', () => {
  const workspaceProject = buildWorkspaceProject(VNI_PROJECT_TEXT, [], 'C:\\Storage\\vni');
  for (const enginePackage of workspaceProject.packages) {
    assert.equal(enginePackage.desc.settings.enableVNI, true);
    assert.equal(enginePackage.desc.settings.vniDestDir, 'C:\\Storage\\vni');
    assert.equal(enginePackage.readOnly, true);
  }
});

test('gives each user folder its own package that depends on every engine package', () => {
  const workspaceProject = buildWorkspaceProject(VNI_PROJECT_TEXT, ['C:\\Code\\One', 'C:\\Code\\Two'], 'C:\\Vni');
  const userPackages = workspaceProject.packages.filter((packageEntry) => packageEntry.readOnly === false);
  assert.equal(userPackages.length, 2);
  assert.notEqual(userPackages[0].desc.name, userPackages[1].desc.name);
  assert.deepEqual(userPackages.map((userPackage) => userPackage.desc.dirPath), ['C:\\Code\\One', 'C:\\Code\\Two']);
  for (const userPackage of userPackages) {
    assert.equal(userPackage.desc.settings.versePath, USER_VERSE_PATH);
    assert.equal(userPackage.desc.settings.role, 'Source');
    assert.deepEqual(userPackage.desc.settings.dependencyPackages, ['Engine/VerseCmd', 'Verse/Verse']);
  }
});

test('does not change the parsed input when it builds the project', () => {
  const vniProject = JSON.parse(VNI_PROJECT_TEXT);
  buildWorkspaceProject(VNI_PROJECT_TEXT, ['C:\\Code'], 'C:\\Vni');
  assert.deepEqual(JSON.parse(VNI_PROJECT_TEXT), vniProject);
});

test('rejects text that is not a Verse project', () => {
  assert.throws(() => buildWorkspaceProject('{"name":"x"}', [], 'C:\\Vni'), /packages/);
  assert.throws(() => buildWorkspaceProject('{"packages":[{"desc":{}}]}', [], 'C:\\Vni'), /desc/);
});

test('lists each folder once, ignoring case, in a stable order', () => {
  const sourceFolders = toSourceFolders(
    ['C:\\Code\\Two\\B.verse', 'C:\\Code\\One\\A.verse', 'c:\\code\\one\\C.verse'],
    path.win32.dirname,
  );
  assert.deepEqual(sourceFolders, ['c:\\code\\one', 'C:\\Code\\Two']);
});
