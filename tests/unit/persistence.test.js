import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Module from 'module';

const require = createRequire(import.meta.url);

// ─── Inject electron mock into Node.js CJS module cache ──────────────────────
// Vitest's vi.mock intercepts ESM imports but not CJS require() calls from
// within CJS source files. We inject the mock directly into Node.js's module
// cache so that persistence.js's require('electron') gets the mock.
const tmpBase = path.join(os.tmpdir(), 'swe-test-persistence-' + process.pid);
const electronMock = {
  app: {
    getPath: vi.fn(() => tmpBase),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    })),
  },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
};

// Find the resolved path of the electron module
const electronPath = require.resolve('electron');

// Inject mock into Node.js module cache
const mockModule = new Module(electronPath);
mockModule.exports = electronMock;
mockModule.loaded = true;
Module._cache[electronPath] = mockModule;

// Now load persistence.js — its require('electron') will get our mock
const { Persistence } = require('../../src/main/persistence');

let tmpDir;

beforeEach(() => {
  tmpDir = tmpBase;
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: build a minimal valid state object
function makeState(overrides = {}) {
  return {
    stackName: 'Test Stack',
    hideAvailable: false,
    sortAvailableAlpha: true,
    customWidth: 400,
    customHeight: 600,
    backgroundColor: '#ffffff',
    stackGap: 4,
    topOffset: 10,
    lightMode: true,
    dynamicReorder: false,
    windows: [{ id: 1, title: 'Window A' }],
    ...overrides,
  };
}

// Helper: create a Persistence instance with filePath set directly (bypasses electron mock)
function makePersistence(instanceId) {
  const p = new Persistence();
  p.instanceId = instanceId || null;
  if (instanceId) {
    p.filePath = path.join(tmpDir, `window-group-${instanceId}.json`);
  } else {
    p.filePath = path.join(tmpDir, 'window-group.json');
  }
  return p;
}

// ─── init() ──────────────────────────────────────────────────────────────────

describe('Persistence.init()', () => {
  it('creates correct file path with instanceId', () => {
    const p = new Persistence();
    p.init('abc123');
    expect(p.filePath).toBe(path.join(tmpDir, 'window-group-abc123.json'));
    expect(p.instanceId).toBe('abc123');
  });

  it('creates correct file path without instanceId', () => {
    const p = new Persistence();
    p.init();
    expect(p.filePath).toBe(path.join(tmpDir, 'window-group.json'));
    expect(p.instanceId).toBeNull();
  });

  it('creates correct file path when instanceId is null', () => {
    const p = new Persistence();
    p.init(null);
    expect(p.filePath).toBe(path.join(tmpDir, 'window-group.json'));
    expect(p.instanceId).toBeNull();
  });
});

// ─── save() ──────────────────────────────────────────────────────────────────

describe('Persistence.save()', () => {
  it('writes a valid JSON file', async () => {
    const p = makePersistence('s1');
    await p.save(makeState());
    expect(fs.existsSync(p.filePath)).toBe(true);
    const raw = fs.readFileSync(p.filePath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('includes version:2 in saved data', async () => {
    const p = makePersistence('s2');
    await p.save(makeState());
    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));
    expect(data.version).toBe(2);
  });

  it('includes all expected fields', async () => {
    const p = makePersistence('s3');
    const state = makeState();
    await p.save(state);
    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));

    expect(data).toHaveProperty('stackName', state.stackName);
    expect(data).toHaveProperty('hideAvailable', state.hideAvailable);
    expect(data).toHaveProperty('sortAvailableAlpha', state.sortAvailableAlpha);
    expect(data).toHaveProperty('customWidth', state.customWidth);
    expect(data).toHaveProperty('customHeight', state.customHeight);
    expect(data).toHaveProperty('backgroundColor', state.backgroundColor);
    expect(data).toHaveProperty('stackGap', state.stackGap);
    expect(data).toHaveProperty('topOffset', state.topOffset);
    expect(data).toHaveProperty('lightMode', state.lightMode);
    expect(data).toHaveProperty('dynamicReorder', state.dynamicReorder);
    expect(data).toHaveProperty('windows');
    expect(data.windows).toEqual(state.windows);
  });

  it('does nothing when filePath is null', async () => {
    const p = new Persistence();
    // filePath is null by default — never call init()
    await expect(p.save(makeState())).resolves.toBeUndefined();
  });

  it('saves with empty windows array', async () => {
    const p = makePersistence('s4');
    await p.save(makeState({ windows: [] }));
    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));
    expect(data.windows).toEqual([]);
  });
});

