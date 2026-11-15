// Copyright (c) 2026 Naotsun

// A stand-in for `verse.exe --ide-request`, started with the Node executable by the runner tests.
// Usage: node fake-verse-ide.mjs [--ide-request] [mode] [milliseconds]
// Without --ide-request it behaves like a verse.exe that does not know the flag: it prints an error and exits with 1.

const PREFIX = '@verse-ide ';
const RANGE = { start: { line: 0, byte: 0 }, end: { line: 0, byte: 1 } };

const args = process.argv.slice(2);
const mode = args[1] ?? 'echo';
const milliseconds = Number(args[2] ?? '0');
const startedAt = Date.now();

/** Reads the whole of stdin as bytes. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Waits for the given time. */
function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

/** Builds the answer line. The hover text reports what the process saw and when it ran. */
function buildAnswer(body) {
  const text = body.toString('utf8');
  const hasBom = (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf);
  const kind = JSON.parse(text.replace(/^\uFEFF/, '')).kind;
  const hover = { text: `${kind}|${body.length}|${hasBom}|${startedAt}|${Date.now()}`, range: RANGE };
  return `${PREFIX}${JSON.stringify({ protocol: 1, ok: true, diagnostics: [], hover })}`;
}

if (args[0] !== '--ide-request') {
  process.stderr.write('Error: unknown flag\n');
  process.exit(1);
}

if (mode === 'exit-early') {
  // Does not read stdin at all, so the writer may see EPIPE.
  process.exit(0);
}

if (mode === 'stderr-only') {
  process.stderr.write('boom: something went wrong\n');
  process.exit(2);
}

if (mode === 'hang') {
  // Never answers and never exits.
  setInterval(() => undefined, 1000);
} else {
  const body = await readStdin();
  if (mode === 'echo') {
    process.stdout.write(`\n${buildAnswer(body)}\n`);
  } else if (mode === 'slow') {
    await sleep(milliseconds);
    process.stdout.write(`\n${buildAnswer(body)}\n`);
  } else if (mode === 'noise') {
    process.stdout.write('some log line\nprefix in the middle: @verse-ide {"protocol":1,"ok":false}\n');
    process.stdout.write(`\n${buildAnswer(body)}\ntrailing output\n`);
  } else if (mode === 'linger') {
    // Answers and then does not exit.
    process.stdout.write(`\n${buildAnswer(body)}\n`);
    setInterval(() => undefined, 1000);
  } else if (mode === 'no-newline') {
    // The answer is the last output and has no line terminator.
    process.stdout.write(`\n${buildAnswer(body)}`);
  } else if (mode === 'split') {
    // A 3-byte character is cut in the middle between two writes.
    const line = `${PREFIX}${JSON.stringify({ protocol: 1, ok: true, hover: { text: '日本語', range: RANGE } })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    const cutIndex = bytes.indexOf(Buffer.from('日', 'utf8')) + 1;
    process.stdout.write(bytes.subarray(0, cutIndex));
    await sleep(50);
    process.stdout.write(bytes.subarray(cutIndex));
  } else if (mode === 'reject') {
    process.stdout.write(`\n${PREFIX}${JSON.stringify({ protocol: 1, ok: false, error: 'bad request' })}\n`);
    process.exit(1);
  } else if (mode === 'protocol2') {
    process.stdout.write(`\n${PREFIX}${JSON.stringify({ protocol: 2, ok: true })}\n`);
  } else if (mode === 'garbage') {
    process.stdout.write(`\n${PREFIX}{not json\n`);
  } else if (mode === 'flood') {
    // Writes far more than the test allows and never answers.
    const line = `${'x'.repeat(1000)}\n`;
    for (let count = 0; count < 100000; count += 1) {
      if (!process.stdout.write(line)) {
        await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
    }
  }
}
