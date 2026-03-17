let availableWindows = [];
let managedWindows = [];
let activeHwnd = 0;

let isAvailableHidden = false;
let sortAvailableAlpha = false;
let dynamicReorderEnabled = false;
let customSizeEnabled = false;
let renameModeEnabled = false;
let dndMode = false;
let _isEditingName = false;

let _interactionGuard = false;
let _interactionGuardTimer = null;

let _undoTimer = null;
let _undoToastEl = null;

// Track the last known custom background color for restoring when light mode is off
let _lastBgColor = null;

function setInteractionGuard(durationMs = 1000) {
  _interactionGuard = true;
  if (_interactionGuardTimer) clearTimeout(_interactionGuardTimer);
  _interactionGuardTimer = setTimeout(() => {
    _interactionGuard = false;
    _interactionGuardTimer = null;
  }, durationMs);
}

function showUndoToast(hwnd, title) {
  // Remove any existing toast immediately
  if (_undoToastEl) {
    clearTimeout(_undoTimer);
    _undoToastEl.remove();
    _undoToastEl = null;
    _undoTimer = null;
  }

  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.innerHTML =
    'Removed <strong>' +
    title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
    '</strong> <button class="undo-btn" onclick="undoRemove(' +
    hwnd +
    ')">Undo</button>';
  document.body.appendChild(toast);
  _undoToastEl = toast;

  _undoTimer = setTimeout(() => {
    if (_undoToastEl === toast) {
      toast.classList.add('hiding');
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
        if (_undoToastEl === toast) _undoToastEl = null;
      }, 200);
    }
  }, 3000);
}

// eslint-disable-next-line no-unused-vars -- called from dynamically generated HTML onclick attributes
function undoRemove(hwnd) {
  clearTimeout(_undoTimer);
  _undoTimer = null;
  if (_undoToastEl) {
    _undoToastEl.remove();
    _undoToastEl = null;
  }
  addWindow(hwnd, '');
}

async function onBackgroundColorChange(color) {
  _lastBgColor = color;
  document.getElementById('colorPickerBtn').style.background = color;
  // Only apply inline bg color when light mode is OFF
  if (!document.body.classList.contains('light-mode')) {
    document.body.style.backgroundColor = color;
  }
  try {
    await window.electronAPI.setBackgroundColor(color);
  } catch (e) {
    console.error('Failed to set background color:', e);
  }
}

function openColorPicker() {
  if (window.electronAPI.setColorPickerLock) {
    window.electronAPI.setColorPickerLock(true);
  }
  document.getElementById('bgColorInput').click();
}

// === LIGHT MODE FUNCTIONS ===

