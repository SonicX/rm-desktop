import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";

ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
ipcRenderer.send("preload-log", `✅ Preload: ipcRenderer.send: ${typeof ipcRenderer.send}, ipcRenderer.invoke: ${typeof ipcRenderer.invoke}`);

// Расширяем electron_bridge для обработки событий микрофона и WalkieTalkie
contextBridge.exposeInMainWorld("electron_bridge", {
  ...electron_bridge,
  setMicHotkey: (hotkey: string) => {
    ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши микрофона: ${hotkey}`);
    ipcRenderer.send("set-mic-hotkey", hotkey);
  },
  onMicStateChanged: (callback: (data: { isMuted: boolean }) => void) => {
    ipcRenderer.send("preload-log", "Preload: Установка слушателя для mic-state-changed");
    bridgeEvents.on("mic-state-changed", callback);
  },
  onWalkieTalkieStatus: (callback: (data: { enabled: boolean; key: string }) => void) => {
    ipcRenderer.send("preload-log", "Preload: Установка слушателя для walkie-talkie-status");
    bridgeEvents.on("walkie-talkie-status", callback);
  },
  toggleWalkieTalkie: (value: boolean) => {
    ipcRenderer.send("preload-log", `Preload: Отправка команды toggle-walkie-talkie: ${value}`);
    electron_bridge.send_event("toggle-walkie-talkie", value);
  }
});

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
  if (channel === "toggle-walkie-talkie") {
    electron_bridge.send_event("toggle-walkie-talkie", true); // или значение из аргументов, если передаётся
  }
});

ipcRenderer.on("desktop-sources-response", (event, response) => {
  ipcRenderer.send("preload-log", `✅ Preload: Получен ответ desktop-sources-response:`, response.sources ? response.sources.map(s => s.name) : [], response.error);
  electron_bridge.send_event("desktop-sources-response", response);
});

ipcRenderer.on("mic-state-changed", (event, data: { isMuted: boolean }) => {
  ipcRenderer.send("preload-log", `Preload: Получено событие mic-state-changed: isMuted=${data.isMuted}`);
  bridgeEvents.emit("mic-state-changed", data);
});

ipcRenderer.on("walkie-talkie-status", (event, data: { enabled: boolean; key: string }) => {
  ipcRenderer.send("preload-log", `Preload: Получено событие walkie-talkie-status: enabled=${data.enabled}, key=${data.key}`);
  bridgeEvents.emit("walkie-talkie-status", data);
});

window.addEventListener("load", () => {
  if (!location.href.includes("app/renderer/network.html")) {
    return;
  }
  const $reconnectButton = document.querySelector("#reconnect")!;
  const $settingsButton = document.querySelector("#settings")!;
  NetworkError.init($reconnectButton, $settingsButton);
});