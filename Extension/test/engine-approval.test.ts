// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideApproval, EngineApproval } from '../src/engine-approval.ts';
import type { ApprovalHost, ApprovalInput, SettingScope } from '../src/engine-approval.ts';
import type { ApproveEngineParams, EngineSource } from '../src/shared/protocol-types.ts';

/** Engine folder used by most tests. */
const ENGINE_DIR = 'C:\\Engines\\One';

/** Comparison key of ENGINE_DIR. */
const ENGINE_KEY = 'c:/engines/one';

/** Input for an engine found through a workspace setting, which needs a confirmation. */
function makeInput(overrides: Readonly<Partial<ApprovalInput>>): ApprovalInput {
  return {
    engineKey: ENGINE_KEY,
    source: { kind: 'setting' },
    settingScope: 'workspace',
    trustedFolders: ['C:\\Work'],
    approvedGlobally: new Set(),
    usedInWindow: new Set(),
    deniedInWindow: new Set(),
    ...overrides,
  };
}

/** Fake of the VS Code side that records what was shown and what was stored. */
class FakeHost implements ApprovalHost {
  // Settings level that getEngineDirSettingScope returns.
  settingScope: SettingScope = 'workspace';

  // Folders that getTrustedFolders returns.
  trustedFolders: string[] = ['C:\\Work'];

  // Stored allowed engines.
  allowedEngines: string[] = [];

  // Messages of the confirmations shown so far.
  shownMessages: string[] = [];

  // Buttons of the most recent confirmation.
  lastButtons: readonly string[] = [];

  // Resolvers of the confirmations that wait for an answer.
  private readonly resolvers: Array<(answer: string | undefined) => void> = [];

  // Answer given immediately when set; otherwise a confirmation waits for answerNext.
  autoAnswer: string | undefined | 'wait' = 'wait';

  getEngineDirSettingScope(): SettingScope {
    return this.settingScope;
  }

  getTrustedFolders(): readonly string[] {
    return this.trustedFolders;
  }

  readAllowedEngines(): readonly string[] {
    return this.allowedEngines;
  }

  async writeAllowedEngines(engineKeys: readonly string[]): Promise<void> {
    this.allowedEngines = [...engineKeys];
  }

  showConfirmation(message: string, buttons: readonly string[]): Promise<string | undefined> {
    this.shownMessages.push(message);
    this.lastButtons = buttons;
    if (this.autoAnswer !== 'wait') {
      return Promise.resolve(this.autoAnswer);
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Answers every confirmation that is waiting. */
  answerNext(answer: string | undefined): void {
    for (const resolve of this.resolvers.splice(0)) {
      resolve(answer);
    }
  }
}

/** Creates a request for the engine through a workspace setting. */
function makeRequest(folder: string, source: EngineSource = { kind: 'setting' }): ApproveEngineParams {
  return { engineDir: ENGINE_DIR, source, folder };
}

test('decideApproval allows a user setting without asking', () => {
  assert.equal(decideApproval(makeInput({ settingScope: 'user' })), 'allow');
});

test('decideApproval asks for a workspace setting and for a setting of unknown origin', () => {
  assert.equal(decideApproval(makeInput({ settingScope: 'workspace' })), 'ask');
  assert.equal(decideApproval(makeInput({ settingScope: 'none' })), 'ask');
});

test('decideApproval allows a local state file inside a trusted workspace folder', () => {
  const source: EngineSource = { kind: 'localState', stateFilePath: 'c:/work/Project/VersePlayground.local.json' };
  assert.equal(decideApproval(makeInput({ source })), 'allow');
});

test('decideApproval asks for a local state file outside the workspace', () => {
  const source: EngineSource = { kind: 'localState', stateFilePath: 'C:\\Other\\VersePlayground.local.json' };
  assert.equal(decideApproval(makeInput({ source })), 'ask');
  assert.equal(decideApproval(makeInput({ source, trustedFolders: [] })), 'ask');
});

test('decideApproval does not treat a folder that only shares a name prefix as trusted', () => {
  const source: EngineSource = { kind: 'localState', stateFilePath: 'C:\\Work2\\VersePlayground.local.json' };
  assert.equal(decideApproval(makeInput({ source })), 'ask');
});

test('decideApproval allows an engine that was allowed for good or used in this window', () => {
  assert.equal(decideApproval(makeInput({ approvedGlobally: new Set([ENGINE_KEY]) })), 'allow');
  assert.equal(decideApproval(makeInput({ usedInWindow: new Set([ENGINE_KEY]) })), 'allow');
});

test('decideApproval denies an engine refused in this window', () => {
  assert.equal(decideApproval(makeInput({ deniedInWindow: new Set([ENGINE_KEY]) })), 'deny');
});

test('decideApproval allows a confirmation-free route even after a refusal', () => {
  const deniedInWindow = new Set([ENGINE_KEY]);
  assert.equal(decideApproval(makeInput({ settingScope: 'user', deniedInWindow })), 'allow');
  const source: EngineSource = { kind: 'localState', stateFilePath: 'C:\\Work\\VersePlayground.local.json' };
  assert.equal(decideApproval(makeInput({ source, deniedInWindow })), 'allow');
});

test('decideApproval prefers an allowance over a refusal', () => {
  const input = makeInput({ approvedGlobally: new Set([ENGINE_KEY]), deniedInWindow: new Set([ENGINE_KEY]) });
  assert.equal(decideApproval(input), 'allow');
});

test('an allowance of another engine does not count', () => {
  assert.equal(decideApproval(makeInput({ approvedGlobally: new Set(['c:/engines/two']) })), 'ask');
});

test('Allow is remembered for good and later requests are not asked', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Allow';
  const approval = new EngineApproval(host);

  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), true);
  assert.deepEqual(host.allowedEngines, [ENGINE_KEY]);
  assert.equal(await approval.approve(makeRequest('C:\\Code\\Two')), true);
  assert.equal(host.shownMessages.length, 1);
});