// ─── saveSync() ───────────────────────────────────────────────────────────────

describe('Persistence.saveSync()', () => {
  it('writes synchronously and file exists immediately', () => {
    const p = makePersistence('ss1');
    p.saveSync(makeState());
    expect(fs.existsSync(p.filePath)).toBe(true);
  });

  it('produces same format as save() — version:2 and all fields', () => {
    const p = makePersistence('ss2');
    const state = makeState();
    p.saveSync(state);
    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));

    expect(data.version).toBe(2);
    expect(data).toHaveProperty('stackName', state.stackName);
    expect(data).toHaveProperty('hideAvailable', state.hideAvailable);
    expect(data).toHaveProperty('sortAvailableAlpha', state.sortAvailableAlpha);
    expect(data).toHaveProperty('customWidth', state.customWidth);
    expect(data).toHaveProperty('customHeight', state.customHeight);
    expect(data).toHaveProperty('backgroundColor', state.backgroundColor);
    expect(data).toHaveProperty('stackGap', state.stackGap);
    expect(data).toHaveProperty('topOffset', state.topOffset);
    expect(data).toHaveProperty('lightMode', state.lightMode);
    expect(data).toHaveProperty('dynamicReorder', state.dynamicReorder);
    expect(data.windows).toEqual(state.windows);
  });

  it('does nothing when filePath is null', () => {
    const p = new Persistence();
    // filePath is null by default
    expect(() => p.saveSync(makeState())).not.toThrow();
  });
});

// ─── Write guard ──────────────────────────────────────────────────────────────

describe('Persistence write guard', () => {
  it('queues second save and flushes LAST state after first completes', async () => {
    const p = makePersistence('wg1');

    const firstState = makeState({ stackName: 'First' });
    const secondState = makeState({ stackName: 'Second' });

    // Start first save (async, not awaited yet)
    const firstSave = p.save(firstState);
    // Immediately call save again — should be queued
    const secondSave = p.save(secondState);

    // Wait for both to settle
    await firstSave;
    await secondSave;
    // Give the flushed pending save time to complete
    await new Promise((r) => setTimeout(r, 50));

    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));
    // The LAST state must win
    expect(data.stackName).toBe('Second');
  });

  it('write guard resets after completion — subsequent saves work normally', async () => {
    const p = makePersistence('wg2');

    await p.save(makeState({ stackName: 'Alpha' }));
    await p.save(makeState({ stackName: 'Beta' }));

    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf-8'));
    expect(data.stackName).toBe('Beta');
    expect(p._writing).toBe(false);
  });
});

// ─── cleanupFile() ────────────────────────────────────────────────────────────

describe('Persistence.cleanupFile()', () => {
  it('deletes the file when instanceId is set', async () => {
    const p = makePersistence('cl1');
    await p.save(makeState());
    expect(fs.existsSync(p.filePath)).toBe(true);

    p.cleanupFile();
    expect(fs.existsSync(p.filePath)).toBe(false);
  });

  it('does nothing when instanceId is null', () => {
    const p = makePersistence(null); // no instanceId
    // Create the file manually to verify it is NOT deleted
    fs.writeFileSync(p.filePath, '{}', 'utf-8');

    p.cleanupFile();
    // File should still exist because instanceId is null
    expect(fs.existsSync(p.filePath)).toBe(true);
  });

  it('does not throw when file does not exist', () => {
    const p = makePersistence('cl2');
    // Do NOT create the file
    expect(() => p.cleanupFile()).not.toThrow();
  });
});
