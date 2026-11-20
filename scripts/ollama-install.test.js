import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureOllamaCli } from './ollama-install.js';

test('installs and reuses the official Linux ARM64 Ollama binary in the user data directory', async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'uni-edu-ollama-test-'));
  const commands = [];
  try {
    const runCommand = async (binary, args) => {
      commands.push([binary, args]);
      if (binary === 'curl') {
        const outputPath = args[args.indexOf('--output') + 1];
        await writeFile(outputPath, 'mock archive');
      }
    };
    const canRun = (binary) => existsSync(binary);
    const unpackArchive = async (_archivePath, prefix) => {
      const binDirectory = path.join(prefix, 'bin');
      await mkdir(binDirectory, { recursive: true });
      await writeFile(path.join(binDirectory, 'ollama'), 'mock executable');
    };

    const cli = await ensureOllamaCli({
      homeDirectory,
      platform: 'linux',
      architecture: 'arm64',
      runCommand,
      canRun,
      unpackArchive,
    });

    assert.equal(
      cli,
      path.join(homeDirectory, '.local', 'share', 'uni-edu-studio', 'ollama-linux-arm64', 'bin', 'ollama'),
    );
    assert.equal(commands.length, 1);
    assert.ok(commands[0][1].includes('https://ollama.com/download/ollama-linux-arm64.tar.zst'));
    assert.equal(await readFile(cli, 'utf8'), 'mock executable');

    const reusedCli = await ensureOllamaCli({
      homeDirectory,
      platform: 'linux',
      architecture: 'arm64',
      runCommand,
      canRun,
      unpackArchive,
    });
    assert.equal(reusedCli, cli);
    assert.equal(commands.length, 1);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test('does not attempt an automatic install on unsupported platforms', async () => {
  let attemptedInstall = false;
  await assert.rejects(
    ensureOllamaCli({
      platform: 'darwin',
      architecture: 'arm64',
      runCommand: async () => {
        attemptedInstall = true;
      },
    }),
    /not supported on darwin/,
  );
  assert.equal(attemptedInstall, false);
});
