# Stack Windows Electron 🗂️

A high-performance Spatial Window Organizer for Windows, built with Electron and native Win32 APIs.

## Overview

Stack Windows Electron is a utility that allows you to group different open applications (e.g., Chrome, VSCode, File Explorer) into a managed "spatial stack". 

Within this stack:
- **Inactive windows** shrink down to show only a small 40px header strip.
- The **active window** automatically expands to occupy the rest of the available space.
- The entire stack's layout and dimensions are highly customizable and persistent across sessions.

## Features

- **Spatial Window Stacking:** Automatically stacks non-active windows into low-profile strips and promotes the focused window to top-level view.
- **Ultra-Low Latency Tracking:** Relies on a highly optimized polling loop (`GetForegroundWindow`) instead of heavy, unstable global Windows hooks.
- **True Native Integration:** Directly talks to Windows internal APIs (`user32.dll` functions like `SetWindowPos`, `EnumWindows`, `GetWindowRect`) using [Koffi](https://koffi.dev/) for blazingly fast Foreign Function Interoperating (FFI).
- **Multi-Monitor Support:** Intelligently detects the display where the control panel is located to apply the layout precisely on that screen.
- **Highly Customizable:** Change stack dimensions and the application's background color on the fly, saving state locally via a persistence layer.

## Architecture

- **`src/main/win32.js` (FFI Interop):** The native bridge. Loads `user32.dll` via Koffi and exposes crucial OS-level window management APIs.
- **`src/main/window-manager.js` (Core Logic):** The spatial engine. Calculates the layout, deciding exactly where each window goes dynamically based on screen real estate and the current active process. 
- **`src/main/foreground-monitor.js`:** The polling engine. Checks for window focus changes rapidly (every 200ms) to trigger a layout reshuffle as soon as the user Alt+Tabs or clicks another managed app.
- **`src/main/persistence.js`:** Responsible for saving and restoring the workspace between application boots.
- **`src/renderer/index.html`:** A rapid, vanilla HTML/CSS/JS frontend that provides a sleek control interface to add/remove windows to the stack and tweak preferences.

## Getting Started

### Prerequisites
- **Windows OS:** (This app uses `user32.dll` exclusively and will not work on macOS/Linux).
- Node.js (v18+)

### Installation

1. Clone the repository:
   ```bash
   git clone <your-repo-url>
   cd StackWindowsElectron
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

## 🛠️ Development

This project uses `beads (bd)` for issue tracking. 
Check `AGENTS.md` for specific rules regarding how work sessions are managed, how the automated agents interact, and how to synchronize state to GitHub.

## 📄 License

MIT License