test('the confirmation names verse.exe and the folder and offers Allow and Don\'t Allow', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Allow';
  await new EngineApproval(host).approve(makeRequest('C:\\Code\\One'));

  assert.equal(host.shownMessages.length, 1);
  assert.ok(host.shownMessages[0].startsWith('Verse Playground wants to run '));
  assert.ok(host.shownMessages[0].includes('verse.exe'));
  assert.ok(host.shownMessages[0].includes(' to check C:\\Code\\One for errors. '));
  assert.ok(host.shownMessages[0].endsWith('Allow it only if you trust this engine folder.'));
  assert.deepEqual(host.lastButtons, ['Allow', 'Don\'t Allow']);
});

test('Don\'t Allow is remembered for the window only', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Don\'t Allow';
  const approval = new EngineApproval(host);

  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
  assert.equal(await approval.approve(makeRequest('C:\\Code\\Two')), false);
  assert.equal(host.shownMessages.length, 1);
  assert.deepEqual(host.allowedEngines, []);
});

test('closing the notification counts as a refusal for the window', async () => {
  const host = new FakeHost();
  host.autoAnswer = undefined;
  const approval = new EngineApproval(host);

  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
  assert.equal(host.shownMessages.length, 1);
  assert.deepEqual(host.allowedEngines, []);
});

test('a confirmation-free route allows an engine after a refusal, and later asks are no longer needed', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Don\'t Allow';
  const approval = new EngineApproval(host);
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
  assert.equal(host.shownMessages.length, 1);

  // The same engine reached through a user setting is allowed even though it was refused before.
  host.settingScope = 'user';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), true);

  // The engine now counts as used in this window, so a route that needs a confirmation is allowed without asking.
  host.settingScope = 'workspace';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\Two')), true);
  assert.equal(host.shownMessages.length, 1);
});

test('a confirmation-free route for another engine does not lift the refusal of a refused engine', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Don\'t Allow';
  const approval = new EngineApproval(host);
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);

  // A different engine reached through a user setting is allowed. The refusal of the first engine stays.
  host.settingScope = 'user';
  const otherEngineRequest: ApproveEngineParams = {
    engineDir: 'C:\\Engines\\Two',
    source: { kind: 'setting' },
    folder: 'C:\\Code\\Two',
  };
  assert.equal(await approval.approve(otherEngineRequest), true);
  host.settingScope = 'workspace';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
});

