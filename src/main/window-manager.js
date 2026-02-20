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
    // Index 0 = active window (the one currently in foreground)
    this.managedWindows = [];
    this.ownPid = process.pid;
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

    // Insert at front (active position)
    this.managedWindows.unshift(entry);

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

    this._restoreWindow(entry);
  }

  /**
   * Promote a window to active (index 0) because the OS reported it gained focus.
   * Does NOT call SetForegroundWindow — the OS already did that.
   * This is called by the ForegroundMonitor when it detects a managed window got focus.
   * Returns true if the order actually changed.
   */
  promoteToActive(hwnd) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex(w => w.hwnd === hwndNum);
    if (idx === -1) return false;
    if (idx === 0) return false; // Already active

    const [entry] = this.managedWindows.splice(idx, 1);
    this.managedWindows.unshift(entry);

    if (api.IsIconic(hwndNum)) {
      api.ShowWindow(hwndNum, SW_RESTORE);
    }

    return true;
  }

  /**
   * Remove dead windows (where IsWindow returns false).
   */
  removeDeadWindows() {
    const before = this.managedWindows.length;
    this.managedWindows = this.managedWindows.filter(w => {
      try {
        return api.IsWindow(w.hwnd) !== 0;
      } catch {
        return false;
      }
    });
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
  }

  /**
   * Apply the spatial stack layout to all managed windows.
   *
   * Background windows (index 1..N): preview strips at the top, each HEADER_HEIGHT px
   * Active window (index 0): fills remaining area below the strips
   *
   * All positioning is done via SetWindowPos — pure Win32.
   */
  layoutStack(screenBounds) {
    if (this.managedWindows.length === 0) return;

    const workArea = screenBounds || { x: 0, y: 0, width: 1920, height: 1040 };
    const startX = workArea.x + CONTROLLER_WIDTH;
    const availableWidth = workArea.width - CONTROLLER_WIDTH;
    const availableHeight = workArea.height;

    const inactiveCount = this.managedWindows.length - 1;

    // Position background windows first (strips at top)
    for (let i = 1; i < this.managedWindows.length; i++) {
      const w = this.managedWindows[i];
      const k = i - 1;
      const y = workArea.y + k * HEADER_HEIGHT;

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
    }

    // Position active window on top, covering background window bodies
    const active = this.managedWindows[0];
    const activeY = workArea.y + inactiveCount * HEADER_HEIGHT;
    const activeHeight = availableHeight - (inactiveCount * HEADER_HEIGHT);

    try {
      if (api.IsIconic(active.hwnd)) {
        api.ShowWindow(active.hwnd, SW_RESTORE);
      }

      api.SetWindowPos(
        active.hwnd,
        HWND_TOP,
        startX,
        activeY,
        availableWidth,
        activeHeight > 100 ? activeHeight : availableHeight,
        SWP_SHOWWINDOW
      );
    } catch (e) {
      console.error(`Failed to position active window ${active.hwnd}:`, e);
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
    return this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
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
   * Get serializable state for persistence.
   */
  getState() {
    return this.managedWindows.map(w => ({
      hwnd: w.hwnd,
      title: w.title,
      processId: w.processId,
      originalRect: w.originalRect
    }));
  }

  /**
   * Load state from persistence. Tries to reconnect to existing windows.
   */
  loadState(savedWindows) {
    if (!Array.isArray(savedWindows)) return;

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
  }
}

module.exports = { WindowManager, CONTROLLER_WIDTH, HEADER_HEIGHT };
