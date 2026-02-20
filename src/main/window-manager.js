'use strict';

const win32 = require('./win32');
const { api, koffi, EnumWindowsProc, RECT,
  SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_NOMOVE, SWP_NOSIZE,
  HWND_TOP, HWND_NOTOPMOST,
  SW_RESTORE,
  GWL_EXSTYLE, WS_EX_TOOLWINDOW } = win32;

const CONTROLLER_WIDTH = 300;
const HEADER_HEIGHT = 40;

class WindowManager {
  constructor() {
    // Array of managed windows: [{ hwnd, title, processId, originalRect }]
    // Windows maintain their order here.
    this.managedWindows = [];
    this.activeHwnd = 0; // Explicitly track active window rather than relying on index 0
    this.ownPid = process.pid;
    this.stackName = 'Managed Stack';
    this.hideAvailable = false;
    this.customWidth = null;  // null = use all available space (default behavior)
    this.customHeight = null; // null = use all available space (default behavior)
  }

  /**
   * Read a window's title using GetWindowTextW with proper buffer handling.
   */
  _getWindowTitle(hwndNum) {
    const titleLen = api.GetWindowTextLengthW(hwndNum);
    if (titleLen <= 0) return '';
    const buf = [' '.repeat(titleLen + 1)];
    api.GetWindowTextW(hwndNum, buf, titleLen + 1);
    return (buf[0] || '').trim();
  }

  /**
   * Enumerate all visible, titled, non-tool windows on the system.
   * Excludes our own process and already-managed windows.
   */
  getAvailableWindows() {
    const windows = [];
    const managedHwnds = new Set(this.managedWindows.map(w => w.hwnd));

    const callback = koffi.register((hwnd, lParam) => {
      try {
        const hwndNum = Number(hwnd);

        if (!api.IsWindowVisible(hwndNum)) return true;
        if (api.IsIconic(hwndNum)) return true;

        const exStyle = Number(api.GetWindowLongPtrW(hwndNum, GWL_EXSTYLE));
        if (exStyle & WS_EX_TOOLWINDOW) return true;

        const pidBuf = [0];
        api.GetWindowThreadProcessId(hwndNum, pidBuf);
        if (pidBuf[0] === this.ownPid) return true;

        if (managedHwnds.has(hwndNum)) return true;

        const title = this._getWindowTitle(hwndNum);
        if (!title) return true;

        const rect = {};
        api.GetWindowRect(hwndNum, rect);

        windows.push({
          hwnd: hwndNum,
          title: title,
          bounds: {
            left: rect.left || 0,
            top: rect.top || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0
          }
        });
      } catch (e) {
        // Skip windows that cause errors
      }
      return true;
    }, koffi.pointer(EnumWindowsProc));

    try {
      api.EnumWindows(koffi.address(callback), 0);
    } catch (e) {
      console.error('EnumWindows failed:', e);
    }

    koffi.unregister(callback);
    return windows;
  }

  /**
   * Add a window to the managed group.
   * This is the ONLY action that calls SetForegroundWindow,
   * because the user explicitly chose to add it.
   */
  addWindow(hwnd, title) {
    const hwndNum = Number(hwnd);

    if (this.managedWindows.some(w => w.hwnd === hwndNum)) return;

    const rect = {};
    api.GetWindowRect(hwndNum, rect);

    const pidBuf = [0];
    api.GetWindowThreadProcessId(hwndNum, pidBuf);

    const entry = {
      hwnd: hwndNum,
      title: title || this._getWindowTitle(hwndNum) || 'Untitled',
      processId: pidBuf[0],
      originalRect: {
        left: rect.left || 0,
        top: rect.top || 0,
        right: rect.right || 0,
        bottom: rect.bottom || 0
      }
    };

    // Insert at front
    this.managedWindows.unshift(entry);

    // Set as the active window immediately
    this.activeHwnd = hwndNum;

    if (api.IsIconic(hwndNum)) {
      api.ShowWindow(hwndNum, SW_RESTORE);
    }

    // Only place we call SetForegroundWindow — user explicitly added this window
    api.SetForegroundWindow(hwndNum);
  }

  /**
   * Remove a window from the managed group and restore its original position.
   */
  removeWindow(hwnd) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex(w => w.hwnd === hwndNum);
    if (idx === -1) return;

    const entry = this.managedWindows[idx];
    this.managedWindows.splice(idx, 1);