test('a local state file inside the trusted workspace is allowed without asking', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);
  const source: EngineSource = { kind: 'localState', stateFilePath: 'C:\\Work\\Project\\VersePlayground.local.json' };

  assert.equal(await approval.approve(makeRequest('C:\\Work\\Project', source)), true);
  assert.equal(host.shownMessages.length, 0);
});

test('an engine used through a free route is not asked about when found another way in the window', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);

  host.settingScope = 'user';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), true);
  host.settingScope = 'workspace';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\Two')), true);
  assert.equal(host.shownMessages.length, 0);
});

test('an untrusted workspace has no trusted folders, so its local state file is asked about', async () => {
  const host = new FakeHost();
  host.trustedFolders = [];
  host.autoAnswer = 'Allow';
  const source: EngineSource = { kind: 'localState', stateFilePath: 'C:\\Work\\Project\\VersePlayground.local.json' };

  assert.equal(await new EngineApproval(host).approve(makeRequest('C:\\Work\\Project', source)), true);
  assert.equal(host.shownMessages.length, 1);
});

test('requests for one engine from several folders share one notification and one answer', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);

  const firstAnswer = approval.approve(makeRequest('C:\\Code\\One'));
  const secondAnswer = approval.approve(makeRequest('C:\\Code\\Two'));
  assert.equal(host.shownMessages.length, 1);

  host.answerNext('Allow');
  assert.deepEqual(await Promise.all([firstAnswer, secondAnswer]), [true, true]);
  assert.equal(host.shownMessages.length, 1);
});

test('requests for different engines are asked separately', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);

  const firstAnswer = approval.approve(makeRequest('C:\\Code\\One'));
  const secondAnswer = approval.approve({ ...makeRequest('C:\\Code\\One'), engineDir: 'C:\\Engines\\Two' });
  assert.equal(host.shownMessages.length, 2);

  host.answerNext('Don\'t Allow');
  assert.deepEqual(await Promise.all([firstAnswer, secondAnswer]), [false, false]);
});

test('a hidden notification keeps the request waiting without asking again', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);
  let isSettled = false;

  const answer = approval.approve(makeRequest('C:\\Code\\One')).then((result) => {
    isSettled = true;
    return result;
  });
  void approval.approve(makeRequest('C:\\Code\\Two'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isSettled, false);
  assert.equal(host.shownMessages.length, 1);

  host.answerNext('Allow');
  assert.equal(await answer, true);
});

test('forgetDenials makes the next use ask again but keeps allowances', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Don\'t Allow';
  const approval = new EngineApproval(host);
  await approval.approve(makeRequest('C:\\Code\\One'));

  approval.forgetDenials();
  host.autoAnswer = 'Allow';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), true);
  assert.equal(host.shownMessages.length, 2);

  approval.forgetDenials();
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), true);
  assert.equal(host.shownMessages.length, 2);
});

test('forgetAllowedEngines clears the stored allowances so the next use asks again', async () => {
  const host = new FakeHost();
  host.autoAnswer = 'Allow';
  const approval = new EngineApproval(host);
  await approval.approve(makeRequest('C:\\Code\\One'));
  assert.deepEqual(host.allowedEngines, [ENGINE_KEY]);

  await approval.forgetAllowedEngines();
  assert.deepEqual(host.allowedEngines, []);
  await approval.approve(makeRequest('C:\\Code\\One'));
  assert.equal(host.shownMessages.length, 2);
});

test('forgetAllowedEngines also forgets engines used through a free route', async () => {
  const host = new FakeHost();
  const approval = new EngineApproval(host);
  host.settingScope = 'user';
  await approval.approve(makeRequest('C:\\Code\\One'));

  await approval.forgetAllowedEngines();
  host.settingScope = 'workspace';
  host.autoAnswer = 'Don\'t Allow';
  assert.equal(await approval.approve(makeRequest('C:\\Code\\One')), false);
  assert.equal(host.shownMessages.length, 1);
});

test('allowing the same engine twice stores it once and other engines are kept', async () => {
  const host = new FakeHost();
  host.allowedEngines = ['c:/engines/two'];
  host.autoAnswer = 'Allow';
  const approval = new EngineApproval(host);

  await approval.approve(makeRequest('C:\\Code\\One'));
  assert.deepEqual(host.allowedEngines, ['c:/engines/two', ENGINE_KEY]);
});
