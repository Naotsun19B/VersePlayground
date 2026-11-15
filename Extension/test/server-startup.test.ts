// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** The entry point of the language server, which the test starts the way the client does, in its own process. */
const SERVER_ENTRY = fileURLToPath(new URL('../src/server/main.ts', import.meta.url));

/** How long the server gets to answer and to keep running after the handshake, in milliseconds. */
const SETTLE_MS = 1_500;

/** One JSON-RPC message of the language server protocol. */
interface RpcMessage {
  /** The protocol version, always 2.0. */
  jsonrpc: '2.0';

  /** The request id, absent for a notification. */
  id?: number;

  /** The method name. */
  method: string;

  /** The parameters of the method. */
  params: unknown;
}

/** Frames a message with the Content-Length header that the stdio transport reads. */
function frameMessage(message: RpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/** Waits for the given time. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

test('the server answers initialize and keeps running after initialized and a workspace folder change', async () => {
  const serverProcess = spawn(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SERVER_ENTRY, '--stdio'],
  );
  let standardOutput = '';
  let standardError = '';
  let exitCode: number | null | undefined;
  serverProcess.stdout.on('data', (chunk: Buffer) => {
    standardOutput += chunk.toString('utf8');
  });
  serverProcess.stderr.on('data', (chunk: Buffer) => {
    standardError += chunk.toString('utf8');
  });
  serverProcess.on('exit', (code) => {
    exitCode = code;
  });

  try {
    serverProcess.stdin.write(frameMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: null,
        capabilities: { workspace: { workspaceFolders: true } },
        initializationOptions: { configuredEngineDir: '', workspaceFolders: [] },
      },
    }));
    serverProcess.stdin.write(frameMessage({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    serverProcess.stdin.write(frameMessage({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWorkspaceFolders',
      params: { event: { added: [], removed: [] } },
    }));
    await delay(SETTLE_MS);

    assert.equal(exitCode, undefined, `the server exited early: ${standardError.slice(0, 2_000)}`);
    assert.match(standardOutput, /"id":1,"result":\{"capabilities"/);
  } finally {
    serverProcess.kill();
  }
});