    // Unset the activeHwnd if it was removed
    if (this.activeHwnd === hwndNum) {
      this.activeHwnd = this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
    }

    this._restoreWindow(entry);
  }

  /**
   * Promote a window to active because the OS reported it gained focus.
   * Does NOT modify order.
   * @param {number} hwnd - Window HANDLE
   * @param {boolean} forceNativeForeground - If true, forcefully bring to front
   * Returns true if the active window actually changed.
   */
  promoteToActive(hwnd, forceNativeForeground = false) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex(w => w.hwnd === hwndNum);
    if (idx === -1) return false;

    if (this.activeHwnd === hwndNum) return false; // Already active

    this.activeHwnd = hwndNum;

    if (api.IsIconic(hwndNum)) {
      api.ShowWindow(hwndNum, SW_RESTORE);
    }

    if (forceNativeForeground) {
      api.SetForegroundWindow(hwndNum);
    }

    return true;
  }

  /**
   * Remove dead windows (where IsWindow returns false).
   */
  removeDeadWindows() {
    const before = this.managedWindows.length;
    let activeWindowStillAlive = false;

    this.managedWindows = this.managedWindows.filter(w => {
      try {
        const alive = api.IsWindow(w.hwnd) !== 0;
        if (alive && w.hwnd === this.activeHwnd) {
          activeWindowStillAlive = true;
        }
        return alive;
      } catch {
        return false;
      }
    });

    if (!activeWindowStillAlive) {
      this.activeHwnd = this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
    }

    return this.managedWindows.length !== before;
  }

  /**
   * Restore all managed windows to their original positions.
   */
  restoreAll() {
    for (const entry of this.managedWindows) {
      this._restoreWindow(entry);
    }
    this.managedWindows = [];
    this.activeHwnd = 0;
  }

  /**
   * Apply the spatial stack layout to all managed windows.
   *
   * Background windows: preview strips at the top, each HEADER_HEIGHT px
   * Active window (this.activeHwnd): fills remaining area below the strips
   *
   * All positioning is done via SetWindowPos — pure Win32.
   */
  layoutStack(screenBounds) {
    if (this.managedWindows.length === 0) return;

    const workArea = screenBounds || { x: 0, y: 0, width: 1920, height: 1040 };
    // The starting X of the stack is the entire width of the controller window
    const startX = workArea.x + workArea.width;

    // Use displayRightEdge passed from main.js (based on the display where the app lives).
    // Fallback to a safe default if not provided (backward compat).
    const displayRightEdge = screenBounds.displayRightEdge != null
      ? screenBounds.displayRightEdge
      : startX + 1920; // fallback: assume 1920px wide display starting at startX
    const availableWidth = displayRightEdge - startX;
    const availableHeight = workArea.height;

    // Determine the active window
    const activeIdx = this.managedWindows.findIndex(w => w.hwnd === this.activeHwnd);
    const activeWindow = activeIdx !== -1 ? this.managedWindows[activeIdx] : this.managedWindows[0];
    const trueActiveHwnd = activeWindow ? activeWindow.hwnd : 0;

    const inactiveCount = this.managedWindows.length - (activeWindow ? 1 : 0);

    // Position background windows first (strips at top)
    let stripIndex = 0;
    for (const w of this.managedWindows) {
      if (w.hwnd === trueActiveHwnd) continue; // Skip the active window

      const y = workArea.y + stripIndex * HEADER_HEIGHT;

      try {
        if (api.IsIconic(w.hwnd)) {
          api.ShowWindow(w.hwnd, SW_RESTORE);
        }

        // Full-size window positioned so only its top HEADER_HEIGHT strip is visible
        api.SetWindowPos(
          w.hwnd,
          HWND_TOP,
          startX,
          y,
          availableWidth,
          availableHeight,
          SWP_NOACTIVATE | SWP_SHOWWINDOW
        );
      } catch (e) {
        console.error(`Failed to position background window ${w.hwnd}:`, e);
      }

      stripIndex++;
    }

    // Position active window on top, covering background window bodies
    if (activeWindow) {
      const activeY = workArea.y + inactiveCount * HEADER_HEIGHT;
      const activeHeight = availableHeight - (inactiveCount * HEADER_HEIGHT);

      try {
        if (api.IsIconic(activeWindow.hwnd)) {
          api.ShowWindow(activeWindow.hwnd, SW_RESTORE);
        }

        api.SetWindowPos(
          activeWindow.hwnd,
          HWND_TOP,
          startX,
          activeY,
          availableWidth,
          activeHeight > 100 ? activeHeight : availableHeight,
          SWP_SHOWWINDOW | SWP_NOACTIVATE
        );
      } catch (e) {
        console.error(`Failed to position active window ${activeWindow.hwnd}:`, e);
      }
    }
  }

  _restoreWindow(entry) {
    try {
      const r = entry.originalRect;
      const w = (r.right - r.left) || 800;
      const h = (r.bottom - r.top) || 600;
      api.SetWindowPos(
        entry.hwnd,
        HWND_NOTOPMOST,
        r.left, r.top, w, h,
        SWP_SHOWWINDOW
      );
    } catch (e) {
      console.error(`Failed to restore window ${entry.hwnd}:`, e);
    }
  }

  /**
   * Get the HWND of the currently active (index 0) window, or 0 if none.
   */
  getActiveHwnd() {
    return this.activeHwnd;
  }

  /**
   * Get array of all managed HWNDs (for the foreground monitor).
   */
  getManagedHwnds() {
    return this.managedWindows.map(w => w.hwnd);
  }

  /**
   * Get the current managed windows list (for UI display).
   */
  getManagedWindows() {
    return this.managedWindows.map(w => ({
      hwnd: w.hwnd,
      title: w.title,
      processId: w.processId
    }));
  }

  /**
   * Set custom dimensions for managed windows.
   * Pass null for either dimension to use all available space (default behavior).
   * Values are clamped to a minimum of 200px.
   * @param {number|null} width
   * @param {number|null} height
   */
  setCustomDimensions(width, height) {
    this.customWidth = width !== null && width !== undefined
      ? Math.max(200, Number(width))
      : null;
    this.customHeight = height !== null && height !== undefined
      ? Math.max(200, Number(height))
      : null;
  }

  /**
   * Get the current custom dimensions.
   * @returns {{ customWidth: number|null, customHeight: number|null }}
   */
  getCustomDimensions() {
    return { customWidth: this.customWidth, customHeight: this.customHeight };
  }

  /**
   * Get serializable state for persistence (version 2 compatible shape in main).
   */
  getState() {
    return {
      stackName: this.stackName,
      hideAvailable: this.hideAvailable,
      customWidth: this.customWidth,
      customHeight: this.customHeight,
      windows: this.managedWindows.map(w => ({
        hwnd: w.hwnd,
        title: w.title,
        processId: w.processId,
        originalRect: w.originalRect
      }))
    };
  }

  /**
   * Load state from persistence. Tries to reconnect to existing windows.
   */
  loadState(savedState) {
    if (!savedState) return;

    // Support either direct array (version 1) or config object (version 2)
    const savedWindows = Array.isArray(savedState) ? savedState : (savedState.windows || []);

    if (savedState.stackName) this.stackName = savedState.stackName;
    if (savedState.hideAvailable !== undefined) this.hideAvailable = savedState.hideAvailable;

    for (const saved of savedWindows) {
      try {
        const hwndNum = Number(saved.hwnd);

        if (!api.IsWindow(hwndNum)) {
          console.log(`Window ${saved.title} (${hwndNum}) no longer exists, skipping`);
          continue;
        }

        if (!api.IsWindowVisible(hwndNum)) {
          api.ShowWindow(hwndNum, SW_RESTORE);
          if (!api.IsWindowVisible(hwndNum)) {
            console.log(`Window ${saved.title} (${hwndNum}) not visible, skipping`);
            continue;
          }
        }

        const title = this._getWindowTitle(hwndNum) || saved.title;

        this.managedWindows.push({
          hwnd: hwndNum,
          title: title,
          processId: saved.processId || 0,
          originalRect: saved.originalRect || { left: 100, top: 100, right: 900, bottom: 700 }
        });
      } catch (e) {
        console.error(`Failed to restore window ${saved.title}:`, e);
      }
    }

    // Attempt to select the topmost window as active if available to prevent no active windows.
    if (this.managedWindows.length > 0) {
      this.activeHwnd = this.managedWindows[0].hwnd;
    }
  }

  setStackName(name) {
    this.stackName = name || 'Managed Stack';
  }

  setHideAvailable(hide) {
    this.hideAvailable = !!hide;
  }
}

module.exports = { WindowManager, CONTROLLER_WIDTH, HEADER_HEIGHT };
