'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Get list of available (non-managed) windows
  getAvailableWindows: () => ipcRenderer.invoke('get-available-windows'),

  // Get list of currently managed windows + active hwnd
  getManagedWindows: () => ipcRenderer.invoke('get-managed-windows'),

  // Add a window to the managed group
  addWindow: (hwnd, title) => ipcRenderer.invoke('add-window', hwnd, title),

  // Remove a window from the managed group
  removeWindow: (hwnd) => ipcRenderer.invoke('remove-window', hwnd),

  // Activate an already managed window
  activateWindow: (hwnd) => ipcRenderer.invoke('activate-window', hwnd),

  // Refresh available windows list
  refresh: () => ipcRenderer.invoke('refresh'),

  // Config toggles
  updateStackName: (name) => ipcRenderer.invoke('update-stack-name', name),
  toggleAvailableVisibility: (isHidden) => ipcRenderer.invoke('toggle-available-visibility', isHidden),
  resizeApp: (width, height) => ipcRenderer.invoke('resize-app', width, height),

  // Custom window dimensions
  setCustomDimensions: (width, height) => ipcRenderer.invoke('set-custom-dimensions', width, height),
  getCustomDimensions: () => ipcRenderer.invoke('get-custom-dimensions'),

  // Background color
  setBackgroundColor: (color) => ipcRenderer.invoke('set-background-color', color),
  getBackgroundColor: () => ipcRenderer.invoke('get-background-color'),

  // Listen for state updates pushed from main process (foreground monitor events)
  onStateUpdate: (callback) => {
    ipcRenderer.on('state-update', (event, data) => callback(data));
  }
});
