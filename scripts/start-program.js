import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { freemem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOllamaCli } from './ollama-install.js';
import {
  crawl4aiContainerArgs,
  crawl4aiImage,
  crawl4aiMinimumDockerStorageBytes,
  crawl4aiMinimumMemoryBytes,
  hasCrawl4AIResources,
  searxngContainerArgs,
  searxngImage,
  searxngSettings,
} from './web-research-services.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const voiceDir = path.join(root, 'ai-agent', 'voice-service');
const searxngRuntimeDir = path.join(root, '.searxng-runtime');
const modelsDir = path.join(voiceDir, 'models');
const port = Number(process.env.UNI_EDU_PORT || 5179);
const devMode = process.env.UNI_EDU_DEV === '1';
const vitePort = Number(process.env.UNI_EDU_VITE_PORT || 5173);
const voicePort = 8765;
const searxngUrl = 'http://127.0.0.1:8080';
const searxngContainer = 'uni-edu-searxng';
const crawl4aiUrl = 'http://127.0.0.1:11235';
const crawl4aiContainer = 'uni-edu-crawl4ai';
const ollamaUrl = 'http://127.0.0.1:11434';
const localModel = 'qwen3:0.6b';
const defaultLocalModelUrl = `${ollamaUrl}/v1`;
const pythonPackages = [
  'faster_whisper',
  'kokoro',
  'webrtcvad',
  'numpy',
  'websockets',
  'espeakng_loader',
  'phonemizer',
  'torch',
];
const configFile = path.join(root, '.env.harry-botter.local');
const children = [];
const managedServices = new Map();
let shuttingDown = false;

function log(message) {
  console.log(`[Harry Botter] ${message}`);
}

function loadLocalConfig() {
  if (!existsSync(configFile)) return {};
  const allowed = new Set([
    'HARRY_BOTTER_LOCAL_MODEL_URL',
    'HARRY_BOTTER_NETWORK_MODEL_URL',
    'HARRY_BOTTER_NETWORK_MODEL',
    'HARRY_BOTTER_LOCAL_MODEL',
    'HARRY_BOTTER_SEARXNG_URL',
  ]);
  const values = {};
  for (const [index, rawLine] of readFileSync(configFile, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`Invalid setting on line ${index + 1} of ${configFile}.`);
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} ${args.join(' ')} failed (${signal || code}).`));
    });
  });
}

function startProcess(binary, args, options = {}) {
  const child = spawn(binary, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: false,
  });
  const serviceKey = options.serviceKey;
  if (serviceKey) {
    managedServices.set(serviceKey, {
      binary,
      args,
      options,
      child,
      healthUrl: options.healthUrl,
    });
  }
  child.once('error', (error) => {
    if (!shuttingDown) console.error(`[Harry Botter] ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    if (serviceKey) {
      const managed = managedServices.get(serviceKey);
      if (managed?.child === child) managedServices.delete(serviceKey);
    }
    if (options.restart === false) {
      console.error(
        `[Harry Botter] A managed service exited unexpectedly (${signal || code}). The launcher is not stopping.`,
      );
      return;
    }
    const label = options.label || path.basename(binary);
    const delayMs = options.restartDelayMs || 2_000;
    console.error(
      `[Harry Botter] ${label} exited unexpectedly (${signal || code}). Restarting it in ${delayMs / 1000} seconds.`,
    );
    const timer = setTimeout(() => {
      if (!shuttingDown) startProcess(binary, args, { ...options, restartDelayMs: Math.min(delayMs * 2, 30_000) });
    }, delayMs);
    timer.unref();
  });
  children.push(child);
  return child;
}

function fetchJson(url, timeoutMs = 1500) {
  return Promise.race([
    fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out.')), timeoutMs).unref();
    }),
  ]);
}

