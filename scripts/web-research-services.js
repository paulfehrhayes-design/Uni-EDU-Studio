export const crawl4aiImage = 'unclecode/crawl4ai:0.9.5@sha256:0b05666882bfb67f45d559a5b827839c54127b74aedd723f8ab338a3571b5fc9';
export const searxngImage = 'searxng/searxng:2026.11.21-c6ee3e9fd@sha256:fc1d81d7e9d04d3c8b3e23c7162feddf5c3d6aecd32e67a56eaabcb8d8747f79';
export const crawl4aiMinimumMemoryBytes = 2 * 1024 ** 3;
export const crawl4aiMinimumDockerStorageBytes = 4 * 1024 ** 3;

export function hasCrawl4AIResources({
  availableMemoryBytes,
  availableDockerStorageBytes,
  imageCached,
}) {
  if (
    !Number.isFinite(availableMemoryBytes)
    || availableMemoryBytes < crawl4aiMinimumMemoryBytes
  ) {
    return false;
  }
  if (
    !imageCached
    && availableDockerStorageBytes !== null
    && (!Number.isFinite(availableDockerStorageBytes)
      || availableDockerStorageBytes < crawl4aiMinimumDockerStorageBytes)
  ) {
    return false;
  }
  return true;
}

export function crawl4aiContainerArgs() {
  return [
    'run',
    '--detach',
    '--name',
    'uni-edu-crawl4ai',
    '--restart',
    'unless-stopped',
    '--publish',
    '127.0.0.1:11235:11235',
    '--shm-size',
    '1g',
    '--env',
    'CRAWL4AI_API_TOKEN',
    crawl4aiImage,
  ];
}

export function searxngSettings(secret) {
  return [
    'use_default_settings: true',
    'server:',
    `  secret_key: "${secret}"`,
    '  bind_address: "0.0.0.0"',
    '  port: 8080',
    '  limiter: false',
    '  image_proxy: false',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
}

export function searxngContainerArgs(settingsPath) {
  return [
    'run',
    '--detach',
    '--name',
    'uni-edu-searxng',
    '--restart',
    'unless-stopped',
    '--publish',
    '127.0.0.1:8080:8080',
    '--env',
    'SEARXNG_BIND_ADDRESS=0.0.0.0',
    '--env',
    'SEARXNG_PORT=8080',
    '--env',
    'SEARXNG_BASE_URL=http://127.0.0.1:8080/',
    '--volume',
    `${settingsPath}:/etc/searxng/settings.yml:ro`,
    searxngImage,
  ];
}
