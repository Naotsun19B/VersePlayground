// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { FolderWatcher, type WatchFunction } from '../src/server/folder-watcher.ts';

/** Waits until the condition holds, or fails the test after a bounded time. */
async function waitUntil(isReached: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!isReached()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** Creates an empty temporary folder. */
function createTemporaryFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verse-watch-'));
}

/** A watcher that tests can drive by hand. */
class FakeFsWatcher extends EventEmitter {
  // Whether close was called.
  public isClosed = false;

  public close(): void {
    this.isClosed = true;
  }
}

/** A fake watcher that was handed out, with what it was created for. */
interface CreatedWatcher {
  // The folder that was watched.
  folder: string;

  // The fake watcher.
  watcher: FakeFsWatcher;

  // The listener that the code under test registered.
  listener: (eventType: string, fileName: string | null) => void;
}

/** Builds a watch function that hands out fake watchers and remembers them with their listeners. */
function createFakeWatch(): {
  watch: WatchFunction;
  created: CreatedWatcher[];
} {
  const created: CreatedWatcher[] = [];
  const watch: WatchFunction = (folder, listener) => {
    const watcher = new FakeFsWatcher();
    created.push({ folder, watcher, listener });
    return watcher as unknown as fs.FSWatcher;
  };
  return { watch, created };
}

test('creating, changing and deleting a .verse file in a real folder are reported', async () => {
  const folder = createTemporaryFolder();
  const changes: string[] = [];
  const watcher = new FolderWatcher({ onChange: (changed) => changes.push(changed), onError: () => {} });
  try {
    assert.deepEqual(watcher.watch(folder), { status: 'watching' });
    const filePath = path.join(folder, 'Main.verse');

    fs.writeFileSync(filePath, 'a');
    await waitUntil(() => changes.length >= 1, 'the creation');

    const countAfterCreation = changes.length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    fs.appendFileSync(filePath, 'b');
    await waitUntil(() => changes.length > countAfterCreation, 'the change');

    const countAfterChange = changes.length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    fs.rmSync(filePath);
    await waitUntil(() => changes.length > countAfterChange, 'the deletion');
    assert.ok(changes.every((changed) => changed === folder.replaceAll('\\', '/')));
  } finally {
    watcher.unwatchAll();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('files that are not .verse files are ignored, and an unknown file name counts as a change', () => {
  const { watch, created } = createFakeWatch();
  const changes: string[] = [];
  const watcher = new FolderWatcher({ onChange: (changed) => changes.push(changed), onError: () => {} }, 32, watch);
  watcher.watch('C:\\Temp\\One');

  created[0]?.listener('change', 'Notes.txt');
  assert.deepEqual(changes, []);

  created[0]?.listener('change', 'Main.VERSE');
  created[0]?.listener('rename', null);
  assert.deepEqual(changes, ['C:/Temp/One', 'C:/Temp/One']);
});

test('an error closes the watcher, forgets the folder and is reported, while other folders continue', () => {
  const { watch, created } = createFakeWatch();
  const errors: [string, string][] = [];
  const watcher = new FolderWatcher(
    {
      onChange: () => {},
      onError: (folder, watcherError) => errors.push([folder, watcherError.message]),
    },
    32,
    watch,
  );
  watcher.watch('C:/Temp/One');
  watcher.watch('C:/Temp/Two');

  created[0]?.watcher.emit('error', new Error('EPERM'));
  assert.deepEqual(errors, [['C:/Temp/One', 'EPERM']]);
  assert.equal(created[0]?.watcher.isClosed, true);
  assert.equal(watcher.isWatching('C:/Temp/One'), false);
  assert.equal(watcher.isWatching('C:/Temp/Two'), true);
  assert.equal(created[1]?.watcher.isClosed, false);
});

test('a real watcher on a folder that does not exist fails without throwing', () => {
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} });
  const result = watcher.watch(path.join(os.tmpdir(), 'verse-watch-does-not-exist-12345'));
  assert.equal(result.status, 'failed');
  assert.equal(watcher.getWatchedFolders().length, 0);
});

test('a watch function that throws is reported as a failure', () => {
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} }, 32, () => {
    throw new Error('no such folder');
  });
  assert.deepEqual(watcher.watch('C:/Temp/One'), { status: 'failed', watcherError: new Error('no such folder') });
});

test('watching the same folder twice, in any spelling, keeps one watcher', () => {
  const { watch, created } = createFakeWatch();
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} }, 32, watch);
  watcher.watch('C:/Temp/One');
  assert.deepEqual(watcher.watch('c:\\temp\\ONE\\'), { status: 'watching' });
  assert.equal(created.length, 1);
});

test('the limit refuses new folders until one is unwatched', () => {
  const { watch, created } = createFakeWatch();
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} }, 2, watch);
  watcher.watch('C:/Temp/One');
  watcher.watch('C:/Temp/Two');
  assert.equal(watcher.hasRoom(), false);
  assert.deepEqual(watcher.watch('C:/Temp/Three'), { status: 'limit' });
  assert.equal(created.length, 2);

  watcher.unwatch('C:/Temp/One');
  assert.equal(created[0]?.watcher.isClosed, true);
  assert.equal(watcher.hasRoom(), true);
  assert.deepEqual(watcher.watch('C:/Temp/Three'), { status: 'watching' });
  assert.deepEqual(watcher.getWatchedFolders(), ['C:/Temp/Two', 'C:/Temp/Three']);
});

test('the default limit is 32 folders', () => {
  const { watch } = createFakeWatch();
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} }, undefined, watch);
  for (let index = 0; index < 32; index += 1) {
    assert.equal(watcher.watch(`C:/Temp/F${index}`).status, 'watching');
  }
  assert.equal(watcher.watch('C:/Temp/Extra').status, 'limit');
});

test('unwatchAll closes every watcher', () => {
  const { watch, created } = createFakeWatch();
  const watcher = new FolderWatcher({ onChange: () => {}, onError: () => {} }, 32, watch);
  watcher.watch('C:/Temp/One');
  watcher.watch('C:/Temp/Two');
  watcher.unwatchAll();
  assert.ok(created.every((entry) => entry.watcher.isClosed));
  assert.deepEqual(watcher.getWatchedFolders(), []);
});
