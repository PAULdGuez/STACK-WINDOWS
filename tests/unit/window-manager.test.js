'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load the real win32 module (koffi is mocked in setup.mjs so this works)
// and window-manager which depends on it via require('./win32')
const win32 = require('../../src/main/win32');
const { WindowManager, CONTROLLER_WIDTH, HEADER_HEIGHT } = require('../../src/main/window-manager');

// The api object is shared between win32 and window-manager (same CJS module cache)
// We use vi.spyOn to mock individual api functions on the shared object
const api = win32.api;

// Default screen bounds used in layout tests
const DEFAULT_SCREEN = {
  x: 0,
  y: 0,
  width: 300,
  height: 1040,
  displayRightEdge: 1920,
};

// Track all spies so we can restore them after each test
let spies = [];

function spyOn(obj, method, impl) {
  const spy = vi.spyOn(obj, method).mockImplementation(impl);
  spies.push(spy);
  return spy;
}

function spyReturn(obj, method, value) {
  const spy = vi.spyOn(obj, method).mockReturnValue(value);
  spies.push(spy);
  return spy;
}

describe('WindowManager', () => {
  let wm;

  beforeEach(() => {
    // Restore all previous spies
    spies.forEach((s) => s.mockRestore());
    spies = [];

    // Set up default mock implementations for all api functions
    spyReturn(api, 'IsWindow', 1);
    spyReturn(api, 'IsWindowVisible', 1);
    spyReturn(api, 'IsIconic', 0);
    spyReturn(api, 'IsZoomed', 0);
    spyOn(api, 'GetWindowRect', (hwnd, rect) => {
      rect.left = 0;
      rect.top = 0;
      rect.right = 800;
      rect.bottom = 600;
      return 1;
    });
    spyReturn(api, 'SetWindowPos', 1);
    spyReturn(api, 'BeginDeferWindowPos', 1);
    spyReturn(api, 'DeferWindowPos', 1);
    spyReturn(api, 'EndDeferWindowPos', 1);
    spyReturn(api, 'ShowWindow', 1);
    spyReturn(api, 'SetForegroundWindow', 1);
    spyReturn(api, 'GetForegroundWindow', 0);
    spyReturn(api, 'GetWindowLongPtrW', 0);
    spyOn(api, 'GetWindowThreadProcessId', (hwnd, pidBuf) => {
      pidBuf[0] = 999;
      return 1;
    });
    spyReturn(api, 'GetWindowTextLengthW', 10);
    spyOn(api, 'GetWindowTextW', (hwnd, buf) => {
      buf[0] = 'Test Window';
      return 11;
    });
    spyReturn(api, 'EnumWindows', 1);

    wm = new WindowManager();
  });

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
  });

  // ─── Constructor ────────────────────────────────────────────────────────────

  describe('Constructor', () => {
    it('initializes managedWindows as empty array', () => {
      expect(wm.managedWindows).toEqual([]);
    });

    it('initializes activeHwnd to 0', () => {
      expect(wm.activeHwnd).toBe(0);
    });

    it('initializes stackName to default', () => {
      expect(wm.stackName).toBe('Managed Stack');
    });

    it('initializes hideAvailable to false', () => {
      expect(wm.hideAvailable).toBe(false);
    });

    it('initializes sortAvailableAlpha to false', () => {
      expect(wm.sortAvailableAlpha).toBe(false);
    });

    it('initializes backgroundColor to black', () => {
      expect(wm.backgroundColor).toBe('#000000');
    });

    it('initializes stackGap to 0', () => {
      expect(wm.stackGap).toBe(0);
    });

    it('initializes topOffset to 0', () => {
      expect(wm.topOffset).toBe(0);
    });

    it('initializes customWidth to null', () => {
      expect(wm.customWidth).toBeNull();
    });

    it('initializes customHeight to null', () => {
      expect(wm.customHeight).toBeNull();
    });

    it('initializes lightMode to false', () => {
      expect(wm.lightMode).toBe(false);
    });

    it('initializes dynamicReorder to false', () => {
      expect(wm.dynamicReorder).toBe(false);
    });
  });

  // ─── addWindow ──────────────────────────────────────────────────────────────

  describe('addWindow', () => {
    it('adds a window to the front of managedWindows', () => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      expect(wm.managedWindows[0].hwnd).toBe(1002);
      expect(wm.managedWindows[1].hwnd).toBe(1001);
    });

    it('sets activeHwnd to the newly added window', () => {
      wm.addWindow(1001, 'Window A');
      expect(wm.activeHwnd).toBe(1001);
      wm.addWindow(1002, 'Window B');
      expect(wm.activeHwnd).toBe(1002);
    });

    it('ignores duplicate hwnd', () => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1001, 'Window A again');
      expect(wm.managedWindows.length).toBe(1);
    });

    it('calls IsWindow to validate the handle', () => {
      wm.addWindow(1001, 'Window A');
      expect(api.IsWindow).toHaveBeenCalledWith(1001);
    });

    it('does not add window if IsWindow returns 0', () => {
      api.IsWindow.mockReturnValue(0);
      wm.addWindow(1001, 'Window A');
      expect(wm.managedWindows.length).toBe(0);
    });

    it('stores the provided title', () => {
      wm.addWindow(1001, 'My Window');
      expect(wm.managedWindows[0].title).toBe('My Window');
    });

    it('stores processId from GetWindowThreadProcessId', () => {
      api.GetWindowThreadProcessId.mockImplementation((hwnd, pidBuf) => {
        pidBuf[0] = 1234;
        return 1;
      });
      wm.addWindow(1001, 'Window A');
      expect(wm.managedWindows[0].processId).toBe(1234);
    });

    it('stores originalRect from GetWindowRect', () => {
      api.GetWindowRect.mockImplementation((hwnd, rect) => {
        rect.left = 10;
        rect.top = 20;
        rect.right = 810;
        rect.bottom = 620;
        return 1;
      });
      wm.addWindow(1001, 'Window A');
      expect(wm.managedWindows[0].originalRect).toEqual({ left: 10, top: 20, right: 810, bottom: 620 });
    });

    it('initializes customTitle to null', () => {
      wm.addWindow(1001, 'Window A');
      expect(wm.managedWindows[0].customTitle).toBeNull();
    });
  });

  // ─── removeWindow ───────────────────────────────────────────────────────────

  describe('removeWindow', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      wm.addWindow(1003, 'Window C');
    });

    it('removes the window from managedWindows', () => {
      wm.removeWindow(1002);
      expect(wm.managedWindows.some((w) => w.hwnd === 1002)).toBe(false);
    });

    it('does nothing for non-existent hwnd', () => {
      const lenBefore = wm.managedWindows.length;
      wm.removeWindow(9999);
      expect(wm.managedWindows.length).toBe(lenBefore);
    });

    it('updates activeHwnd to first window if active was removed', () => {
      // activeHwnd is 1003 (last added = front)
      expect(wm.activeHwnd).toBe(1003);
      wm.removeWindow(1003);
      // After removal, first remaining window becomes active
      expect(wm.activeHwnd).toBe(wm.managedWindows[0].hwnd);
    });

    it('keeps activeHwnd unchanged if non-active window is removed', () => {
      // activeHwnd = 1003
      wm.removeWindow(1001);
      expect(wm.activeHwnd).toBe(1003);
    });

    it('sets activeHwnd to 0 when last window is removed', () => {
      wm.removeWindow(1001);
      wm.removeWindow(1002);
      wm.removeWindow(1003);
      expect(wm.activeHwnd).toBe(0);
    });
  });

  // ─── promoteToActive ────────────────────────────────────────────────────────

  describe('promoteToActive', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      // activeHwnd = 1002 (last added)
    });

    it('returns true when active window changes', () => {
      const result = wm.promoteToActive(1001);
      expect(result).toBe(true);
    });

    it('changes activeHwnd to the promoted window', () => {
      wm.promoteToActive(1001);
      expect(wm.activeHwnd).toBe(1001);
    });

    it('returns false when promoting already-active window', () => {
      const result = wm.promoteToActive(1002);
      expect(result).toBe(false);
    });

    it('returns false for hwnd not in managedWindows', () => {
      const result = wm.promoteToActive(9999);
      expect(result).toBe(false);
    });

    it('moves window to end of array when dynamicReorder is enabled', () => {
      wm.dynamicReorder = true;
      wm.addWindow(1003, 'Window C');
      // Order: [1003, 1002, 1001], activeHwnd = 1003
      // Promote 1001 (currently at index 2)
      wm.promoteToActive(1001);
      const lastIdx = wm.managedWindows.length - 1;
      expect(wm.managedWindows[lastIdx].hwnd).toBe(1001);
    });

    it('does not reorder when dynamicReorder is disabled', () => {
      wm.dynamicReorder = false;
      const orderBefore = wm.managedWindows.map((w) => w.hwnd);
      wm.promoteToActive(1001);
      const orderAfter = wm.managedWindows.map((w) => w.hwnd);
      expect(orderAfter).toEqual(orderBefore);
    });
  });

  // ─── removeDeadWindows ──────────────────────────────────────────────────────

  describe('removeDeadWindows', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      wm.addWindow(1003, 'Window C');
    });

    it('removes windows where IsWindow returns 0', () => {
      api.IsWindow.mockImplementation((hwnd) => (hwnd === 1002 ? 0 : 1));
      wm.removeDeadWindows();
      expect(wm.managedWindows.some((w) => w.hwnd === 1002)).toBe(false);
    });

    it('keeps windows where IsWindow returns 1', () => {
      api.IsWindow.mockReturnValue(1);
      wm.removeDeadWindows();
      expect(wm.managedWindows.length).toBe(3);
    });

    it('returns true when windows were removed', () => {
      api.IsWindow.mockImplementation((hwnd) => (hwnd === 1002 ? 0 : 1));
      const result = wm.removeDeadWindows();
      expect(result).toBe(true);
    });

    it('returns false when no windows were removed', () => {
      api.IsWindow.mockReturnValue(1);
      const result = wm.removeDeadWindows();
      expect(result).toBe(false);
    });

    it('updates activeHwnd when active window is dead', () => {
      // activeHwnd = 1003 (last added = front)
      api.IsWindow.mockImplementation((hwnd) => (hwnd === 1003 ? 0 : 1));
      wm.removeDeadWindows();
      expect(wm.activeHwnd).not.toBe(1003);
      expect(wm.managedWindows.some((w) => w.hwnd === wm.activeHwnd)).toBe(true);
    });

    it('sets activeHwnd to 0 when all windows are dead', () => {
      api.IsWindow.mockReturnValue(0);
      wm.removeDeadWindows();
      expect(wm.activeHwnd).toBe(0);
      expect(wm.managedWindows.length).toBe(0);
    });
  });

  // ─── reorderWindow ──────────────────────────────────────────────────────────

  describe('reorderWindow', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      wm.addWindow(1003, 'Window C');
      // Order: [1003, 1002, 1001]
    });

    it('moves window to the correct index', () => {
      wm.reorderWindow(1001, 0);
      expect(wm.managedWindows[0].hwnd).toBe(1001);
    });

    it('returns true for valid hwnd', () => {
      const result = wm.reorderWindow(1001, 0);
      expect(result).toBe(true);
    });

    it('returns false for invalid hwnd', () => {
      const result = wm.reorderWindow(9999, 0);
      expect(result).toBe(false);
    });

    it('clamps out-of-bounds index to 0', () => {
      wm.reorderWindow(1001, -5);
      expect(wm.managedWindows[0].hwnd).toBe(1001);
    });

    it('clamps out-of-bounds index to last position', () => {
      wm.reorderWindow(1003, 100);
      const lastIdx = wm.managedWindows.length - 1;
      expect(wm.managedWindows[lastIdx].hwnd).toBe(1003);
    });

    it('returns true when window is already at target index', () => {
      // 1003 is at index 0
      const result = wm.reorderWindow(1003, 0);
      expect(result).toBe(true);
    });
  });

  // ─── layoutStack ────────────────────────────────────────────────────────────

  describe('layoutStack', () => {
    it('returns early with 0 windows', () => {
      wm.layoutStack(DEFAULT_SCREEN);
      expect(api.BeginDeferWindowPos).not.toHaveBeenCalled();
    });

    it('positions single window at full effective size', () => {
      wm.addWindow(1001, 'Window A');
      wm.layoutStack(DEFAULT_SCREEN);
      expect(api.BeginDeferWindowPos).toHaveBeenCalled();
      expect(api.DeferWindowPos).toHaveBeenCalled();
      // With 1 window (active), inactiveCount = 0, so activeY = startY
      const call = api.DeferWindowPos.mock.calls[0];
      // call: (hInfo, hwnd, HWND_TOP, x, y, cx, cy, flags)
      expect(call[1]).toBe(1001);
    });

    it('positions 2 windows: one strip + one active', () => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      // activeHwnd = 1002
      wm.layoutStack(DEFAULT_SCREEN);
      expect(api.DeferWindowPos).toHaveBeenCalledTimes(2);
    });

    it('respects customWidth', () => {
      wm.addWindow(1001, 'Window A');
      wm.customWidth = 500;
      wm.layoutStack(DEFAULT_SCREEN);
      const call = api.DeferWindowPos.mock.calls[0];
      // cx (width) should be 500
      expect(call[5]).toBe(500);
    });

    it('respects customHeight', () => {
      wm.addWindow(1001, 'Window A');
      wm.customHeight = 400;
      wm.layoutStack(DEFAULT_SCREEN);
      const call = api.DeferWindowPos.mock.calls[0];
      // cy (height) for single active window = effectiveHeight = 400
      expect(call[6]).toBe(400);
    });

    it('respects stackGap by shifting startX', () => {
      wm.addWindow(1001, 'Window A');
      wm.stackGap = 10;
      wm.layoutStack(DEFAULT_SCREEN);
      const call = api.DeferWindowPos.mock.calls[0];
      // x = workArea.x + workArea.width + stackGap = 0 + 300 + 10 = 310
      expect(call[3]).toBe(310);
    });

    it('respects topOffset by shifting startY', () => {
      wm.addWindow(1001, 'Window A');
      wm.topOffset = 50;
      wm.layoutStack(DEFAULT_SCREEN);
      const call = api.DeferWindowPos.mock.calls[0];
      // y = workArea.y + topOffset = 0 + 50 = 50
      expect(call[4]).toBe(50);
    });

    it('compresses header height when strips exceed 60% of height', () => {
      // Add many windows so strips would exceed 60% of height
      // effectiveHeight = 1040, 60% = 624, HEADER_HEIGHT = 40
      // Need > 624/40 = 15.6 → 16 inactive windows
      for (let i = 1; i <= 20; i++) {
        wm.addWindow(1000 + i, `Window ${i}`);
      }
      // activeHwnd = 1020 (last added)
      wm.layoutStack(DEFAULT_SCREEN);
      // With 19 inactive windows and effectiveHeight=1040:
      // maxStripArea = floor(1040 * 0.6) = 624
      // 19 * 40 = 760 > 624, so effectiveHeaderHeight = floor(624/19) = 32
      // Verify DeferWindowPos was called for all 20 windows
      expect(api.DeferWindowPos).toHaveBeenCalledTimes(20);
    });

    it('skips layout when available width is too small', () => {
      wm.addWindow(1001, 'Window A');
      const tinyScreen = { x: 0, y: 0, width: 300, height: 1040, displayRightEdge: 400 };
      // availableWidth = 400 - 300 = 100 < 200
      wm.layoutStack(tinyScreen);
      expect(api.BeginDeferWindowPos).not.toHaveBeenCalled();
    });

    it('skips window matching skipHwnd', () => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      wm.layoutStack(DEFAULT_SCREEN, 1001);
      // Only 1 window should be positioned (1002 is active, 1001 is skipped)
      expect(api.DeferWindowPos).toHaveBeenCalledTimes(1);
    });
  });

  // ─── setCustomDimensions ────────────────────────────────────────────────────

  describe('setCustomDimensions', () => {
    it('sets customWidth and customHeight', () => {
      wm.setCustomDimensions(800, 600);
      expect(wm.customWidth).toBe(800);
      expect(wm.customHeight).toBe(600);
    });

    it('clamps width to minimum 200', () => {
      wm.setCustomDimensions(50, 600);
      expect(wm.customWidth).toBe(200);
    });

    it('clamps height to minimum 200', () => {
      wm.setCustomDimensions(800, 50);
      expect(wm.customHeight).toBe(200);
    });

    it('resets customWidth to null when null is passed', () => {
      wm.setCustomDimensions(800, 600);
      wm.setCustomDimensions(null, 600);
      expect(wm.customWidth).toBeNull();
    });

    it('resets customHeight to null when null is passed', () => {
      wm.setCustomDimensions(800, 600);
      wm.setCustomDimensions(800, null);
      expect(wm.customHeight).toBeNull();
    });

    it('resets both to null', () => {
      wm.setCustomDimensions(800, 600);
      wm.setCustomDimensions(null, null);
      expect(wm.customWidth).toBeNull();
      expect(wm.customHeight).toBeNull();
    });
  });

  // ─── setStackGap ────────────────────────────────────────────────────────────

  describe('setStackGap', () => {
    it('sets stackGap to valid value', () => {
      wm.setStackGap(100);
      expect(wm.stackGap).toBe(100);
    });

    it('clamps stackGap to 0 minimum', () => {
      wm.setStackGap(-50);
      expect(wm.stackGap).toBe(0);
    });

    it('clamps stackGap to 500 maximum', () => {
      wm.setStackGap(1000);
      expect(wm.stackGap).toBe(500);
    });

    it('sets stackGap to 0 when null is passed', () => {
      wm.setStackGap(100);
      wm.setStackGap(null);
      expect(wm.stackGap).toBe(0);
    });
  });

  // ─── setTopOffset ───────────────────────────────────────────────────────────

  describe('setTopOffset', () => {
    it('sets topOffset to valid value', () => {
      wm.setTopOffset(100);
      expect(wm.topOffset).toBe(100);
    });

    it('clamps topOffset to 0 minimum', () => {
      wm.setTopOffset(-50);
      expect(wm.topOffset).toBe(0);
    });

    it('clamps topOffset to 500 maximum', () => {
      wm.setTopOffset(1000);
      expect(wm.topOffset).toBe(500);
    });

    it('sets topOffset to 0 when null is passed', () => {
      wm.setTopOffset(100);
      wm.setTopOffset(null);
      expect(wm.topOffset).toBe(0);
    });
  });

  // ─── getState ───────────────────────────────────────────────────────────────

  describe('getState', () => {
    it('returns correct serializable state with no windows', () => {
      const state = wm.getState();
      expect(state).toMatchObject({
        stackName: 'Managed Stack',
        hideAvailable: false,
        sortAvailableAlpha: false,
        backgroundColor: '#000000',
        customWidth: null,
        customHeight: null,
        stackGap: 0,
        topOffset: 0,
        lightMode: false,
        dynamicReorder: false,
        windows: [],
      });
    });

    it('includes managed windows in state', () => {
      wm.addWindow(1001, 'Window A');
      const state = wm.getState();
      expect(state.windows.length).toBe(1);
      expect(state.windows[0].hwnd).toBe(1001);
      expect(state.windows[0].title).toBe('Window A');
    });

    it('includes customTitle in window state', () => {
      wm.addWindow(1001, 'Window A');
      wm.renameWindow(1001, 'Custom Name');
      const state = wm.getState();
      expect(state.windows[0].customTitle).toBe('Custom Name');
    });

    it('reflects updated settings in state', () => {
      wm.setStackGap(50);
      wm.setTopOffset(30);
      wm.setCustomDimensions(800, 600);
      wm.setLightMode(true);
      wm.setDynamicReorder(true);
      const state = wm.getState();
      expect(state.stackGap).toBe(50);
      expect(state.topOffset).toBe(30);
      expect(state.customWidth).toBe(800);
      expect(state.customHeight).toBe(600);
      expect(state.lightMode).toBe(true);
      expect(state.dynamicReorder).toBe(true);
    });
  });

  // ─── renameWindow ───────────────────────────────────────────────────────────

  describe('renameWindow', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
    });

    it('sets customTitle on the window', () => {
      wm.renameWindow(1001, 'My Custom Name');
      expect(wm.managedWindows[0].customTitle).toBe('My Custom Name');
    });

    it('returns true when window is found', () => {
      const result = wm.renameWindow(1001, 'My Custom Name');
      expect(result).toBe(true);
    });

    it('returns false when window is not found', () => {
      const result = wm.renameWindow(9999, 'My Custom Name');
      expect(result).toBe(false);
    });

    it('clears customTitle when null is passed', () => {
      wm.renameWindow(1001, 'My Custom Name');
      wm.renameWindow(1001, null);
      expect(wm.managedWindows[0].customTitle).toBeNull();
    });

    it('clears customTitle when empty string is passed', () => {
      wm.renameWindow(1001, 'My Custom Name');
      wm.renameWindow(1001, '');
      expect(wm.managedWindows[0].customTitle).toBeNull();
    });

    it('trims whitespace from customTitle', () => {
      wm.renameWindow(1001, '  Trimmed  ');
      expect(wm.managedWindows[0].customTitle).toBe('Trimmed');
    });
  });

  // ─── restoreAll ─────────────────────────────────────────────────────────────

  describe('restoreAll', () => {
    beforeEach(() => {
      wm.addWindow(1001, 'Window A');
      wm.addWindow(1002, 'Window B');
      wm.addWindow(1003, 'Window C');
    });

    it('clears managedWindows after restore', () => {
      wm.restoreAll();
      expect(wm.managedWindows.length).toBe(0);
    });

    it('resets activeHwnd to 0', () => {
      wm.restoreAll();
      expect(wm.activeHwnd).toBe(0);
    });

    it('calls SetWindowPos for each window', () => {
      wm.restoreAll();
      expect(api.SetWindowPos).toHaveBeenCalledTimes(3);
    });

    it('skips dead windows during restoreAll', () => {
      api.IsWindow.mockImplementation((hwnd) => (hwnd === 1002 ? 0 : 1));
      wm.restoreAll();
      // SetWindowPos should only be called for alive windows (1001 and 1003)
      expect(api.SetWindowPos).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Exported constants ─────────────────────────────────────────────────────

  describe('Exported constants', () => {
    it('exports CONTROLLER_WIDTH as a number', () => {
      expect(typeof CONTROLLER_WIDTH).toBe('number');
      expect(CONTROLLER_WIDTH).toBeGreaterThan(0);
    });

    it('exports HEADER_HEIGHT as a number', () => {
      expect(typeof HEADER_HEIGHT).toBe('number');
      expect(HEADER_HEIGHT).toBeGreaterThan(0);
    });
  });
});
