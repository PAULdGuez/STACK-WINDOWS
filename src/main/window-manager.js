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
    this.backgroundColor = '#000000';
    this.customWidth = null;  // null = use all available space (default behavior)
    this.customHeight = null; // null = use all available space (default behavior)
    this._animationInterval = null;
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

  _stopAnimation() {
    if (this._animationInterval) {
      clearInterval(this._animationInterval);
      this._animationInterval = null;
    }
  }

  _animateLayout(targetLayouts) {
    this._stopAnimation();

    if (targetLayouts.length === 0) return;

    // Collect current positions
    const layouts = targetLayouts.map(target => {
      let rect = { left: target.x, top: target.y, right: target.x + target.cx, bottom: target.y + target.cy };
      try {
        if (target.restore) {
          api.ShowWindow(target.hwnd, SW_RESTORE);
        }
        api.GetWindowRect(target.hwnd, rect);
      } catch (e) {
        // fallback to target
      }
      return {
        hwnd: target.hwnd,
        startX: rect.left,
        startY: rect.top,
        startCx: rect.right - rect.left,
        startCy: rect.bottom - rect.top,
        targetX: target.x,
        targetY: target.y,
        targetCx: target.cx,
        targetCy: target.cy,
        flags: target.flags
      };
    });

    const DURATION = 200; // ms
    const FPS = 60;
    const TOTAL_FRAMES = Math.floor(DURATION / (1000 / FPS));
    let currentFrame = 0;

    this._animationInterval = setInterval(() => {
      currentFrame++;
      const progress = currentFrame / TOTAL_FRAMES;
      // Use an ease-out timing function
      const ease = 1 - Math.pow(1 - progress, 3);

      try {
        const hWinPosInfo = api.BeginDeferWindowPos(layouts.length);
        if (!hWinPosInfo) {
          // Fallback if BeginDeferWindowPos fails for some reason
          for (const layout of layouts) {
            api.SetWindowPos(layout.hwnd, HWND_TOP, layout.targetX, layout.targetY, layout.targetCx, layout.targetCy, layout.flags);
          }
          this._stopAnimation();
          return;
        }

        let currentHWinPosInfo = hWinPosInfo;

        for (const layout of layouts) {
          const x = Math.round(layout.startX + (layout.targetX - layout.startX) * ease);
          const y = Math.round(layout.startY + (layout.targetY - layout.startY) * ease);
          const cx = Math.round(layout.startCx + (layout.targetCx - layout.startCx) * ease);
          const cy = Math.round(layout.startCy + (layout.targetCy - layout.startCy) * ease);

          currentHWinPosInfo = api.DeferWindowPos(
            currentHWinPosInfo,
            layout.hwnd,
            HWND_TOP,
            x,
            y,
            cx,
            cy,
            layout.flags
          );

          if (!currentHWinPosInfo) break;
        }

        if (currentHWinPosInfo) {
          api.EndDeferWindowPos(currentHWinPosInfo);
        }

        if (currentFrame >= TOTAL_FRAMES) {
          this._stopAnimation();
          // Final snap to target
          const finalHWinPosInfo = api.BeginDeferWindowPos(layouts.length);
          if (finalHWinPosInfo) {
            let hInfo = finalHWinPosInfo;
            for (const layout of layouts) {
              hInfo = api.DeferWindowPos(hInfo, layout.hwnd, HWND_TOP, layout.targetX, layout.targetY, layout.targetCx, layout.targetCy, layout.flags);
              if (!hInfo) break;
            }
            if (hInfo) api.EndDeferWindowPos(hInfo);
          }
        }
      } catch (e) {
        console.error('Animation frame failed:', e);
        this._stopAnimation();
        // Attempt immediate final snap without animation if it failed
        for (const layout of layouts) {
          try {
            api.SetWindowPos(layout.hwnd, HWND_TOP, layout.targetX, layout.targetY, layout.targetCx, layout.targetCy, layout.flags);
          } catch (er) { }
        }
      }
    }, 1000 / FPS);
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

    // Apply custom dimensions (clamped to available space so we never exceed the monitor)
    const effectiveWidth = this.customWidth !== null
      ? Math.min(this.customWidth, availableWidth)
      : availableWidth;
    const effectiveHeight = this.customHeight !== null
      ? Math.min(this.customHeight, availableHeight)
      : availableHeight;

    // Determine the active window
    const activeIdx = this.managedWindows.findIndex(w => w.hwnd === this.activeHwnd);
    const activeWindow = activeIdx !== -1 ? this.managedWindows[activeIdx] : this.managedWindows[0];
    const trueActiveHwnd = activeWindow ? activeWindow.hwnd : 0;

    const inactiveCount = this.managedWindows.length - (activeWindow ? 1 : 0);

    const targetLayouts = [];

    // Position background windows first (strips at top)
    let stripIndex = 0;
    for (const w of this.managedWindows) {
      if (w.hwnd === trueActiveHwnd) continue; // Skip the active window

      const y = workArea.y + stripIndex * HEADER_HEIGHT;

      targetLayouts.push({
        hwnd: w.hwnd,
        x: startX,
        y: y,
        cx: effectiveWidth,
        cy: effectiveHeight,
        flags: SWP_NOACTIVATE | SWP_SHOWWINDOW,
        restore: api.IsIconic(w.hwnd) || api.IsZoomed(w.hwnd)
      });

      stripIndex++;
    }

    // Position active window on top, covering background window bodies
    if (activeWindow) {
      const activeY = workArea.y + inactiveCount * HEADER_HEIGHT;
      const activeHeight = effectiveHeight - (inactiveCount * HEADER_HEIGHT);

      targetLayouts.push({
        hwnd: activeWindow.hwnd,
        x: startX,
        y: activeY,
        cx: effectiveWidth,
        cy: activeHeight > 100 ? activeHeight : effectiveHeight,
        flags: SWP_SHOWWINDOW | SWP_NOACTIVATE,
        restore: api.IsIconic(activeWindow.hwnd) || api.IsZoomed(activeWindow.hwnd)
      });
    }

    this._animateLayout(targetLayouts);
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
      backgroundColor: this.backgroundColor,
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
    if (savedState.backgroundColor) this.backgroundColor = savedState.backgroundColor;

    // Restore custom dimensions if present, applying the same minimum clamp of 200
    if (savedState.customWidth !== null && savedState.customWidth !== undefined) {
      this.customWidth = Math.max(200, Number(savedState.customWidth));
    } else {
      this.customWidth = null;
    }
    if (savedState.customHeight !== null && savedState.customHeight !== undefined) {
      this.customHeight = Math.max(200, Number(savedState.customHeight));
    } else {
      this.customHeight = null;
    }

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
