import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const script = path.resolve(import.meta.dirname, 'prepare-opencode-cli.mjs');
const output = path.resolve(
  import.meta.dirname,
  '..',
  'resources',
  'opencode-cli',
  process.platform === 'win32' ? 'opencode.exe' : 'opencode',
);

const runPrepare = (customBinary, version) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      OPENCHAMBER_OPENCODE_CLI_PATH: customBinary,
      OPENCHAMBER_OPENCODE_CLI_VERSION: version,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
});

test('stages a matching custom OpenCode CLI binary', async () => {
  const dir = path.join(os.tmpdir(), `openchamber-cli-test-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const custom = process.execPath;
  const version = process.versions.node;
  try {
    await runPrepare(custom, version);
    const staged = await readFile(output).catch(() => null);
    if (!staged || staged.length === 0) throw new Error('custom CLI was not staged');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(output, { force: true });
  }
});
