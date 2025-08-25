// Create a new file: app/renderer/main-preload.ts
// This preload script runs in the main renderer context (not webview)

import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC to main renderer window
contextBridge.exposeInMainWorld('mainIpcRenderer', {
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, listener: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (event, ...args) => listener(...args));
  }
});

console.log('✅ Main renderer preload loaded');