async function waitForService(url, child, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not responding';
  while (Date.now() < deadline) {
    try {
      await fetchJson(url);
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

function canBind(portNumber) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(portNumber, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function serviceIsReady(url) {
  try {
    await fetchJson(url);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url, child, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not responding';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function requireFreePortOrReadyService(portNumber, healthUrl, label) {
  if (await canBind(portNumber)) return false;
  if (await serviceIsReady(healthUrl)) {
    log(`${label} is already running; reusing it.`);
    return true;
  }
  throw new Error(`Port ${portNumber} is in use, but ${label} is not responding at ${healthUrl}.`);
}

function getPythonVersion(binary) {
  const result = spawnSync(binary, ['-c', 'import sys; print(sys.version_info.major, sys.version_info.minor)'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+)\s+(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isSupportedPythonVersion(version) {
  return version?.major === 3 && version.minor >= 10 && version.minor <= 13;
}

function findPython() {
  const windows = process.platform === 'win32';
  const venvPaths = [
    path.join(root, '.venv-audio312', windows ? 'Scripts/python.exe' : 'bin/python'),
    path.join(voiceDir, '.venv', windows ? 'Scripts/python.exe' : 'bin/python'),
  ];
  for (const candidate of venvPaths) {
    if (
      existsSync(candidate)
      && isSupportedPythonVersion(getPythonVersion(candidate))
    ) {
      return { binary: candidate, isVenv: true };
    }
  }

  const candidates = [
    process.env.UNI_EDU_PYTHON,
    ...(windows ? ['python'] : ['python3.12', 'python3.11', 'python3.10', 'python3.13', 'python3', 'python']),
  ].filter(Boolean);
  for (const binary of candidates) {
    if (isSupportedPythonVersion(getPythonVersion(binary))) return { binary, isVenv: false };
  }
  throw new Error('Python 3.10–3.13 is required. Install Python 3.12 and run npm start again.');
}

function npmCommand(args) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }
  return run('npm', args);
}

async function ensureVoicePython() {
  const windows = process.platform === 'win32';
  const existing = findPython();
  let python = existing.binary;
  if (!existing.isVenv) {
    const venv = path.join(root, '.venv-audio312');
    await run(python, ['-m', 'venv', venv]);
    python = path.join(venv, windows ? 'Scripts/python.exe' : 'bin/python');
  }
  const packages = spawnSync(
    python,
    ['-c', `import ${pythonPackages.join(', ')}`],
    { stdio: 'ignore' },
  );
  if (packages.status !== 0) {
    log('Installing the free local voice-service dependencies (first run only)...');
    try {
      await run(python, [
        '-m', 'pip', 'install', '--index-url', 'https://download.pytorch.org/whl/cpu',
        'torch==2.7.1',
      ], { cwd: voiceDir });
      await run(python, ['-m', 'pip', 'install', '-e', '.[audio]'], { cwd: voiceDir });
    } catch (error) {
      log(`Audio dependencies could not be installed: ${error.message}`);
      log('Starting chat where possible; speech features may be unavailable. Rerun npm start after fixing Python/audio setup.');
    }
  }
  return python;
}

async function ensureOllama(env) {
  const configuredLocalUrl = (env.HARRY_BOTTER_LOCAL_MODEL_URL || defaultLocalModelUrl).replace(/\/+$/, '');
  if (configuredLocalUrl !== defaultLocalModelUrl) {
    log('Using the configured local OpenAI-compatible model endpoint; Ollama setup is skipped.');
    return;
  }

  let ollamaCli = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0
    ? 'ollama'
    : null;
  const installOllamaCli = async () => {
    if (ollamaCli) return ollamaCli;
    log('Ollama is missing; installing a user-local copy for the default model route...');
    try {
      ollamaCli = await ensureOllamaCli({ runCommand: run });
      return ollamaCli;
    } catch (error) {
      log(`Automatic Ollama installation failed: ${error.message}`);
      return null;
    }
  };

  let server = null;
  try {
    server = await fetchJson(`${ollamaUrl}/api/tags`);
  } catch {
    if (!(await installOllamaCli())) return;
    log('Starting the local Ollama server...');
    const child = startProcess(ollamaCli, ['serve'], {
      label: 'Ollama',
      serviceKey: 'ollama',
      healthUrl: `${ollamaUrl}/api/tags`,
      env: {
        ...env,
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_NO_CLOUD: '1',
      },
    });
    await waitForService(`${ollamaUrl}/api/tags`, child, 'Ollama');
    server = await fetchJson(`${ollamaUrl}/api/tags`);
  }

  const selectedModel = env.HARRY_BOTTER_LOCAL_MODEL || localModel;
  const installed = Array.isArray(server.models)
    && server.models.some((model) => model.name === selectedModel || model.name.startsWith(`${selectedModel}-`));
  if (!installed) {
    if (!(await installOllamaCli())) return;
    log(`Downloading the free local fallback model ${selectedModel} (first run only)...`);
    await run(ollamaCli, ['pull', selectedModel], {
      env: {
        ...env,
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_NO_CLOUD: '1',
      },
    });
  }
}

function speechModelsCached() {
  const hub = path.join(modelsDir, 'huggingface', 'hub');
  return [
    'models--Systran--faster-whisper-tiny.en',
    'models--hexgrad--Kokoro-82M',
  ].every((model) => {
    const modelDirectory = path.join(hub, model);
    const snapshots = path.join(modelDirectory, 'snapshots');
    const ref = path.join(modelDirectory, 'refs', 'main');
    return existsSync(snapshots)
      && existsSync(ref)
      && readFileSync(ref, 'utf8').trim().length > 0;
  });
}

function serviceEnvironment(config) {
  return {
    ...process.env,
    ...config,
    HF_HOME: path.join(modelsDir, 'huggingface'),
    OLLAMA_MODELS: path.join(modelsDir, 'ollama'),
    HARRY_BOTTER_LOCAL_MODEL: config.HARRY_BOTTER_LOCAL_MODEL || localModel,
    HARRY_BOTTER_LOCAL_MODEL_URL: config.HARRY_BOTTER_LOCAL_MODEL_URL || defaultLocalModelUrl,
    HARRY_BOTTER_WHISPER_MODEL: 'Systran/faster-whisper-tiny.en',
    HARRY_BOTTER_STT_DEVICE: 'cpu',
    HARRY_BOTTER_STT_COMPUTE_TYPE: 'int8',
    HARRY_BOTTER_STT_CPU_THREADS: '2',
  };
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000).unref();
  })));
  process.exit(exitCode);
}

function startHealthMonitor() {
  setInterval(async () => {
    if (shuttingDown) return;
    for (const [serviceKey, managed] of managedServices) {
      if (!managed.healthUrl || managed.child.exitCode !== null) continue;
      try {
        await fetchJson(managed.healthUrl, 3_000);
      } catch {
        console.error(
          `[Harry Botter] ${managed.options.label || serviceKey} is no longer healthy. Restarting it.`,
        );
        if (managed.child.exitCode === null) {
          managed.child.kill('SIGTERM');
        }
      }
    }
  }, 30_000).unref();
}

async function ensureBackendPython() {
  const backendVenvPython = path.join(
    root,
    '.venv-backend',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const candidates = [
    process.env.UNI_EDU_PYTHON,
    backendVenvPython,
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? null : 'python',
  ].filter(Boolean);
  for (const binary of candidates) {
    const check = spawnSync(
      binary,
      ['-c', 'import fastapi, httpx, pydantic, uvicorn'],
      { stdio: 'ignore' },
    );
    if (check.status === 0) return binary;
  }

  const basePython = findPython().binary;
  const venv = path.join(root, '.venv-backend');
  const venvResult = spawnSync(basePython, ['-m', 'venv', venv], { stdio: 'ignore' });
  if (venvResult.status !== 0) {
    try {
      await run('virtualenv', ['--python', basePython, venv]);
    } catch {
      throw new Error(
        'Could not create the backend Python environment. Install the matching Python venv package '
        + 'or the virtualenv utility, then retry.',
      );
    }
  }
  const python = path.join(
    venv,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  log('Installing the Uni-EDU backend dependencies (first run only)...');
  await run(python, ['-m', 'pip', 'install', '-r', path.join(root, 'backend', 'requirements.txt')]);
  return python;
}

function getContainerDetails(name) {
  const result = spawnSync(
    'docker',
    ['container', 'inspect', '--format', '{{.Config.Image}}|{{.State.Running}}', name],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status !== 0) return null;
  const [image, running] = result.stdout.trim().split('|');
  return { image, running: running === 'true' };
}

function createCrawl4AIToken() {
  mkdirSync(searxngRuntimeDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(searxngRuntimeDir, 'crawl4ai.token');
  let token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
  let created = false;
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = randomBytes(32).toString('hex');
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    created = true;
  }
  if (process.platform !== 'win32') {
    chmodSync(searxngRuntimeDir, 0o700);
    chmodSync(tokenPath, 0o600);
  }
  return { token, created };
}

function canStartCrawl4AI(imageCached) {
  let availableMemory = freemem();
  if (process.platform === 'linux') {
    const memoryInfo = readFileSync('/proc/meminfo', 'utf8');
    const match = memoryInfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!match) {
      log('Could not verify available memory; skipping optional Crawl4AI startup.');
      return false;
    }
    availableMemory = Number(match[1]) * 1024;
  }
  let availableDockerStorage = null;
  if (!imageCached && process.platform === 'linux') {
    const dockerRoot = spawnSync(
      'docker',
      ['info', '--format', '{{.DockerRootDir}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (dockerRoot.status !== 0 || !dockerRoot.stdout.trim()) {
      log('Could not verify Docker storage; skipping the optional Crawl4AI image pull.');
      return false;
    }
    try {
      const { bavail, bsize } = statfsSync(dockerRoot.stdout.trim());
      availableDockerStorage = bavail * bsize;
    } catch (error) {
      log(`Could not verify Docker storage (${error.message}); skipping the optional Crawl4AI image pull.`);
      return false;
    }
  }

  if (!hasCrawl4AIResources({
    availableMemoryBytes: availableMemory,
    availableDockerStorageBytes: availableDockerStorage,
    imageCached,
  })) {
    if (availableMemory < crawl4aiMinimumMemoryBytes) {
      log('Crawl4AI needs at least 2 GiB available memory; search snippets remain available.');
    } else {
      const minimumStorageGiB = crawl4aiMinimumDockerStorageBytes / (1024 ** 3);
      log(`Crawl4AI needs at least ${minimumStorageGiB} GiB free Docker storage for its image; search snippets remain available.`);
    }
    return false;
  }
  return true;
}

async function ensureCrawl4AI(env, tokenCreated) {
  if (!env.CRAWL4AI_API_TOKEN) {
    log('A private Crawl4AI token could not be prepared; page extraction is disabled.');
    return;
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    log('Docker is unavailable; page extraction is disabled and SearXNG snippets remain available.');
    return;
  }

  let existing = getContainerDetails(crawl4aiContainer);
  if (existing && existing.image !== crawl4aiImage) {
    log(`A different container already uses ${crawl4aiContainer}; page extraction is disabled.`);
    return;
  }
  const needsStart = !existing || !existing.running || tokenCreated;
  const imageCached = spawnSync('docker', ['image', 'inspect', crawl4aiImage], {
    stdio: 'ignore',
  }).status === 0;
  if (needsStart && !canStartCrawl4AI(imageCached)) return;
  try {
    if (existing && tokenCreated) {
      await run('docker', ['container', 'rm', '--force', crawl4aiContainer], { cwd: root });
      existing = null;
    }
    if (existing) {
      if (!existing.running) await run('docker', ['start', crawl4aiContainer], { cwd: root });
    } else {
      if (!(await canBind(11235))) {
        log('Port 11235 is already in use; page extraction is disabled and search snippets remain available.');
        return;
      }
      await run('docker', crawl4aiContainerArgs(), { cwd: root, env });
    }
    await waitForHttp(`${crawl4aiUrl}/health`, null, 'Local Crawl4AI', 60_000);
    log(`Local Crawl4AI ${crawl4aiImage.split('@')[0]} is ready on loopback.`);
  } catch (error) {
    log(`Crawl4AI could not be started; SearXNG snippets remain available: ${error.message}`);
  }
}

async function ensureSearXNG(env) {
  const configuredUrl = (env.HARRY_BOTTER_SEARXNG_URL || searxngUrl).replace(/\/+$/, '');
  if (configuredUrl !== searxngUrl) {
    log('Using the configured SearXNG service; local SearXNG startup is skipped.');
    return;
  }

  const healthUrl = `${searxngUrl}/search?q=health&format=json`;
  const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  const existing = dockerAvailable ? getContainerDetails(searxngContainer) : null;
  if (existing && existing.image !== searxngImage && existing.image !== 'searxng/searxng:latest') {
    log(`A different container already uses ${searxngContainer}; local SearXNG startup is skipped.`);
    return;
  }
  if (existing?.image === 'searxng/searxng:latest') {
    const pinnedImageAvailable = spawnSync(
      'docker',
      ['image', 'inspect', searxngImage],
      { stdio: 'ignore' },
    ).status === 0;
    if (!pinnedImageAvailable) {
      try {
        await run('docker', ['pull', searxngImage], { cwd: root });
      } catch (error) {
        if (!existing.running) {
          try {
            await run('docker', ['start', searxngContainer], { cwd: root });
          } catch (startError) {
            log(`Pinned SearXNG is unavailable and the previous container could not be restarted: ${startError.message}`);
            return;
          }
        }
        log(`Pinned SearXNG is unavailable; retaining the previous local service: ${error.message}`);
        return;
      }
    }
    log('Replacing the previous floating SearXNG container with the pinned image.');
    try {
      await run('docker', ['container', 'rm', '--force', searxngContainer], { cwd: root });
    } catch (error) {
      log(`The previous SearXNG container could not be replaced: ${error.message}`);
      return;
    }
  } else if (existing?.image === searxngImage) {
    try {
      if (!existing.running) await run('docker', ['start', searxngContainer], { cwd: root });
      await waitForHttp(healthUrl, null, 'Local SearXNG', 30_000);
      log('Local pinned SearXNG is ready.');
    } catch (error) {
      log(`SearXNG could not be started; the app will continue without live search: ${error.message}`);
    }
    return;
  }
  if (await serviceIsReady(healthUrl)) {
    log('A local SearXNG service is already responding; reusing it.');
    return;
  }
  if (!dockerAvailable) {
    log('Docker is unavailable; live web search will remain disabled until SearXNG is started.');
    return;
  }
  try {
    mkdirSync(searxngRuntimeDir, { recursive: true });
    const settingsPath = path.join(searxngRuntimeDir, 'settings.yml');
    if (!existsSync(settingsPath)) {
      const secret = randomBytes(32).toString('hex');
      writeFileSync(settingsPath, searxngSettings(secret), { mode: 0o600 });
    }
    await run('docker', searxngContainerArgs(settingsPath), { cwd: root });
    await waitForHttp(healthUrl, null, 'Local SearXNG', 30_000);
    log(`Local SearXNG ${searxngImage.split('@')[0]} is ready at ${searxngUrl}.`);
  } catch (error) {
    log(`SearXNG could not be started; the app will continue without live search: ${error.message}`);
  }
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

try {
  let crawl4aiCredentials = { token: '', created: false };
  try {
    crawl4aiCredentials = createCrawl4AIToken();
  } catch (error) {
    log(`Crawl4AI credentials could not be prepared; page extraction is disabled: ${error.message}`);
  }
  const config = {
    ...loadLocalConfig(),
    ...process.env,
    CRAWL4AI_API_TOKEN: crawl4aiCredentials.token,
  };
  const env = serviceEnvironment(config);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('UNI_EDU_PORT must be an integer between 1024 and 65535.');
  }
  const backendUrl = `http://127.0.0.1:${port}/api/status`;
  const backendAlreadyRunning = await requireFreePortOrReadyService(port, backendUrl, 'Uni-EDU');

  if (!devMode && process.env.HARRY_BOTTER_SKIP_BUILD !== '1') {
    log('Building the app...');
    await npmCommand(['run', 'build']);
  }

  if (!backendAlreadyRunning) {
    const backendPython = await ensureBackendPython();
    const backend = startProcess(backendPython, [path.join(root, 'backend', 'server.py')], {
      label: 'Uni-EDU backend',
      serviceKey: 'backend',
      healthUrl: backendUrl,
      cwd: root,
      env: {
        ...env,
        UNI_EDU_BACKEND_ONLY: '1',
        UNI_EDU_PORT: String(port),
      },
    });
    await waitForService(backendUrl, backend, 'Uni-EDU backend');
  }
  log(`Uni-EDU app is available at http://localhost:${port}; preparing local AI services.`);

  const voiceHealthUrl = `http://127.0.0.1:${voicePort}/api/v1/health`;
  const voiceAlreadyRunning = await requireFreePortOrReadyService(voicePort, voiceHealthUrl, 'Harry Botter voice service');
  if (!voiceAlreadyRunning) {
    const python = await ensureVoicePython();
    const audioPackagesReady = spawnSync(
      python,
      ['-c', `import ${pythonPackages.join(', ')}`],
      { stdio: 'ignore' },
    ).status === 0;
    if (!audioPackagesReady) {
      log('Audio dependencies are incomplete. Live transcription and voice previews will report unavailable; typing chat can still run.');
    } else if (!speechModelsCached()) {
      log('Downloading and warming the free local speech models (first run only)...');
      try {
        await run(python, ['-m', 'harry_botter_voice.setup_models'], {
          cwd: voiceDir,
          env: {
            ...env,
            HF_HUB_OFFLINE: '0',
            PYTHONPATH: path.join(voiceDir, 'src'),
          },
        });
      } catch (error) {
        log(`Speech models could not be prepared: ${error.message}`);
        log('The voice service will still start for typing chat; check speech status and complete model setup before using audio.');
      }
    }

    const voice = startProcess(python, ['-m', 'harry_botter_voice', '--port', String(voicePort)], {
      label: 'Harry Botter voice service',
      serviceKey: 'voice',
      healthUrl: voiceHealthUrl,
      cwd: voiceDir,
      env: {
        ...env,
        HF_HUB_OFFLINE: '1',
        PYTHONPATH: path.join(voiceDir, 'src'),
      },
    });
    await waitForService(voiceHealthUrl, voice, 'Voice service');
  }

  // Ollama installation/model downloads are independent of voice API health.
  // Start them only after the voice service is ready so first-run model setup
  // cannot make the G1 installer report the voice service as unavailable.
  const ollamaSetup = ensureOllama(env).catch((error) => {
    log(`Local model setup failed; text generation may be unavailable: ${error.message}`);
  });
  void ensureSearXNG(env).catch((error) => {
    log(`SearXNG setup failed; the app will continue without live search: ${error.message}`);
  });
  void ensureCrawl4AI(env, crawl4aiCredentials.created).catch((error) => {
    log(`Crawl4AI setup failed; SearXNG snippets remain available: ${error.message}`);
  });

  if (devMode) {
    log('Starting the Vite development frontend...');
    const vite = startProcess(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'dev:frontend', '--', '--host', '0.0.0.0', '--port', String(vitePort)],
      { cwd: root, env: { ...env }, label: 'Vite development server', serviceKey: 'vite' },
    );
    await waitForHttp(`http://127.0.0.1:${vitePort}/`, vite, 'Vite development server');
  }

  await ollamaSetup;

  try {
    const modelStatus = await fetchJson(`http://127.0.0.1:${voicePort}/api/v1/model/status`);
    if (modelStatus.status === 'ready') {
      const response = await fetch(`http://127.0.0.1:${voicePort}/api/v1/model/warmup`, {
        method: 'POST',
        signal: AbortSignal.timeout(90_000),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message || result.detail || `HTTP ${response.status}`);
      }
      if (result.status === 'ready') {
        log(`Warmed local model ${result.model}; first response avoids a cold model load.`);
      }
    } else {
      log(`Local model warm-up skipped: ${modelStatus.error || 'the configured model is not ready.'}`);
    }
  } catch (error) {
    log(`Local model warm-up failed; first draft may be slower: ${error.message}`);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${voicePort}/api/v1/speech/warmup`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || result.detail || `HTTP ${response.status}`);
    }
    log(`Warmed local speech voice ${result.voice}; first spoken reply avoids model initialization.`);
  } catch (error) {
    log(`Local speech warm-up failed; first spoken reply may be slower: ${error.message}`);
  }

  startHealthMonitor();

  log(
    devMode
      ? `Ready. Open http://localhost:${vitePort}/?try=harry-botter and sign in as a teacher.`
      : `Ready. Open http://localhost:${port}/?try=harry-botter and sign in as a teacher.`,
  );
  log('Services started by this launcher will remain available while this launcher is running. Press Ctrl+C to stop those services.');
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(`[Harry Botter] Startup failed: ${error.message}`);
  await shutdown(1);
}
