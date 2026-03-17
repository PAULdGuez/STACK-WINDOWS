import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '../../src/renderer/index.html');
const JS_PATH = path.join(__dirname, '../../src/renderer/app.js');

function createDOM() {
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  const dom = new JSDOM(html, {
    url: 'http://localhost',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  // Mock electronAPI
  dom.window.electronAPI = {
    getManagedWindows: vi.fn(() =>
      Promise.resolve({
        windows: [],
        activeHwnd: 0,
        stackName: 'TEST STACK',
        hideAvailable: false,
        sortAvailableAlpha: false,
        dynamicReorder: false,
        customWidth: null,
        customHeight: null,
        stackGap: null,
        topOffset: null,
        backgroundColor: '#1a1a2e',
        lightMode: false,
      })
    ),
    getAvailableWindows: vi.fn(() => Promise.resolve([])),
    addWindow: vi.fn(() => Promise.resolve({ success: true })),
    removeWindow: vi.fn(() => Promise.resolve({ success: true })),
    activateWindow: vi.fn(() => Promise.resolve({ success: true })),
    setCustomDimensions: vi.fn(() => Promise.resolve({ success: true })),
    updateStackName: vi.fn(() => Promise.resolve({ success: true })),
    renameWindow: vi.fn(() => Promise.resolve({ success: true })),
    toggleSortAvailableAlpha: vi.fn(() => Promise.resolve({ success: true })),
    toggleDynamicReorder: vi.fn(() => Promise.resolve({ success: true })),
    setBackgroundColor: vi.fn(() => Promise.resolve({ success: true })),
    setLightMode: vi.fn(() => Promise.resolve({ success: true })),
    setStackGap: vi.fn(() => Promise.resolve({ success: true })),
    setTopOffset: vi.fn(() => Promise.resolve({ success: true })),
    reorderWindow: vi.fn(() => Promise.resolve({ success: true })),
    onStateUpdate: vi.fn((cb) => {
      dom.window._stateUpdateCb = cb;
      return () => {};
    }),
    removeAllStateListeners: vi.fn(),
    setColorPickerLock: vi.fn(),
    setRenameFocusLock: vi.fn(),
  };

  // Stub requestAnimationFrame so scheduleRenderManaged works synchronously
  dom.window.requestAnimationFrame = (cb) => {
    setTimeout(cb, 0);
    return 0;
  };

  return dom;
}

describe('Renderer UI', () => {
  let dom;

  beforeEach(() => {
    dom = createDOM();
  });

  afterEach(() => {
    dom.window.close();
  });

  // ─── Initial DOM structure ────────────────────────────────────────────────

  describe('Initial DOM structure', () => {
    it('should have the managed list container', () => {
      expect(dom.window.document.getElementById('managedList')).not.toBeNull();
    });

    it('should have the available list container', () => {
      expect(dom.window.document.getElementById('availableList')).not.toBeNull();
    });

    it('should have the stack title element', () => {
      expect(dom.window.document.getElementById('stackTitle')).not.toBeNull();
    });

    it('should have dimension controls', () => {
      expect(dom.window.document.getElementById('customWidthInput')).not.toBeNull();
      expect(dom.window.document.getElementById('customHeightInput')).not.toBeNull();
      expect(dom.window.document.getElementById('stackGapInput')).not.toBeNull();
    });

    it('should have the DND toggle button', () => {
      expect(dom.window.document.getElementById('dndBtn')).not.toBeNull();
    });

    it('should have the light mode button', () => {
      expect(dom.window.document.getElementById('lightModeBtn')).not.toBeNull();
    });

    it('should have the color picker button', () => {
      expect(dom.window.document.getElementById('colorPickerBtn')).not.toBeNull();
    });

    it('should have the refresh button', () => {
      expect(dom.window.document.getElementById('refreshBtn')).not.toBeNull();
    });

    it('should have the dynamic reorder button', () => {
      expect(dom.window.document.getElementById('dynamicReorderBtn')).not.toBeNull();
    });

    it('should have the rename toggle button', () => {
      expect(dom.window.document.getElementById('renameToggleBtn')).not.toBeNull();
    });

    it('should have the sort alpha button', () => {
      expect(dom.window.document.getElementById('sortAlphaBtn')).not.toBeNull();
    });

    it('should have the toggle available button', () => {
      expect(dom.window.document.getElementById('toggleAvailableBtn')).not.toBeNull();
    });
  });

  // ─── Light mode toggle ────────────────────────────────────────────────────

  describe('Light mode toggle', () => {
    it('should add light-mode class to body when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);

      // Wait for init to complete
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('lightModeBtn');
      expect(btn).not.toBeNull();
      btn.click();

      expect(dom.window.document.body.classList.contains('light-mode')).toBe(true);
    });

    it('should remove light-mode class when toggled twice', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('lightModeBtn');
      btn.click(); // enable
      btn.click(); // disable

      expect(dom.window.document.body.classList.contains('light-mode')).toBe(false);
    });

    it('should call electronAPI.setLightMode when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('lightModeBtn');
      btn.click();

      // Give the async call a tick to fire
      await new Promise((r) => setTimeout(r, 50));
      expect(dom.window.electronAPI.setLightMode).toHaveBeenCalledWith(true);
    });
  });

  // ─── DND mode toggle ──────────────────────────────────────────────────────

  describe('DND mode toggle', () => {
    it('should add dnd-mode class to body when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('dndBtn');
      btn.click();

      expect(dom.window.document.body.classList.contains('dnd-mode')).toBe(true);
    });

    it('should remove dnd-mode class when toggled twice', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('dndBtn');
      btn.click();
      btn.click();

      expect(dom.window.document.body.classList.contains('dnd-mode')).toBe(false);
    });

    it('should add active class to dnd button when enabled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const btn = dom.window.document.getElementById('dndBtn');
      btn.click();

      expect(btn.classList.contains('active')).toBe(true);
    });
  });

  // ─── State sync ───────────────────────────────────────────────────────────

  describe('State sync', () => {
    it('should update stack title from state update', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      if (dom.window._stateUpdateCb) {
        dom.window._stateUpdateCb({
          managed: [],
          activeHwnd: 0,
          stackName: 'NEW NAME',
        });
      }

      await new Promise((r) => setTimeout(r, 100));
      const title = dom.window.document.getElementById('stackTitle');
      expect(title.textContent).toBe('NEW NAME');
    });

    it('should update background color from state update', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      if (dom.window._stateUpdateCb) {
        dom.window._stateUpdateCb({
          managed: [],
          activeHwnd: 0,
          backgroundColor: '#ff0000',
        });
      }

      await new Promise((r) => setTimeout(r, 100));
      const colorBtn = dom.window.document.getElementById('colorPickerBtn');
      expect(colorBtn.style.background).toBe('rgb(255, 0, 0)');
    });

    it('should apply light mode from state update', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      if (dom.window._stateUpdateCb) {
        dom.window._stateUpdateCb({
          managed: [],
          activeHwnd: 0,
          lightMode: true,
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      expect(dom.window.document.body.classList.contains('light-mode')).toBe(true);
    });
  });

  // ─── Managed windows rendering ────────────────────────────────────────────

  describe('Managed windows rendering', () => {
    it('should render managed windows from state', async () => {
      dom.window.electronAPI.getManagedWindows.mockResolvedValue({
        windows: [
          { hwnd: 100, title: 'Window A', customTitle: null },
          { hwnd: 200, title: 'Window B', customTitle: 'Custom B' },
        ],
        activeHwnd: 100,
        stackName: 'TEST',
      });

      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      const managedList = dom.window.document.getElementById('managedList');
      const items = managedList.querySelectorAll('.window-item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('should show empty state when no managed windows', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      const managedList = dom.window.document.getElementById('managedList');
      const emptyState = managedList.querySelector('.empty-state');
      expect(emptyState).not.toBeNull();
    });

    it('should update managed count element', async () => {
      dom.window.electronAPI.getManagedWindows.mockResolvedValue({
        windows: [
          { hwnd: 100, title: 'Window A', customTitle: null },
          { hwnd: 200, title: 'Window B', customTitle: null },
          { hwnd: 300, title: 'Window C', customTitle: null },
        ],
        activeHwnd: 100,
        stackName: 'TEST',
      });

      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      const countEl = dom.window.document.getElementById('managedCount');
      expect(countEl.textContent).toBe('3');
    });

    it('should render managed windows via state update callback', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      if (dom.window._stateUpdateCb) {
        dom.window._stateUpdateCb({
          managed: [
            { hwnd: 101, title: 'State Window 1', customTitle: null },
            { hwnd: 202, title: 'State Window 2', customTitle: null },
          ],
          activeHwnd: 101,
          stackName: 'STATE TEST',
        });
      }

      await new Promise((r) => setTimeout(r, 100));
      const managedList = dom.window.document.getElementById('managedList');
      const items = managedList.querySelectorAll('.window-item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Available windows rendering ─────────────────────────────────────────

  describe('Available windows rendering', () => {
    it('should render available windows', async () => {
      dom.window.electronAPI.getAvailableWindows.mockResolvedValue([
        { hwnd: 300, title: 'Available 1' },
        { hwnd: 400, title: 'Available 2' },
      ]);

      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      const availableList = dom.window.document.getElementById('availableList');
      const items = availableList.querySelectorAll('.window-item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('should show empty state when no available windows', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      const availableList = dom.window.document.getElementById('availableList');
      const emptyState = availableList.querySelector('.empty-state');
      expect(emptyState).not.toBeNull();
    });

    it('should call getAvailableWindows on init', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      expect(dom.window.electronAPI.getAvailableWindows).toHaveBeenCalled();
    });
  });

  // ─── Dimensions section ───────────────────────────────────────────────────

  describe('Dimensions section', () => {
    it('should toggle dimensions section visibility', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const dimsContent = dom.window.document.getElementById('dimsContent');
      const toggleBtn = dom.window.document.getElementById('toggleDimsBtn');

      // Initially hidden
      expect(dimsContent.classList.contains('hidden')).toBe(true);

      // Click to show
      toggleBtn.click();
      expect(dimsContent.classList.contains('hidden')).toBe(false);

      // Click to hide again
      toggleBtn.click();
      expect(dimsContent.classList.contains('hidden')).toBe(true);
    });

    it('should show dimension inputs when custom size toggle is checked', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const customSizeToggle = dom.window.document.getElementById('customSizeToggle');
      const dimsInputs = dom.window.document.getElementById('dimsInputs');

      // Initially hidden
      expect(dimsInputs.classList.contains('hidden')).toBe(true);

      // Check the toggle
      customSizeToggle.checked = true;
      customSizeToggle.dispatchEvent(new dom.window.Event('change'));

      expect(dimsInputs.classList.contains('hidden')).toBe(false);
    });
  });

  // ─── Sort alpha toggle ────────────────────────────────────────────────────

  describe('Sort alpha toggle', () => {
    it('should add active class to sort button when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const sortBtn = dom.window.document.getElementById('sortAlphaBtn');
      sortBtn.click();

      expect(sortBtn.classList.contains('active')).toBe(true);
    });

    it('should call toggleSortAvailableAlpha API when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const sortBtn = dom.window.document.getElementById('sortAlphaBtn');
      sortBtn.click();

      await new Promise((r) => setTimeout(r, 50));
      expect(dom.window.electronAPI.toggleSortAvailableAlpha).toHaveBeenCalledWith(true);
    });
  });

  // ─── Dynamic reorder toggle ───────────────────────────────────────────────

  describe('Dynamic reorder toggle', () => {
    it('should add active class to dynamic reorder button when toggled', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const dynBtn = dom.window.document.getElementById('dynamicReorderBtn');
      dynBtn.click();

      await new Promise((r) => setTimeout(r, 50));
      expect(dynBtn.classList.contains('active')).toBe(true);
    });
  });

  // ─── Available section visibility ─────────────────────────────────────────

  describe('Available section visibility', () => {
    it('should hide available list when toggle button clicked', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const toggleBtn = dom.window.document.getElementById('toggleAvailableBtn');
      const availableList = dom.window.document.getElementById('availableList');

      // Initially visible
      expect(availableList.classList.contains('hidden')).toBe(false);

      toggleBtn.click();
      expect(availableList.classList.contains('hidden')).toBe(true);
    });

    it('should show available list when toggle button clicked twice', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      const toggleBtn = dom.window.document.getElementById('toggleAvailableBtn');
      const availableList = dom.window.document.getElementById('availableList');

      toggleBtn.click(); // hide
      toggleBtn.click(); // show

      expect(availableList.classList.contains('hidden')).toBe(false);
    });
  });

  // ─── Init and API calls ───────────────────────────────────────────────────

  describe('Init and API calls', () => {
    it('should call getManagedWindows on init', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 200));

      expect(dom.window.electronAPI.getManagedWindows).toHaveBeenCalled();
    });

    it('should call removeAllStateListeners on init', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      expect(dom.window.electronAPI.removeAllStateListeners).toHaveBeenCalled();
    });

    it('should register onStateUpdate listener on init', async () => {
      const jsCode = fs.readFileSync(JS_PATH, 'utf-8');
      dom.window.eval(jsCode);
      await new Promise((r) => setTimeout(r, 150));

      expect(dom.window.electronAPI.onStateUpdate).toHaveBeenCalled();
    });
  });
});
