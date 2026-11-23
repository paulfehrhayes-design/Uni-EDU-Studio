import assert from 'node:assert/strict';
import test from 'node:test';
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

test('crawler container uses the pinned image and loopback-only authenticated API', () => {
  const args = crawl4aiContainerArgs();
  assert.match(crawl4aiImage, /@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('127.0.0.1:11235:11235'));
  assert.ok(args.includes('CRAWL4AI_API_TOKEN'));
  assert.ok(args.includes(crawl4aiImage));
});

test('SearXNG container and generated settings are pinned and private', () => {
  const args = searxngContainerArgs('/private/settings.yml');
  const settings = searxngSettings('local-secret');
  assert.match(searxngImage, /@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('127.0.0.1:8080:8080'));
  assert.ok(args.includes(searxngImage));
  assert.match(settings, /secret_key: "local-secret"/);
  assert.match(settings, /- json/);
  assert.doesNotMatch(settings, /limiter: true/);
});

test('optional crawler startup respects available memory and image storage', () => {
  assert.equal(hasCrawl4AIResources({
    availableMemoryBytes: crawl4aiMinimumMemoryBytes - 1,
    availableDockerStorageBytes: crawl4aiMinimumDockerStorageBytes,
    imageCached: false,
  }), false);
  assert.equal(hasCrawl4AIResources({
    availableMemoryBytes: crawl4aiMinimumMemoryBytes,
    availableDockerStorageBytes: crawl4aiMinimumDockerStorageBytes - 1,
    imageCached: false,
  }), false);
  assert.equal(hasCrawl4AIResources({
    availableMemoryBytes: crawl4aiMinimumMemoryBytes,
    availableDockerStorageBytes: null,
    imageCached: true,
  }), true);
  assert.equal(hasCrawl4AIResources({
    availableMemoryBytes: crawl4aiMinimumMemoryBytes,
    availableDockerStorageBytes: crawl4aiMinimumDockerStorageBytes,
    imageCached: false,
  }), true);
});
