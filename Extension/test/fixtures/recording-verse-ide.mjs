// Copyright (c) 2026 Naotsun

// A stand-in for `verse.exe --ide-request` that records when it ran, so that a test can measure from the processes'
// side how many of them ran at the same time.
// Usage: node recording-verse-ide.mjs --ide-request <record file> <milliseconds>
// After reading the request, it appends "start|<script name>|<request kind>|<time>" to the record file, waits for the
// given time, appends "end|..." with the same fields, and then answers. The script name tells which engine ran it, so a
// test copies this file once per fake engine.

import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const PREFIX = '@verse-ide ';

const args = process.argv.slice(2);
const recordFile = args[1];
const milliseconds = Number(args[2] ?? '0');
const scriptName = basename(process.argv[1]);

/** Reads the whole of stdin as bytes. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Appends one line to the record file. A single small append is not interleaved with those of other processes. */
function record(event, kind) {
  appendFileSync(recordFile, `${event}|${scriptName}|${kind}|${Date.now()}\n`);
}

const body = await readStdin();
const kind = JSON.parse(body.toString('utf8').replace(/^﻿/, '')).kind;

record('start', kind);
await new Promise((resolve) => setTimeout(resolve, milliseconds));
record('end', kind);

process.stdout.write(`\n${PREFIX}${JSON.stringify({ protocol: 1, ok: true, diagnostics: [], hover: null })}\n`);
