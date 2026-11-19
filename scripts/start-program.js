import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const voiceDir = path.join(root, 'ai-agent', 'voice-service');
const modelsDir = path.join(voiceDir, 'models');
const port = Number(process.env.UNI_EDU_PORT || 5179);
const voicePort = 8765;
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
  child.once('error', (error) => {
    if (!shuttingDown) console.error(`[Harry Botter] ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[Harry Botter] A managed service exited unexpectedly (${signal || code}). Stopping the application stack.`,
    );
    void shutdown(1);
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
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited before becoming ready.`);
    }
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

  const hasOllamaCli = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
  let server = null;
  try {
    server = await fetchJson(`${ollamaUrl}/api/tags`);
  } catch {
    if (!hasOllamaCli) {
      log(
        'Ollama is not reachable and its CLI is not installed. The app will still start, '
        + 'but the default local model is unavailable until a compatible runtime is configured.',
      );
      return;
    }
    log('Starting the local Ollama server...');
    const child = startProcess('ollama', ['serve'], {
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
    if (!hasOllamaCli) {
      log(`The Ollama server is reachable, but ${selectedModel} is not installed and the Ollama CLI is unavailable.`);
      return;
    }
    log(`Downloading the free local fallback model ${selectedModel} (first run only)...`);
    await run('ollama', ['pull', selectedModel], {
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

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

try {
  const config = { ...loadLocalConfig(), ...process.env };
  const env = serviceEnvironment(config);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('UNI_EDU_PORT must be an integer between 1024 and 65535.');
  }
  if (!(await canBind(port))) {
    throw new Error(`Port ${port} is already in use. Set UNI_EDU_PORT to another available port.`);
  }
  if (!(await canBind(voicePort))) throw new Error(`Port ${voicePort} is already in use.`);

  if (process.env.HARRY_BOTTER_SKIP_BUILD !== '1') {
    log('Building the app...');
    await npmCommand(['run', 'build']);
  }

  const backendPython = await ensureBackendPython();
  const backend = startProcess(backendPython, [path.join(root, 'backend', 'server.py')], {
    cwd: root,
    env: { ...env, UNI_EDU_PORT: String(port) },
  });
  await waitForService(`http://127.0.0.1:${port}/api/status`, backend, 'Uni-EDU backend');
  log(`Uni-EDU app is available at http://localhost:${port}; preparing local AI services.`);

  await ensureOllama(env);
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
    cwd: voiceDir,
    env: {
      ...env,
      HF_HUB_OFFLINE: '1',
      PYTHONPATH: path.join(voiceDir, 'src'),
    },
  });
  await waitForService(`http://127.0.0.1:${voicePort}/api/v1/health`, voice, 'Voice service');

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

  log(`Ready. Open http://localhost:${port}/?try=harry-botter and sign in as a teacher.`);
  log('Press Ctrl+C to stop the backend, voice service, and any Ollama server started here.');
} catch (error) {
  console.error(`[Harry Botter] Startup failed: ${error.message}`);
  await shutdown(1);
}
