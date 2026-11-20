import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

function getLinuxArchiveArchitecture(architecture) {
  if (architecture === 'x64') return 'amd64';
  if (architecture === 'arm64') return 'arm64';
  throw new Error(`Automatic Ollama installation is not supported on Linux ${architecture}.`);
}

function isRunnable(binary) {
  return spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0;
}

function extractZstdArchive(archivePath, destination) {
  return new Promise((resolve, reject) => {
    const decompressor = spawn('zstd', ['--decompress', '--stdout', archivePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const extractor = spawn('tar', ['-xf', '-', '-C', destination], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    let decompressorExitCode = null;
    let extractorExitCode = null;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      decompressor.kill();
      extractor.kill();
      reject(error);
    };
    const finishIfReady = () => {
      if (decompressorExitCode === null || extractorExitCode === null) return;
      if (decompressorExitCode !== 0 || extractorExitCode !== 0) {
        fail(new Error('Could not extract the downloaded Ollama archive.'));
        return;
      }
      settled = true;
      resolve();
    };

    decompressor.once('error', (error) => {
      fail(error.code === 'ENOENT'
        ? new Error('The zstd utility is required; rerun G1 setup to install the archive extractor.')
        : error);
    });
    extractor.once('error', fail);
    decompressor.stdout.pipe(extractor.stdin);
    decompressor.once('close', (code) => {
      decompressorExitCode = code;
      finishIfReady();
    });
    extractor.once('close', (code) => {
      extractorExitCode = code;
      finishIfReady();
    });
  });
}

export async function ensureOllamaCli({
  homeDirectory = homedir(),
  platform = process.platform,
  architecture = process.arch,
  runCommand,
  canRun = isRunnable,
  unpackArchive = extractZstdArchive,
} = {}) {
  if (platform !== 'linux') {
    throw new Error(`Automatic Ollama installation is not supported on ${platform}.`);
  }
  if (typeof runCommand !== 'function') {
    throw new Error('An Ollama installer command runner is required.');
  }

  const archiveArchitecture = getLinuxArchiveArchitecture(architecture);
  const installRoot = path.join(homeDirectory, '.local', 'share', 'uni-edu-studio');
  const installDirectory = path.join(installRoot, `ollama-linux-${archiveArchitecture}`);
  const ollamaCli = path.join(installDirectory, 'bin', 'ollama');
  if (canRun(ollamaCli)) return ollamaCli;

  await mkdir(installRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(installRoot, '.ollama-install-'));
  const stagingPrefix = path.join(stagingDirectory, 'prefix');
  try {
    await mkdir(stagingPrefix);
    const archivePath = path.join(stagingDirectory, 'ollama.tar.zst');
    const archiveUrl = `https://ollama.com/download/ollama-linux-${archiveArchitecture}.tar.zst`;
    await runCommand('curl', [
      '--fail',
      '--location',
      '--show-error',
      '--progress-bar',
      '--retry',
      '2',
      '--connect-timeout',
      '15',
      '--max-time',
      '1800',
      '--output',
      archivePath,
      archiveUrl,
    ]);
    await unpackArchive(archivePath, stagingPrefix);

    const stagedCli = path.join(stagingPrefix, 'bin', 'ollama');
    if (!canRun(stagedCli)) {
      throw new Error('The downloaded Ollama archive did not contain a runnable Linux binary.');
    }

    await rm(installDirectory, { recursive: true, force: true });
    await rename(stagingPrefix, installDirectory);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  if (!canRun(ollamaCli)) {
    throw new Error('The installed Ollama binary did not pass its version check.');
  }
  return ollamaCli;
}
