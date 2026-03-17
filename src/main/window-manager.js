'use strict';

const {
  api,
  koffi,
  EnumWindowsProc,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  HWND_TOP,
  HWND_NOTOPMOST,
  SW_RESTORE,
  GWL_EXSTYLE,
  WS_EX_TOOLWINDOW,
} = require('./win32');

const CONTROLLER_WIDTH = 300;
const HEADER_HEIGHT = 40;

class WindowManager {
  constructor(_options = {}) {
    // Array of managed windows: [{ hwnd, title, processId, originalRect }]
    // Windows maintain their order here.
    this.managedWindows = [];
    this.activeHwnd = 0; // Explicitly track active window rather than relying on index 0
    this.ownPid = process.pid;
    this.stackName = 'Managed Stack';
    this.hideAvailable = false;
    this.sortAvailableAlpha = false;
    this.backgroundColor = '#000000';
    this.stackGap = 0; // pixels of horizontal gap between controller and managed windows
    this.topOffset = 0; // pixels of vertical offset from top of work area
    this.customWidth = null; // null = use all available space (default behavior)
    this.customHeight = null; // null = use all available space (default behavior)
    this.lightMode = false;
    this.dynamicReorder = false;
  }

  setBackgroundColor(color) {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      this.backgroundColor = color;
    }
  }

  getBackgroundColor() {
    return this.backgroundColor;
  }

  /**
   * Read a window's title using GetWindowTextW with proper buffer handling.
   */
  _getWindowTitle(hwndNum) {
    try {
      const titleLen = api.GetWindowTextLengthW(hwndNum);
      if (titleLen <= 0) return '';
      const buf = [' '.repeat(titleLen + 1)];
      api.GetWindowTextW(hwndNum, buf, titleLen + 1);
      return (buf[0] || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Enumerate all visible, titled, non-tool windows on the system.
   * Excludes our own process and already-managed windows.
   * @param {Set<number>} [excludeHwnds=new Set()] - Optional set of HWNDs to exclude (e.g. windows managed by other instances)
   */
  getAvailableWindows(excludeHwnds = new Set()) {
    const windows = [];
    const managedHwnds = new Set(this.managedWindows.map((w) => w.hwnd));

    const callback = koffi.register((hwnd, _lParam) => {
      try {
        const hwndNum = Number(hwnd);

        if (!api.IsWindowVisible(hwndNum)) return 1;
        if (api.IsIconic(hwndNum)) return 1;

        const exStyle = Number(api.GetWindowLongPtrW(hwndNum, GWL_EXSTYLE));
        if (exStyle & WS_EX_TOOLWINDOW) return 1;

        const pidBuf = [0];
        api.GetWindowThreadProcessId(hwndNum, pidBuf);
        if (pidBuf[0] === this.ownPid) return 1;

        if (managedHwnds.has(hwndNum)) return 1;
        if (excludeHwnds.has(hwndNum)) return 1;

        const title = this._getWindowTitle(hwndNum);
        if (!title) return 1;

        const rect = {};
        api.GetWindowRect(hwndNum, rect);

        windows.push({
          hwnd: hwndNum,
          title: title,
          bounds: {
            left: rect.left || 0,
            top: rect.top || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0,
          },
        });
      } catch {
        // Skip windows that cause errors
      }
      return 1;
    }, koffi.pointer(EnumWindowsProc));

    try {
      try {
        api.EnumWindows(koffi.address(callback), 0);
      } catch (e) {
        console.error('EnumWindows failed:', e);
      }
      return windows;
    } finally {
      koffi.unregister(callback);
    }
  }

  /**
   * Add a window to the managed group.
   * This is the ONLY action that calls SetForegroundWindow,
   * because the user explicitly chose to add it.
   */
  addWindow(hwnd, title) {
    const hwndNum = Number(hwnd);

    if (this.managedWindows.some((w) => w.hwnd === hwndNum)) return;

    try {
      if (!api.IsWindow(hwndNum)) return;
    } catch {
      return;
    }

    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    try {
      const success = api.GetWindowRect(hwndNum, rect);
      if (!success) {
        console.warn('GetWindowRect failed for hwnd:', hwndNum);
      }
    } catch {
      // use defaults (rect stays zeroed)
    }

    const pidBuf = [0];
    try {
      api.GetWindowThreadProcessId(hwndNum, pidBuf);
    } catch {
      // pid stays 0
    }

    const entry = {
      hwnd: hwndNum,
      title: title || this._getWindowTitle(hwndNum) || 'Untitled',
      customTitle: null,
      processId: pidBuf[0],
      originalRect: {
        left: rect.left || 0,
        top: rect.top || 0,
        right: rect.right || 0,
        bottom: rect.bottom || 0,
      },
    };

    // Insert at front
    this.managedWindows.unshift(entry);

    // Set as the active window immediately
    this.activeHwnd = hwndNum;

    try {
      if (api.IsIconic(hwndNum)) {
        api.ShowWindow(hwndNum, SW_RESTORE);
      }
      // Only place we call SetForegroundWindow — user explicitly added this window
      api.SetForegroundWindow(hwndNum);
    } catch (e) {
      console.error('addWindow: failed to bring window to foreground:', e);
    }
  }

  /**
   * Remove a window from the managed group and animate it back to its original position.
   */
  removeWindow(hwnd) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex((w) => w.hwnd === hwndNum);
    if (idx === -1) return;

    const entry = this.managedWindows[idx];
    this.managedWindows.splice(idx, 1);

    // Unset the activeHwnd if it was removed
    if (this.activeHwnd === hwndNum) {
      this.activeHwnd = this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
    }

    // Animate the removed window back to its original position.
    // The callback is a no-op here; doLayout for remaining windows is triggered
    // by the caller (main.js) independently.
    this._animateRestore(entry, () => {});
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
    const idx = this.managedWindows.findIndex((w) => w.hwnd === hwndNum);
    if (idx === -1) return false;

    if (this.activeHwnd === hwndNum) {
      // Already active in our stack, but may be behind other windows.
      // If explicitly requested, bring to foreground anyway.
      if (forceNativeForeground) {
        try {
          if (api.IsIconic(hwndNum)) {
            api.ShowWindow(hwndNum, SW_RESTORE);
          }
          api.SetForegroundWindow(hwndNum);
        } catch (e) {
          console.error('promoteToActive: failed to foreground (already active):', e);
        }
      }
      return false;
    }

    this.activeHwnd = hwndNum;

    if (this.dynamicReorder) {
      const currentIdx = this.managedWindows.findIndex((w) => w.hwnd === hwndNum);
      if (currentIdx !== -1 && currentIdx !== this.managedWindows.length - 1) {
        const [entry] = this.managedWindows.splice(currentIdx, 1);
        this.managedWindows.push(entry);
      }
    }

    try {
      if (api.IsIconic(hwndNum)) {
        api.ShowWindow(hwndNum, SW_RESTORE);
      }
      if (forceNativeForeground) {
        api.SetForegroundWindow(hwndNum);
      }
    } catch (e) {
      console.error('promoteToActive: failed to foreground (new active):', e);
    }

    return true;
  }

  /**
   * Remove dead windows (where IsWindow returns false).
   */
  removeDeadWindows() {
    const before = this.managedWindows.length;
    let activeWindowStillAlive = false;

    this.managedWindows = this.managedWindows.filter((w) => {
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
   * Restore all managed windows to their original positions instantly (no animation).
   * Used during app quit — no time for animation, must be synchronous and immediate.
   */
  restoreAll() {
    for (const entry of this.managedWindows) {
      try {
        if (!api.IsWindow(entry.hwnd)) continue;
        this._restoreWindow(entry);
      } catch (e) {
        console.error('restoreAll: failed to restore hwnd ' + entry.hwnd + ':', e);
      }
    }
    this.managedWindows = [];
    this.activeHwnd = 0;
  }

  /**
   * Restore a single window to its originalRect position and invoke callback.
   * @param {{ hwnd: number, originalRect: {left,top,right,bottom} }} entry
   * @param {Function} callback - Called when restore completes
   */
  _animateRestore(entry, callback) {
    this._restoreWindow(entry);
    callback();
  }

  _applyLayout(targetLayouts) {
    if (targetLayouts.length === 0) return;

    try {
      const hWinPosInfo = api.BeginDeferWindowPos(targetLayouts.length);
      if (hWinPosInfo) {
        let hInfo = hWinPosInfo;
        for (const target of targetLayouts) {
          try {
            if (target.restore) {
              api.ShowWindow(target.hwnd, SW_RESTORE);
            }
            hInfo = api.DeferWindowPos(
              hInfo,
              target.hwnd,
              HWND_TOP,
              target.x,
              target.y,
              target.cx,
              target.cy,
              target.flags
            );
            if (!hInfo) break;
          } catch (e) {
            console.error('_applyLayout: DeferWindowPos failed for hwnd ' + target.hwnd + ':', e);
            break;
          }
        }
        if (hInfo) {
          try {
            api.EndDeferWindowPos(hInfo);
          } catch (e) {
            console.error('_applyLayout: EndDeferWindowPos failed:', e);
          }
        }
      } else {
        // Fallback: individual SetWindowPos
        for (const target of targetLayouts) {
          try {
            if (target.restore) api.ShowWindow(target.hwnd, SW_RESTORE);
            api.SetWindowPos(target.hwnd, HWND_TOP, target.x, target.y, target.cx, target.cy, target.flags);
          } catch (e) {
            console.error('_applyLayout: SetWindowPos failed for hwnd ' + target.hwnd + ':', e);
          }
        }
      }
    } catch (e) {
      console.error('_applyLayout: layout batch failed:', e);
    }
  }

  /**
   * Apply the spatial stack layout to all managed windows.
   *
   * Background windows: preview strips at the top, each HEADER_HEIGHT px
   * Active window (this.activeHwnd): fills remaining area below the strips
   *
   * All positioning is done via SetWindowPos — pure Win32.
   */
  layoutStack(screenBounds, skipHwnd = 0) {
    if (this.managedWindows.length === 0) return;

    const workArea = screenBounds || { x: 0, y: 0, width: 1920, height: 1040, displayRightEdge: null };
    // The starting X of the stack is the entire width of the controller window
    const startX = workArea.x + workArea.width + this.stackGap;

    // Use displayRightEdge passed from main.js (based on the display where the app lives).
    // Fallback to a safe default if not provided (backward compat).
    // eslint-disable-next-line eqeqeq -- intentional: != null catches both null and undefined (backward compat)
    const displayRightEdge = workArea.displayRightEdge != null ? workArea.displayRightEdge : startX + 1920; // fallback: assume 1920px wide display starting at startX
    const availableWidth = displayRightEdge - startX;
    if (availableWidth < 200) {
      console.warn('layoutStack: not enough space to the right of controller, skipping layout');
      return;
    }
    const startY = workArea.y + this.topOffset;
    const availableHeight = workArea.height - this.topOffset;

    // Apply custom dimensions (clamped to available space so we never exceed the monitor)
    const effectiveWidth = this.customWidth !== null ? Math.min(this.customWidth, availableWidth) : availableWidth;
    const effectiveHeight = this.customHeight !== null ? Math.min(this.customHeight, availableHeight) : availableHeight;

    // Determine the active window
    const activeIdx = this.managedWindows.findIndex((w) => w.hwnd === this.activeHwnd);
    const activeWindow = activeIdx !== -1 ? this.managedWindows[activeIdx] : this.managedWindows[0];
    const trueActiveHwnd = activeWindow ? activeWindow.hwnd : 0;

    const inactiveCount = this.managedWindows.length - (activeWindow ? 1 : 0);

    // Cap strip area to max 60% of effectiveHeight, reduce header height if needed
    const maxStripArea = Math.floor(effectiveHeight * 0.6);
    let effectiveHeaderHeight = HEADER_HEIGHT;
    if (inactiveCount * effectiveHeaderHeight > maxStripArea) {
      effectiveHeaderHeight = Math.max(Math.floor(maxStripArea / inactiveCount), 10); // min 10px per strip
    }

    const needsRestore = (hwnd) => {
      try {
        return api.IsIconic(hwnd) || api.IsZoomed(hwnd);
      } catch {
        return false;
      }
    };

    const targetLayouts = [];

    // Position background windows first (strips at top)
    let stripIndex = 0;
    for (const w of this.managedWindows) {
      if (w.hwnd === trueActiveHwnd) continue; // Skip the active window
      if (w.hwnd === skipHwnd) continue;

      const y = startY + stripIndex * effectiveHeaderHeight;

      targetLayouts.push({
        hwnd: w.hwnd,
        x: startX,
        y: y,
        cx: effectiveWidth,
        cy: effectiveHeight,
        flags: SWP_NOACTIVATE | SWP_SHOWWINDOW,
        restore: needsRestore(w.hwnd),
      });

      stripIndex++;
    }

    // Position active window on top, covering background window bodies
    if (activeWindow) {
      if (activeWindow.hwnd !== skipHwnd) {
        const activeY = startY + inactiveCount * effectiveHeaderHeight;
        const activeHeight = effectiveHeight - inactiveCount * effectiveHeaderHeight;

        targetLayouts.push({
          hwnd: activeWindow.hwnd,
          x: startX,
          y: activeY,
          cx: effectiveWidth,
          cy: activeHeight > 100 ? activeHeight : effectiveHeight,
          flags: SWP_SHOWWINDOW | SWP_NOACTIVATE,
          restore: needsRestore(activeWindow.hwnd),
        });
      }
    }

    this._applyLayout(targetLayouts);
  }

  _restoreWindow(entry) {
    try {
      const r = entry.originalRect;
      const w = r.right - r.left || 800;
      const h = r.bottom - r.top || 600;
      api.SetWindowPos(entry.hwnd, HWND_NOTOPMOST, r.left, r.top, w, h, SWP_SHOWWINDOW);
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
    return this.managedWindows.map((w) => w.hwnd);
  }

  /**
   * Get the current managed windows list (for UI display).
   */
  getManagedWindows() {
    return this.managedWindows.map((w) => ({
      hwnd: w.hwnd,
      title: w.title,
      customTitle: w.customTitle || null,
      processId: w.processId,
    }));
  }

  /**
   * Set a custom display name for a managed window.
   * Pass null or empty string to clear the custom name (revert to Win32 title).
   * @param {number} hwnd
   * @param {string|null} customTitle
   * @returns {boolean} true if the window was found and renamed
   */
  renameWindow(hwnd, customTitle) {
    const hwndNum = Number(hwnd);
    const entry = this.managedWindows.find((w) => w.hwnd === hwndNum);
    if (!entry) return false;
    entry.customTitle = (customTitle && customTitle.trim()) || null;
    return true;
  }

  /**
   * Set custom dimensions for managed windows.
   * Pass null for either dimension to use all available space (default behavior).
   * Values are clamped to a minimum of 200px.
   * @param {number|null} width
   * @param {number|null} height
   */
  setCustomDimensions(width, height) {
    const MAX_DIM = 10000;
    if (width !== null && width !== undefined) {
      this.customWidth = Math.max(200, Math.min(MAX_DIM, Math.round(width)));
    } else {
      this.customWidth = null;
    }
    if (height !== null && height !== undefined) {
      this.customHeight = Math.max(200, Math.min(MAX_DIM, Math.round(height)));
    } else {
      this.customHeight = null;
    }
  }

  /**
   * Set the horizontal gap between the controller panel and managed windows.
   * @param {number} gap - Gap in pixels (0 = no gap, clamped to 0-500)
   */
  setStackGap(gap) {
    this.stackGap = gap !== null && gap !== undefined ? Math.max(0, Math.min(500, Math.round(Number(gap)))) : 0;
  }

  /**
   * Get the current stack gap.
   * @returns {number}
   */
  getStackGap() {
    return this.stackGap;
  }

  /**
   * Set the vertical offset from the top of the work area.
   * @param {number} offset - Offset in pixels (0 = no offset, clamped to 0-500)
   */
  setTopOffset(offset) {
    this.topOffset =
      offset !== null && offset !== undefined ? Math.max(0, Math.min(500, Math.round(Number(offset)))) : 0;
  }

  /**
   * Get the current top offset.
   * @returns {number}
   */
  getTopOffset() {
    return this.topOffset;
  }

  setLightMode(enabled) {
    this.lightMode = !!enabled;
  }
  getLightMode() {
    return this.lightMode;
  }

  setDynamicReorder(enabled) {
    this.dynamicReorder = !!enabled;
  }
  getDynamicReorder() {
    return this.dynamicReorder;
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
      sortAvailableAlpha: this.sortAvailableAlpha,
      backgroundColor: this.backgroundColor,
      customWidth: this.customWidth,
      customHeight: this.customHeight,
      stackGap: this.stackGap,
      topOffset: this.topOffset,
      lightMode: this.lightMode,
      dynamicReorder: this.dynamicReorder,
      windows: this.managedWindows.map((w) => ({
        hwnd: w.hwnd,
        title: w.title,
        customTitle: w.customTitle || null,
        processId: w.processId,
        originalRect: w.originalRect,
      })),
    };
  }

  // loadState removed — each instance starts empty by design

  setStackName(name) {
    this.stackName = name || 'Managed Stack';
  }

  setHideAvailable(hide) {
    this.hideAvailable = !!hide;
  }

  setSortAvailableAlpha(enabled) {
    this.sortAvailableAlpha = !!enabled;
  }
  getSortAvailableAlpha() {
    return this.sortAvailableAlpha;
  }

  /**
   * Move a managed window from its current position to newIndex.
   * newIndex is clamped to [0, managedWindows.length - 1].
   * @param {number} hwnd - Window handle
   * @param {number} newIndex - Target index in managedWindows
   * @returns {boolean} true if the window was found and moved
   */
  reorderWindow(hwnd, newIndex) {
    const hwndNum = Number(hwnd);
    const currentIdx = this.managedWindows.findIndex((w) => w.hwnd === hwndNum);
    if (currentIdx === -1) return false;

    const clampedIndex = Math.max(0, Math.min(this.managedWindows.length - 1, Math.round(newIndex)));
    if (currentIdx === clampedIndex) return true; // Already in place, still counts as success

    const [entry] = this.managedWindows.splice(currentIdx, 1);
    this.managedWindows.splice(clampedIndex, 0, entry);
    return true;
  }
}

module.exports = { WindowManager, CONTROLLER_WIDTH, HEADER_HEIGHT };