function applyLightMode(enabled) {
  const btn = document.getElementById('lightModeBtn');
  if (enabled) {
    document.body.classList.add('light-mode');
    // Clear inline backgroundColor so CSS variable takes over
    document.body.style.backgroundColor = '';
    if (btn) {
      btn.classList.add('active');
      btn.innerHTML = '&#9790;'; // Moon symbol
      btn.title = 'Switch to dark mode';
    }
  } else {
    document.body.classList.remove('light-mode');
    // Restore last known custom background color
    if (_lastBgColor) {
      document.body.style.backgroundColor = _lastBgColor;
    }
    if (btn) {
      btn.classList.remove('active');
      btn.innerHTML = '&#9788;'; // Sun symbol
      btn.title = 'Switch to light mode';
    }
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
async function toggleLightMode() {
  const isCurrentlyLight = document.body.classList.contains('light-mode');
  const newState = !isCurrentlyLight;
  applyLightMode(newState);
  try {
    await window.electronAPI.setLightMode(newState);
  } catch (e) {
    console.error('Failed to set light mode:', e);
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
async function toggleDynamicReorder() {
  dynamicReorderEnabled = !dynamicReorderEnabled;
  const btn = document.getElementById('dynamicReorderBtn');
  if (dynamicReorderEnabled) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
  try {
    await window.electronAPI.toggleDynamicReorder(dynamicReorderEnabled);
  } catch (e) {
    console.error('Failed to toggle dynamic reorder:', e);
  }
}

function toggleRenameMode() {
  renameModeEnabled = !renameModeEnabled;
  const btn = document.getElementById('renameToggleBtn');
  if (renameModeEnabled) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
    // Safety: release focus lock when exiting rename mode
    _isEditingName = false;
    if (window.electronAPI.setRenameFocusLock) {
      window.electronAPI.setRenameFocusLock(false);
    }
  }
  // Re-render to apply/remove contentEditable
  scheduleRenderManaged();
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
function toggleDndMode() {
  dndMode = !dndMode;
  const btn = document.getElementById('dndBtn');
  if (dndMode) {
    document.body.classList.add('dnd-mode');
    btn.classList.add('active');
    // If rename mode is active, deactivate it
    if (renameModeEnabled) {
      toggleRenameMode();
    }
  } else {
    document.body.classList.remove('dnd-mode');
    btn.classList.remove('active');
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
function toggleDimensionsSection() {
  const content = document.getElementById('dimsContent');
  const btn = document.getElementById('toggleDimsBtn');
  if (content.classList.contains('hidden')) {
    content.classList.remove('hidden');
    btn.textContent = 'Hide';
  } else {
    content.classList.add('hidden');
    btn.textContent = 'Show';
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onchange attribute (index.html)
function onCustomSizeToggle() {
  const toggle = document.getElementById('customSizeToggle');
  const inputs = document.getElementById('dimsInputs');
  const buttons = document.getElementById('dimsButtons');
  customSizeEnabled = toggle.checked;
  if (customSizeEnabled) {
    inputs.classList.remove('hidden');
    buttons.classList.remove('hidden');
  } else {
    inputs.classList.add('hidden');
    buttons.classList.add('hidden');
    // Reset when unchecking
    resetCustomDimensions();
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
async function applyCustomDimensions() {
  const w = parseInt(document.getElementById('customWidthInput').value);
  const h = parseInt(document.getElementById('customHeightInput').value);
  const gap = parseInt(document.getElementById('stackGapInput').value);
  const top = parseInt(document.getElementById('topOffsetInput').value);
  try {
    // Apply width/height only if both are valid
    if (w >= 200 && h >= 200) {
      await window.electronAPI.setCustomDimensions(w, h);
    }
    // Apply gap independently
    if (!isNaN(gap) && gap >= 0) {
      await window.electronAPI.setStackGap(gap);
    }
    // Apply top independently
    if (!isNaN(top) && top >= 0) {
      await window.electronAPI.setTopOffset(top);
    }
  } catch (e) {
    console.error('Failed to apply dimensions:', e);
  }
}

async function resetCustomDimensions() {
  try {
    await window.electronAPI.setCustomDimensions(null, null);
    await window.electronAPI.setStackGap(0);
    await window.electronAPI.setTopOffset(0);
    document.getElementById('customWidthInput').value = '';
    document.getElementById('customHeightInput').value = '';
    document.getElementById('stackGapInput').value = '';
    document.getElementById('topOffsetInput').value = '';
    document.getElementById('customSizeToggle').checked = false;
    document.getElementById('dimsInputs').classList.add('hidden');
    document.getElementById('dimsButtons').classList.add('hidden');
    customSizeEnabled = false;
  } catch (e) {
    console.error('Failed to reset dimensions:', e);
  }
}

// Title editing logic
const stackTitle = document.getElementById('stackTitle');
const managedSubtitle = document.getElementById('managedSubtitle');

stackTitle.addEventListener('blur', () => {
  setTimeout(() => {
    if (!document.hasFocus()) {
      // Window lost OS focus (e.g. SetForegroundWindow stole it) — re-focus
      stackTitle.focus();
      return;
    }
    _isEditingName = false;
    if (window.electronAPI.setRenameFocusLock) {
      window.electronAPI.setRenameFocusLock(false);
    }
    saveStackTitle();
  }, 50);
});

stackTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stackTitle.blur();
  }
});

stackTitle.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain').substring(0, 100);
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    // Move cursor to end of inserted text
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

stackTitle.addEventListener('focus', () => {
  _isEditingName = true;
  if (window.electronAPI.setRenameFocusLock) {
    window.electronAPI.setRenameFocusLock(true);
  }
});

async function saveStackTitle() {
  const newName = stackTitle.textContent.trim() || 'Managed Stack';
  stackTitle.textContent = newName.toUpperCase();
  if (managedSubtitle) managedSubtitle.textContent = newName.toUpperCase();
  try {
    if (window.electronAPI.updateStackName) {
      await window.electronAPI.updateStackName(newName);
    }
  } catch (e) {
    console.error('Failed to save stack name', e);
  }
}

// Toggle Visibility Logic
async function toggleAvailableVisibility(forceState = null) {
  const listEl = document.getElementById('availableList');
  const btn = document.getElementById('toggleAvailableBtn');

  if (forceState !== null) {
    isAvailableHidden = forceState;
  } else {
    isAvailableHidden = !isAvailableHidden;
  }

  const sectionContainer = listEl.closest('.section');

  if (isAvailableHidden) {
    listEl.classList.add('hidden');
    btn.textContent = 'Show';
    if (sectionContainer) sectionContainer.style.flex = 'none';
  } else {
    listEl.classList.remove('hidden');
    btn.textContent = 'Hide';
    if (sectionContainer) sectionContainer.style.flex = '1';
  }

  try {
    if (window.electronAPI.toggleAvailableVisibility && forceState === null) {
      await window.electronAPI.toggleAvailableVisibility(isAvailableHidden);
    }
  } catch (e) {
    console.error('Failed to toggle visibility', e);
  }
}

// eslint-disable-next-line no-unused-vars -- called from HTML onclick attribute (index.html)
async function toggleSortAlpha() {
  sortAvailableAlpha = !sortAvailableAlpha;
  const btn = document.getElementById('sortAlphaBtn');
  if (sortAvailableAlpha) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
  renderAvailable();
  try {
    await window.electronAPI.toggleSortAvailableAlpha(sortAvailableAlpha);
  } catch (e) {
    console.error('Failed to toggle sort:', e);
  }
}

let _renderManagedPending = false;

function scheduleRenderManaged() {
  if (_renderManagedPending) return;
  _renderManagedPending = true;
  requestAnimationFrame(() => {
    _renderManagedPending = false;
    renderManaged();
  });
}

/**
 * Render the managed stack — READ-ONLY status display.
 * No Activate buttons. The active window is determined by Win32 focus.
 * Uses DOM-diffing to reuse existing elements and enable CSS transitions.
 */
function renderManaged() {
  const container = document.getElementById('managedList');
  const countEl = document.getElementById('managedCount');
  countEl.textContent = managedWindows.length;

  if (managedWindows.length === 0) {
    container.innerHTML = '<div class="empty-state">No windows in stack.<br>Add windows from below.</div>';
    return;
  }

  // Build a map of existing DOM items keyed by hwnd
  const existingItems = new Map();
  container.querySelectorAll('.window-item[data-hwnd]').forEach((el) => {
    existingItems.set(Number(el.dataset.hwnd), el);
  });

  // Build the set of desired hwnds
  const desiredHwnds = new Set(managedWindows.map((w) => w.hwnd));

  // Remove DOM elements whose hwnd is no longer in managedWindows
  existingItems.forEach((el, hwnd) => {
    if (!desiredHwnds.has(hwnd)) {
      el.remove();
      existingItems.delete(hwnd);
    }
  });

  // If the container only had an empty-state element, clear it now
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  // For each window in managedWindows: update or create, then reorder
  managedWindows.forEach((win, index) => {
    const isActive = win.hwnd === activeHwnd;
    let item = existingItems.get(win.hwnd);

    if (item) {
      // UPDATE existing element in place
      item.className = 'window-item managed-item ' + (isActive ? 'active' : 'inactive');

      // Update click handler (rebind with current isActive closure)
      item.onclick = async () => {
        await activateWindow(win.hwnd);
      };

      // Update title text
      const titleEl = item.querySelector('.managed-title');
      if (titleEl) {
        const displayEl = titleEl.querySelector('.display-name');
        const origEl = titleEl.querySelector('.original-title');
        const displayText = win.customTitle || win.title || 'Untitled';
        // Only update if not currently being edited
        if (displayEl && !_isEditingName && document.activeElement !== displayEl) {
          displayEl.textContent = displayText;
        }
        if (displayEl) {
          if (!_isEditingName && document.activeElement !== displayEl) {
            displayEl.contentEditable = renameModeEnabled ? 'true' : 'false';
          }
          // Keep data attributes in sync so Escape handler reads current values
          displayEl.dataset.currentCustomTitle = win.customTitle || '';
          displayEl.dataset.currentTitle = win.title || 'Untitled';
        }
        if (origEl) {
          origEl.textContent = '';
          origEl.style.display = 'none';
        }
      }

      // Remove badge if present (no longer displayed)
      const badge = titleEl ? titleEl.querySelector('.active-badge, .strip-badge') : null;
      if (badge) badge.remove();
    } else {
      // CREATE new element with 'entering' class for fade-in animation
      item = document.createElement('div');
      item.className = 'window-item managed-item entering ' + (isActive ? 'active' : 'inactive');
      item.dataset.hwnd = win.hwnd;

      item.onclick = async () => {
        await activateWindow(win.hwnd);
      };

      // Remove 'entering' class after animation completes
      item.addEventListener('animationend', (e) => {
        if (e.animationName === 'fadeSlideIn') {
          item.classList.remove('entering');
        }
      });

      const title = document.createElement('div');
      title.className = 'managed-title';

      const displayName = document.createElement('span');
      displayName.className = 'display-name';
      displayName.contentEditable = renameModeEnabled ? 'true' : 'false';
      displayName.spellcheck = false;
      displayName.textContent = win.customTitle || win.title || 'Untitled';
      // Store current title values as data attributes to avoid stale closure bugs
      displayName.dataset.currentCustomTitle = win.customTitle || '';
      displayName.dataset.currentTitle = win.title || 'Untitled';

      // Focus sets the editing lock
      displayName.addEventListener('focus', () => {
        _isEditingName = true;
        if (window.electronAPI.setRenameFocusLock) {
          window.electronAPI.setRenameFocusLock(true);
        }
      });

      // Double-click selects all text for easy replacement
      displayName.addEventListener('dblclick', (e) => {
        if (!renameModeEnabled) return;
        e.stopPropagation();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(displayName);
        selection.removeAllRanges();
        selection.addRange(range);
      });

      // Blur saves the rename
      displayName.addEventListener('blur', () => {
        if (!renameModeEnabled) return;
        // If the whole window lost focus (e.g. SetForegroundWindow stole it),
        // don't save — the user didn't intentionally leave the field.
        // Use a microtask to let the browser settle the new activeElement.
        setTimeout(() => {
          if (!document.hasFocus()) {
            // Window lost focus — re-focus the field so user can continue editing
            displayName.focus();
            return;
          }
          const newName = displayName.textContent.trim();
          renameWindowTitle(win.hwnd, newName || null);
          _isEditingName = false;
          if (window.electronAPI.setRenameFocusLock) {
            window.electronAPI.setRenameFocusLock(false);
          }
        }, 50);
      });

      // Enter confirms (blur triggers save)
      displayName.addEventListener('keydown', (e) => {
        if (!renameModeEnabled) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          displayName.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          // Read from data attributes instead of stale closure to get current title
          const ct = displayName.dataset.currentCustomTitle;
          const t = displayName.dataset.currentTitle;
          displayName.textContent = ct || t || 'Untitled';
          displayName.blur();
        }
      });

      displayName.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain').substring(0, 200);
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          // Move cursor to end of inserted text
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });

      // Only prevent click propagation (window activation) when rename mode is on
      displayName.addEventListener('click', (e) => {
        if (renameModeEnabled) {
          e.stopPropagation();
        }
      });

      title.appendChild(displayName);

      const origTitle = document.createElement('span');
      origTitle.className = 'original-title';
      origTitle.style.display = 'none';
      title.appendChild(origTitle);

      const actions = document.createElement('div');
      actions.className = 'actions';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-red';
      removeBtn.textContent = '-';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        // If a displayName is focused, blur it without saving
        const focused = item.querySelector('.display-name:focus');
        if (focused) {
          // Temporarily disable rename mode to prevent blur from saving
          const wasEnabled = renameModeEnabled;
          renameModeEnabled = false;
          focused.blur();
          renameModeEnabled = wasEnabled;
        }
        removeWindow(win.hwnd);
      };
      actions.appendChild(removeBtn);

      item.appendChild(title);
      item.appendChild(actions);

      existingItems.set(win.hwnd, item);
    }

    // Reorder: ensure item is at the correct position
    const currentAtIndex = container.children[index];
    if (currentAtIndex !== item) {
      container.insertBefore(item, currentAtIndex || null);
    }
  });
}

/**
 * Render available windows — Add buttons only.
 */
function renderAvailable() {
  const container = document.getElementById('availableList');

  if (availableWindows.length === 0) {
    container.innerHTML = '<div class="empty-state">No available windows.<br>Click Refresh to scan.</div>';
    return;
  }

  // Build map of existing DOM items keyed by hwnd
  const existingItems = new Map();
  container.querySelectorAll('.window-item[data-hwnd]').forEach((el) => {
    existingItems.set(Number(el.dataset.hwnd), el);
  });

  // Build set of desired hwnds
  const desiredHwnds = new Set(availableWindows.map((w) => w.hwnd));

  // Remove DOM elements whose hwnd is no longer available
  existingItems.forEach((el, hwnd) => {
    if (!desiredHwnds.has(hwnd)) {
      el.remove();
      existingItems.delete(hwnd);
    }
  });

  // Clear empty-state if present
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // For each available window: update existing or create new
  const windowsToRender = sortAvailableAlpha
    ? [...availableWindows].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
      )
    : availableWindows;
  windowsToRender.forEach((win, index) => {
    let item = existingItems.get(win.hwnd);

    if (item) {
      // UPDATE existing — just update title text and rebind onclick
      const titleEl = item.querySelector('.title');
      if (titleEl) titleEl.textContent = win.title || 'Untitled';
      const addBtn = item.querySelector('.btn-add');
      if (addBtn) {
        addBtn.onclick = (e) => {
          e.stopPropagation();
          addWindow(win.hwnd, win.title);
        };
      }
    } else {
      // CREATE new element
      item = document.createElement('div');
      item.className = 'window-item';
      item.dataset.hwnd = win.hwnd;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = win.title || 'Untitled';

      const actions = document.createElement('div');
      actions.className = 'actions';

      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-green';
      addBtn.textContent = '+';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        addWindow(win.hwnd, win.title);
      };
      actions.appendChild(addBtn);

      item.appendChild(title);
      item.appendChild(actions);
      existingItems.set(win.hwnd, item);
    }

    // Reorder: ensure item is at correct position
    const currentAtIndex = container.children[index];
    if (currentAtIndex !== item) {
      container.insertBefore(item, currentAtIndex || null);
    }
  });
}

// API calls — activation is primarily Win32-driven, with UI fallback via activateWindow().
async function refreshAvailable() {
  try {
    availableWindows = await window.electronAPI.getAvailableWindows();
    renderAvailable();
  } catch (e) {
    console.error('Failed to refresh:', e);
  }
}

async function refreshManaged() {
  try {
    const result = await window.electronAPI.getManagedWindows();
    managedWindows = result.windows || [];
    activeHwnd = result.activeHwnd || 0;

    if (result.stackName) {
      const upperName = result.stackName.toUpperCase();
      if (stackTitle && !_isEditingName && document.activeElement !== stackTitle) {
        stackTitle.textContent = upperName;
      }
      if (managedSubtitle) managedSubtitle.textContent = upperName;
    }

    if (result.hideAvailable !== undefined && result.hideAvailable !== isAvailableHidden) {
      toggleAvailableVisibility(result.hideAvailable);
    }

    if (result.sortAvailableAlpha !== undefined) {
      sortAvailableAlpha = !!result.sortAvailableAlpha;
      const sortBtn = document.getElementById('sortAlphaBtn');
      if (sortBtn) {
        if (sortAvailableAlpha) sortBtn.classList.add('active');
        else sortBtn.classList.remove('active');
      }
    }

    if (result.dynamicReorder !== undefined) {
      dynamicReorderEnabled = !!result.dynamicReorder;
      const dynBtn = document.getElementById('dynamicReorderBtn');
      if (dynBtn) {
        if (dynamicReorderEnabled) dynBtn.classList.add('active');
        else dynBtn.classList.remove('active');
      }
    }

    if (result.customWidth !== undefined || result.customHeight !== undefined) {
      const toggle = document.getElementById('customSizeToggle');
      const inputs = document.getElementById('dimsInputs');
      const buttons = document.getElementById('dimsButtons');
      const widthInput = document.getElementById('customWidthInput');
      const heightInput = document.getElementById('customHeightInput');

      if (result.customWidth !== null && result.customHeight !== null) {
        customSizeEnabled = true;
        toggle.checked = true;
        inputs.classList.remove('hidden');
        buttons.classList.remove('hidden');
        widthInput.value = result.customWidth;
        heightInput.value = result.customHeight;
      }
    }

    if (result.stackGap !== undefined) {
      document.getElementById('stackGapInput').value = result.stackGap || '';
    }

    if (result.topOffset !== undefined && result.topOffset > 0) {
      document.getElementById('topOffsetInput').value = result.topOffset;
    }

    if (result.backgroundColor) {
      _lastBgColor = result.backgroundColor;
      document.getElementById('colorPickerBtn').style.background = result.backgroundColor;
      document.getElementById('bgColorInput').value = result.backgroundColor;
      if (!document.body.classList.contains('light-mode')) {
        document.body.style.backgroundColor = result.backgroundColor;
      }
    }

    // Sync light mode from initial state
    if (result.lightMode !== undefined) {
      applyLightMode(result.lightMode);
    }

    scheduleRenderManaged();
  } catch (e) {
    console.error('Failed to refresh managed:', e);
  }
}

async function addWindow(hwnd, title) {
  try {
    setInteractionGuard();
    await window.electronAPI.addWindow(hwnd, title);
    await refreshAvailable();
  } catch (e) {
    console.error('Failed to add:', e);
  }
}

async function removeWindow(hwnd) {
  try {
    setInteractionGuard();
    const entry = managedWindows.find((w) => w.hwnd === hwnd);
    const title = entry ? entry.customTitle || entry.title || 'Untitled' : 'Untitled';

    await window.electronAPI.removeWindow(hwnd);
    await refreshAvailable();
    showUndoToast(hwnd, title);
  } catch (e) {
    console.error('Failed to remove:', e);
  }
}

async function activateWindow(hwnd) {
  try {
    await window.electronAPI.activateWindow(hwnd);
  } catch (e) {
    console.error('Failed to activate:', e);
  }
}

async function renameWindowTitle(hwnd, newTitle) {
  try {
    // Optimistic local update to prevent flicker before next state-update arrives
    const entry = managedWindows.find((w) => w.hwnd === hwnd);
    if (entry) {
      entry.customTitle = newTitle || null;
    }
    await window.electronAPI.renameWindow(hwnd, newTitle);
  } catch (e) {
    console.error('Failed to rename:', e);
  }
}

// Initial load
async function init() {
  if (!window.electronAPI) {
    console.error('electronAPI bridge not available');
    document.getElementById('managedList').innerHTML =
      '<div class="empty-state">Error: API bridge failed to load.<br>Please restart the app.</div>';
    return;
  }
  // Clear any stale listeners from a previous page load, THEN register fresh
  window.electronAPI.removeAllStateListeners();

  // Listen for real-time state updates from the foreground monitor
  window.electronAPI.onStateUpdate((data) => {
    if (data.managed) {
      managedWindows = data.managed;
      activeHwnd = data.activeHwnd || 0;

      // Update Title if changed externally
      if (data.stackName) {
        const upperName = data.stackName.toUpperCase();
        if (
          stackTitle &&
          stackTitle.textContent !== upperName &&
          !_isEditingName &&
          document.activeElement !== stackTitle
        ) {
          stackTitle.textContent = upperName;
        }
        if (managedSubtitle && managedSubtitle.textContent !== upperName) {
          managedSubtitle.textContent = upperName;
        }
      }

      // Ensure visibility state is correct on load
      if (data.hideAvailable !== undefined && data.hideAvailable !== isAvailableHidden) {
        toggleAvailableVisibility(data.hideAvailable);
      }

      if (data.sortAvailableAlpha !== undefined) {
        sortAvailableAlpha = !!data.sortAvailableAlpha;
        const sortBtn = document.getElementById('sortAlphaBtn');
        if (sortBtn) {
          if (sortAvailableAlpha) sortBtn.classList.add('active');
          else sortBtn.classList.remove('active');
        }
        renderAvailable();
      }

      if (data.dynamicReorder !== undefined) {
        dynamicReorderEnabled = !!data.dynamicReorder;
        const dynBtn = document.getElementById('dynamicReorderBtn');
        if (dynBtn) {
          if (dynamicReorderEnabled) dynBtn.classList.add('active');
          else dynBtn.classList.remove('active');
        }
      }

      // Sync custom dimensions from state
      if (data.customWidth !== undefined || data.customHeight !== undefined) {
        const toggle = document.getElementById('customSizeToggle');
        const inputs = document.getElementById('dimsInputs');
        const buttons = document.getElementById('dimsButtons');
        const widthInput = document.getElementById('customWidthInput');
        const heightInput = document.getElementById('customHeightInput');

        // eslint-disable-next-line eqeqeq -- intentional: != null catches both null and undefined
        if (data.customWidth != null || data.customHeight != null) {
          toggle.checked = true;
          inputs.classList.remove('hidden');
          buttons.classList.remove('hidden');
          // eslint-disable-next-line eqeqeq -- intentional: != null catches both null and undefined
          if (data.customWidth != null && document.activeElement !== widthInput) widthInput.value = data.customWidth;
          // eslint-disable-next-line eqeqeq -- intentional: != null catches both null and undefined
          if (data.customHeight != null && document.activeElement !== heightInput)
            heightInput.value = data.customHeight;
          customSizeEnabled = true;
        } else {
          // both null — disable
          toggle.checked = false;
          inputs.classList.add('hidden');
          buttons.classList.add('hidden');
          widthInput.value = '';
          heightInput.value = '';
          customSizeEnabled = false;
        }
      }

      // Sync stack gap from state
      if (data.stackGap !== undefined) {
        const gapInput = document.getElementById('stackGapInput');
        if (gapInput && document.activeElement !== gapInput) {
          gapInput.value = data.stackGap || '';
        }
      }

      // Sync topOffset
      const topInput = document.getElementById('topOffsetInput');
      if (topInput && document.activeElement !== topInput) {
        topInput.value = data.topOffset || '';
      }

      if (data.backgroundColor) {
        _lastBgColor = data.backgroundColor;
        document.getElementById('colorPickerBtn').style.background = data.backgroundColor;
        document.getElementById('bgColorInput').value = data.backgroundColor;
        if (!document.body.classList.contains('light-mode')) {
          document.body.style.backgroundColor = data.backgroundColor;
        }
      }

      // Sync light mode from state update
      if (data.lightMode !== undefined) {
        applyLightMode(data.lightMode);
      }

      scheduleRenderManaged();
    }
  });

  // Color picker button: lock before opening native dialog
  document.getElementById('colorPickerBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openColorPicker();
  });

  // Unlock when the color input changes (user picked a color and confirmed)
  document.getElementById('bgColorInput').addEventListener('change', function (_e) {
    onBackgroundColorChange(this.value);
    // Small delay to let the dialog fully close before unlocking
    setTimeout(() => {
      if (window.electronAPI.setColorPickerLock) {
        window.electronAPI.setColorPickerLock(false);
      }
    }, 300);
  });

  await Promise.all([refreshManaged(), refreshAvailable()]);

  // Auto-refresh available windows every 5 seconds
  setInterval(() => {
    if (!isAvailableHidden && !_interactionGuard) {
      refreshAvailable();
    }
  }, 5000);

  // Refresh available windows immediately when the Electron window gains focus
  window.addEventListener('focus', () => {
    // Always unlock color picker when window regains focus (covers Cancel case)
    if (window.electronAPI.setColorPickerLock) {
      window.electronAPI.setColorPickerLock(false);
    }
    if (_interactionGuard) return;
    refreshAvailable();
  });
}

init();
