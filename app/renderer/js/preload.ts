import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";

ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
ipcRenderer.send("preload-log", `✅ Preload: ipcRenderer.send: ${typeof ipcRenderer.send}, ipcRenderer.invoke: ${typeof ipcRenderer.invoke}`);

contextBridge.exposeInMainWorld("electron_bridge", electron_bridge);

// contextBridge.exposeInMainWorld("ipcRenderer", {
//     invoke: async (channel: string, ...args: unknown[]) => {
//         console.log(`Zulip Preload: Запрос ${channel} с аргументами:`, args);
//         try {
//             const result = await ipcRenderer.invoke(channel, ...args);
//             console.log(`Zulip Preload: Успех ${channel}:`, Array.isArray(result) ? result.map(s => s.name) : result);
//             return result;
//         } catch (error) {
//             console.error(`Zulip Preload: Ошибка ${channel}:`, error);
//             throw error;
//         }
//     }
// });

contextBridge.exposeInMainWorld("ipcRenderer", {
  invoke: async (channel: string, ...args: unknown[]) => {
      ipcRenderer.send("preload-log", `Zulip Preload: Запрос ${channel} с аргументами: ${JSON.stringify(args)}`);
      try {
          const result = await ipcRenderer.invoke(channel, ...args);
          ipcRenderer.send("preload-log", `Zulip Preload: Успех ${channel}: ${Array.isArray(result) ? result.map(s => s.name).join(', ') : JSON.stringify(result)}`);
          return result;
      } catch (error) {
          ipcRenderer.send("preload-log", `Zulip Preload: Ошибка ${channel}: ${error.message}`);
          throw error;
      }
  },
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
      ipcRenderer.send("preload-log", `Zulip Preload: Установка слушателя для канала ${channel}`);
      ipcRenderer.on(channel, listener);
  }
});

ipcRenderer.on("logout", () => {
    bridgeEvents.emit("logout");
});

ipcRenderer.on("show-keyboard-shortcuts", () => {
    bridgeEvents.emit("show-keyboard-shortcuts");
});

ipcRenderer.on("show-notification-settings", () => {
    bridgeEvents.emit("show-notification-settings");
});

ipcRenderer.on("trigger-open-desktop-picker", () => {
    ipcRenderer.send("preload-log", "✅ Preload: Получена команда trigger-open-desktop-picker (direct)");
    electron_bridge.send_event("open-desktop-picker");
});

ipcRenderer.on("requestDesktopSources", () => {
    ipcRenderer.send("preload-log", "✅ Preload: Получена команда requestDesktopSources (direct)");
    electron_bridge.send_event("requestDesktopSources");
});

ipcRenderer.on("forward-message", (event, channel) => {
    ipcRenderer.send("preload-log", `✅ Preload: Получено forward-message с каналом: ${channel}`);
    if (channel === "trigger-open-desktop-picker") {
        electron_bridge.send_event("open-desktop-picker");
    }
    if (channel === "request-desktop-sources") {
        electron_bridge.send_event("requestDesktopSources");
    }
});

ipcRenderer.on("desktop-sources-response", (event, response) => {
    ipcRenderer.send("preload-log", `✅ Preload: Получен ответ desktop-sources-response:`, response.sources ? response.sources.map(s => s.name) : [], response.error);
    electron_bridge.send_event("desktop-sources-response", response);
});

window.addEventListener("load", () => {
    if (!location.href.includes("app/renderer/network.html")) {
        return;
    }
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
});