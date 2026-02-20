'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { WindowManager, CONTROLLER_WIDTH } = require('./window-manager');
const { Persistence } = require('./persistence');
const { ForegroundMonitor } = require('./foreground-monitor');

let mainWindow = null;
let windowManager = null;
let persistence = null;
let foregroundMonitor = null;
let cleanupTimer = null;
let saveTimer = null;

function getWorkArea() {
  const primaryDisplay = screen.getPrimaryDisplay();
  return primaryDisplay.workArea;
}

function createWindow() {
  const workArea = getWorkArea();

  mainWindow = new BrowserWindow({
    width: CONTROLLER_WIDTH,
    height: Math.floor(workArea.height * 0.9),
    x: workArea.x,
    y: workArea.y,
    resizable: true,
    minWidth: 250,
    minHeight: 200,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    frame: true,
    title: 'Stack Windows',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    doLayout();
    if (saveTimer) {
      persistence.save(windowManager.getState());
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendStateUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-update', {
      managed: windowManager.getManagedWindows(),
      activeHwnd: windowManager.getActiveHwnd(),
      stackName: windowManager.stackName,
      hideAvailable: windowManager.hideAvailable
    });
  }
}

function doLayout() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const workArea = getWorkArea();

  windowManager.layoutStack({
    x: bounds.x,
    y: workArea.y,
    width: bounds.width,
    height: workArea.height
  });
}

function syncMonitor() {
  if (foregroundMonitor) {
    foregroundMonitor.updateManagedSet(windowManager.getManagedHwnds());
  }
}

/**
 * Called by ForegroundMonitor when a managed window gains OS focus.
 * This is the ONLY activation path — driven by real Win32 focus, not Electron UI.
 */
function onManagedWindowFocused(hwnd) {
  const changed = windowManager.promoteToActive(hwnd);
  if (changed) {
    doLayout();
    sendStateUpdate();
    persistence.save(windowManager.getState());
  }
}

// Register IPC handlers — NO activate-window handler.
// Activation is driven by Win32 focus detection, not Electron.
function registerIPC() {
  ipcMain.handle('get-available-windows', async () => {
    try {
      return windowManager.getAvailableWindows();
    } catch (e) {
      console.error('get-available-windows error:', e);
      return [];
    }
  });

  ipcMain.handle('get-managed-windows', async () => {
    try {
      return {
        windows: windowManager.getManagedWindows(),
        activeHwnd: windowManager.getActiveHwnd()
      };
    } catch (e) {
      console.error('get-managed-windows error:', e);
      return { windows: [], activeHwnd: 0 };
    }
  });

  ipcMain.handle('add-window', async (event, hwnd, title) => {
    try {
      windowManager.addWindow(hwnd, title);
      syncMonitor();
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('add-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('remove-window', async (event, hwnd) => {
    try {
      windowManager.removeWindow(hwnd);
      syncMonitor();
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('remove-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('activate-window', async (event, hwnd) => {
    try {
      const changed = windowManager.promoteToActive(hwnd, true);
      if (changed) {
        syncMonitor();
        doLayout();
        sendStateUpdate();
        persistence.save(windowManager.getState());
      }
      return { success: true };
    } catch (e) {
      console.error('activate-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('refresh', async () => {
    try {
      return windowManager.getAvailableWindows();
    } catch (e) {
      console.error('refresh error:', e);
      return [];
    }
    ipcMain.handle('update-stack-name', async (event, name) => {
      windowManager.setStackName(name);
      persistence.save(windowManager.getState());
      return { success: true };
    });

    ipcMain.handle('toggle-available-visibility', async (event, isHidden) => {
      windowManager.setHideAvailable(isHidden);
      persistence.save(windowManager.getState());
      return { success: true };
    });

    ipcMain.handle('resize-app', async (event, width, height) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const currentBounds = mainWindow.getBounds();
        mainWindow.setBounds({
          x: currentBounds.x,
          y: currentBounds.y,
          width: width || currentBounds.width,
          height: height || currentBounds.height
        });
      }
      return { success: true };
    });
  });
}

app.whenReady().then(() => {
  // Initialize persistence
  persistence = new Persistence();
  persistence.init();

  // Initialize window manager
  windowManager = new WindowManager();

  // Load saved state and try to reconnect to windows
  const savedState = persistence.load();
  if (savedState) {
    console.log('Restoring saved window group configuration...');
    windowManager.loadState(savedState);

    if (savedState.bounds && savedState.bounds.width && savedState.bounds.height) {
      mainWindow.setBounds(savedState.bounds);
    }

    if (windowManager.managedWindows.length > 0) {
      console.log(`Reconnected to ${windowManager.managedWindows.length} windows`);
    } else {
      console.log('No saved windows could be reconnected');
    }
  }

  // Initialize foreground monitor — detects when user clicks/focuses a managed window
  foregroundMonitor = new ForegroundMonitor();
  foregroundMonitor.start(onManagedWindowFocused);
  syncMonitor();

  // Register IPC handlers
  registerIPC();

  // Create the controller window
  createWindow();

  // Apply layout after a short delay
  setTimeout(() => {
    if (windowManager.managedWindows.length > 0) {
      doLayout();
    }
  }, 500);

  // Cleanup timer: remove dead windows every 2 seconds
  cleanupTimer = setInterval(() => {
    const changed = windowManager.removeDeadWindows();
    if (changed) {
      syncMonitor();
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
    }
  }, 2000);

  // Auto-save timer: save state every 10 seconds
  saveTimer = setInterval(() => {
    if (windowManager.managedWindows.length > 0) {
      persistence.save(windowManager.getState());
    }
  }, 10000);
});

app.on('window-all-closed', () => {
  if (foregroundMonitor) foregroundMonitor.stop();
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (saveTimer) clearInterval(saveTimer);

  if (windowManager) {
    persistence.save(windowManager.getState());
    windowManager.restoreAll();
  }

  app.quit();
});

app.on('before-quit', () => {
  if (foregroundMonitor) foregroundMonitor.stop();

  if (windowManager) {
    persistence.save(windowManager.getState());
    windowManager.restoreAll();
  }
});
