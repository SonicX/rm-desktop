// Create a new file: app/renderer/main-preload.ts
// This preload script runs in the main renderer context (not webview)
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import {contextBridge, ipcRenderer} from "electron/renderer"; // eslint-disable-line no-restricted-imports

// Expose IPC to main renderer window
contextBridge.exposeInMainWorld("mainIpcRenderer", {
  invoke: async (channel: string, ...arguments_: any[]) =>
    ipcRenderer.invoke(channel, ...arguments_),
  send(channel: string, ...arguments_: any[]) {
    ipcRenderer.send(channel, ...arguments_);
  },
  on(channel: string, listener: (...arguments_: any[]) => void) {
    ipcRenderer.on(channel, (event, ...arguments_) => {
      listener(...arguments_);
    });
  },
});

console.log("✅ Main renderer preload loaded");
