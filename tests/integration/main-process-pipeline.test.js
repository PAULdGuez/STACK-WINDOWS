/**
 * Integration tests — main-process module pipeline verification
 *
 * Tests that WindowManager and ForegroundMonitor work together correctly by
 * simulating the orchestration pipelines that main.js wires up.
 *
 * Strategy:
 *   - window-manager.js and foreground-monitor.js are CommonJS modules that
 *     require('./win32') at load time.
 *   - setup.mjs already mocks 'koffi', so win32.js loads successfully and
 *     exports a real `api` object whose methods are koffi vi.fn() stubs.
 *   - We patch win32.api methods directly (they are plain object properties)
 *     so that window-manager.js sees the patched versions.
 *   - This avoids the ESM/CJS mock-interception mismatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Load modules via CJS require — same resolution path as window-manager.js
// ---------------------------------------------------------------------------
const win32 = require('../../src/main/win32');
const { WindowManager } = require('../../src/main/window-manager.js');
const { ForegroundMonitor } = require('../../src/main/foreground-monitor.js');

// ---------------------------------------------------------------------------
// Patch win32.api before each test and restore defaults
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Replace every api method with a fresh vi.fn() so call counts reset
  win32.api.IsWindow = vi.fn(() => 1);
  win32.api.IsWindowVisible = vi.fn(() => 1);
  win32.api.IsIconic = vi.fn(() => 0);
  win32.api.IsZoomed = vi.fn(() => 0);
  win32.api.GetWindowRect = vi.fn((hwnd, rect) => {
    Object.assign(rect, { left: 0, top: 0, right: 800, bottom: 600 });
    return 1;
  });
  win32.api.SetWindowPos = vi.fn(() => 1);
  win32.api.BeginDeferWindowPos = vi.fn(() => 1);
  win32.api.DeferWindowPos = vi.fn(() => 1);
  win32.api.EndDeferWindowPos = vi.fn(() => 1);
  win32.api.ShowWindow = vi.fn(() => 1);
  win32.api.SetForegroundWindow = vi.fn(() => 1);
  win32.api.GetForegroundWindow = vi.fn(() => 0);
  win32.api.GetWindowThreadProcessId = vi.fn((h, buf) => {
    buf[0] = 999;
    return 1;
  });
  win32.api.GetWindowTextLengthW = vi.fn(() => 4);
  win32.api.GetWindowTextW = vi.fn((h, buf) => {
    buf[0] = 'Test';
    return 4;
  });
  win32.api.GetWindowLongPtrW = vi.fn(() => 0);
  win32.api.EnumWindows = vi.fn(() => 1);
  win32.api.SetWinEventHook = vi.fn(() => 42);
  win32.api.UnhookWinEvent = vi.fn(() => 1);

  // Also patch koffi on the win32 module so ForegroundMonitor can register callbacks
  win32.koffi.register = vi.fn(() => ({}));
  win32.koffi.unregister = vi.fn();
  win32.koffi.pointer = vi.fn((x) => x);
  win32.koffi.address = vi.fn(() => 0);
});

// ---------------------------------------------------------------------------
// Pipeline 1 — Add-window pipeline
// ---------------------------------------------------------------------------
describe('Pipeline 1: add-window', () => {
  it('adds a window, sets it as active, and produces serializable state', () => {
    const wm = new WindowManager();

    wm.addWindow(12345, 'Test Window');

    // Window was added
    expect(wm.managedWindows).toHaveLength(1);
    // Active HWND is set immediately
    expect(wm.activeHwnd).toBe(12345);

    // State is serializable and contains the window
    const state = wm.getState();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].hwnd).toBe(12345);
    expect(state.windows[0].title).toBe('Test Window');
  });

  it('does not add the same window twice', () => {
    const wm = new WindowManager();

    wm.addWindow(12345, 'Test Window');
    wm.addWindow(12345, 'Test Window Again');

    expect(wm.managedWindows).toHaveLength(1);
  });

  it('adds multiple windows and inserts each at the front', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B');

    // Most recently added window is at index 0 (unshift)
    expect(wm.managedWindows[0].hwnd).toBe(200);
    expect(wm.managedWindows[1].hwnd).toBe(100);
    // Active is the last added
    expect(wm.activeHwnd).toBe(200);
  });

  it('skips adding a window when IsWindow returns 0', () => {
    const wm = new WindowManager();

    win32.api.IsWindow = vi.fn(() => 0);
    wm.addWindow(99999, 'Ghost Window');

    expect(wm.managedWindows).toHaveLength(0);
    expect(wm.activeHwnd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline 2 — Focus-change pipeline
// ---------------------------------------------------------------------------
describe('Pipeline 2: focus-change', () => {
  it('promoteToActive changes the active window and returns true', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B'); // activeHwnd = 200

    const changed = wm.promoteToActive(100);

    expect(changed).toBe(true);
    expect(wm.activeHwnd).toBe(100);
  });

  it('promoteToActive returns false when window is already active', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A'); // activeHwnd = 100

    const changed = wm.promoteToActive(100);

    expect(changed).toBe(false);
    expect(wm.activeHwnd).toBe(100);
  });

  it('promoteToActive returns false for unmanaged window', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');

    const changed = wm.promoteToActive(999);

    expect(changed).toBe(false);
    expect(wm.activeHwnd).toBe(100);
  });

  it('ForegroundMonitor updateManagedSet tracks the correct hwnds', () => {
    const fm = new ForegroundMonitor();
    const onFocusChange = vi.fn();

    fm.start(onFocusChange);
    fm.updateManagedSet([12345, 67890]);

    // Internal set should contain the provided hwnds
    expect(fm._managedHwnds.has(12345)).toBe(true);
    expect(fm._managedHwnds.has(67890)).toBe(true);
    expect(fm._managedHwnds.has(99999)).toBe(false);

    fm.stop();
  });

  it('ForegroundMonitor stop cleans up hook and callback', () => {
    const fm = new ForegroundMonitor();
    const onFocusChange = vi.fn();

    fm.start(onFocusChange);
    expect(fm._hook).toBeTruthy();

    fm.stop();
    expect(fm._hook).toBeNull();
    expect(fm._callback).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pipeline 3 — Cleanup pipeline (removeDeadWindows)
// ---------------------------------------------------------------------------
describe('Pipeline 3: cleanup (removeDeadWindows)', () => {
  it('removes windows where IsWindow returns 0', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Alive Window');
    wm.addWindow(200, 'Dead Window');

    // Make hwnd 200 appear dead
    win32.api.IsWindow = vi.fn((hwnd) => (hwnd === 200 ? 0 : 1));

    const changed = wm.removeDeadWindows();

    expect(changed).toBe(true);
    expect(wm.managedWindows).toHaveLength(1);
    expect(wm.managedWindows[0].hwnd).toBe(100);
  });

  it('updates activeHwnd when the active window dies', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B'); // activeHwnd = 200

    // Kill the active window
    win32.api.IsWindow = vi.fn((hwnd) => (hwnd === 200 ? 0 : 1));

    wm.removeDeadWindows();

    // Active should fall back to the first remaining window
    expect(wm.activeHwnd).toBe(100);
  });

  it('returns false when no windows were removed', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    win32.api.IsWindow = vi.fn(() => 1);

    const changed = wm.removeDeadWindows();

    expect(changed).toBe(false);
    expect(wm.managedWindows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline 4 — Remove-window pipeline
// ---------------------------------------------------------------------------
describe('Pipeline 4: remove-window', () => {
  it('removes a window and updates activeHwnd to the next window', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B'); // activeHwnd = 200

    wm.removeWindow(200);

    expect(wm.managedWindows).toHaveLength(1);
    expect(wm.managedWindows[0].hwnd).toBe(100);
    // Active falls back to the remaining window
    expect(wm.activeHwnd).toBe(100);
  });

  it('sets activeHwnd to 0 when the last window is removed', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Only Window');

    wm.removeWindow(100);

    expect(wm.managedWindows).toHaveLength(0);
    expect(wm.activeHwnd).toBe(0);
  });

  it('is a no-op when removing an unmanaged hwnd', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');

    wm.removeWindow(999); // not managed

    expect(wm.managedWindows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline 5 — Layout pipeline
// ---------------------------------------------------------------------------
describe('Pipeline 5: layout', () => {
  it('layoutStack calls BeginDeferWindowPos, DeferWindowPos, EndDeferWindowPos', () => {
    const wm = new WindowManager();

    wm.addWindow(12345, 'Test Window');

    const screenBounds = {
      x: 0,
      y: 0,
      width: 300,
      height: 1040,
      displayRightEdge: 1920,
    };

    wm.layoutStack(screenBounds);

    expect(win32.api.BeginDeferWindowPos).toHaveBeenCalled();
    expect(win32.api.DeferWindowPos).toHaveBeenCalled();
    expect(win32.api.EndDeferWindowPos).toHaveBeenCalled();
  });

  it('layoutStack positions multiple windows using the deferred batch API', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B');

    const screenBounds = {
      x: 0,
      y: 0,
      width: 300,
      height: 1040,
      displayRightEdge: 1920,
    };

    wm.layoutStack(screenBounds);

    // DeferWindowPos should be called once per managed window
    expect(win32.api.DeferWindowPos).toHaveBeenCalledTimes(2);
  });

  it('layoutStack does nothing when there are no managed windows', () => {
    const wm = new WindowManager();

    const screenBounds = {
      x: 0,
      y: 0,
      width: 300,
      height: 1040,
      displayRightEdge: 1920,
    };

    wm.layoutStack(screenBounds);

    expect(win32.api.BeginDeferWindowPos).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pipeline 6 — State persistence pipeline
// ---------------------------------------------------------------------------
describe('Pipeline 6: state persistence', () => {
  it('getState returns a complete object compatible with Persistence.save()', () => {
    const wm = new WindowManager();

    wm.addWindow(12345, 'Test Window');
    wm.setStackName('My Stack');
    wm.setBackgroundColor('#ff0000');
    wm.setStackGap(10);
    wm.setTopOffset(20);
    wm.setCustomDimensions(1200, 900);
    wm.setLightMode(true);
    wm.setDynamicReorder(true);

    const state = wm.getState();

    // All fields required by Persistence.save() must be present
    expect(state).toMatchObject({
      stackName: 'My Stack',
      hideAvailable: expect.any(Boolean),
      sortAvailableAlpha: expect.any(Boolean),
      backgroundColor: '#ff0000',
      customWidth: 1200,
      customHeight: 900,
      stackGap: 10,
      topOffset: 20,
      lightMode: true,
      dynamicReorder: true,
      windows: expect.any(Array),
    });

    // Window entries must be serializable
    expect(state.windows[0]).toMatchObject({
      hwnd: 12345,
      title: 'Test Window',
      processId: expect.any(Number),
      originalRect: expect.objectContaining({
        left: expect.any(Number),
        top: expect.any(Number),
        right: expect.any(Number),
        bottom: expect.any(Number),
      }),
    });
  });

  it('getState reflects changes after promoteToActive and removeWindow', () => {
    const wm = new WindowManager();

    wm.addWindow(100, 'Window A');
    wm.addWindow(200, 'Window B');

    // Promote A to active
    wm.promoteToActive(100);

    // Remove B
    wm.removeWindow(200);

    const state = wm.getState();

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].hwnd).toBe(100);
  });

  it('getState returns empty windows array when no windows are managed', () => {
    const wm = new WindowManager();

    const state = wm.getState();

    expect(state.windows).toEqual([]);
  });
});
