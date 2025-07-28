import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";

// Load native addon - try different paths
let screenCapture: any;
const possiblePaths = [
  // Since preload.js is in dist-electron/, and screen_capture.node is in the same directory
  './screen_capture.node',
  __dirname + '/screen_capture.node',
];

for (const addonPath of possiblePaths) {
  try {
    ipcRenderer.send("preload-log", `Attempting to load addon from: ${addonPath}`);
    screenCapture = require(addonPath);
    ipcRenderer.send("preload-log", "✅ Native screen capture addon loaded successfully");
    
    // Test the addon
    const testResult = screenCapture.testMethod();
    ipcRenderer.send("preload-log", `✅ Native addon test: ${testResult}`);
    break; // Success, exit the loop
  } catch (error: any) {
    ipcRenderer.send("preload-log", `❌ Failed with path ${addonPath}: ${error.message}`);
  }
}

if (!screenCapture) {
  ipcRenderer.send("preload-log", "❌ Failed to load native addon from any path");
  console.error('Failed to load native screen capture addon');
}

ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
ipcRenderer.send("preload-log", `✅ Preload: Загружен для URL: ${window.location.href}`);
ipcRenderer.send("preload-log", `✅ Preload: ipcRenderer.send: ${typeof ipcRenderer.send}, ipcRenderer.invoke: ${typeof ipcRenderer.invoke}`);

// Регистрация обработчика toggle-walkie-talkie
ipcRenderer.send("preload-log", "✅ Preload: Регистрация обработчика toggle-walkie-talkie");
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
    ipcRenderer.send("preload-log", `Preload: Получено событие toggle-walkie-talkie: isMuted=${isMuted}`);
    bridgeEvents.emit("toggle-walkie-talkie", isMuted);
    ipcRenderer.send("preload-log", `Preload: Отправлено событие toggle-walkie-talkie в bridgeEvents: isMuted=${isMuted}`);
    const listenerCount = bridgeEvents.listenerCount("toggle-walkie-talkie");
    ipcRenderer.send("preload-log", `Preload: Количество слушателей toggle-walkie-talkie: ${listenerCount}`);
});

// Расширяем electron_bridge для обработки событий микрофона
contextBridge.exposeInMainWorld("electron_bridge", {
    ...electron_bridge,
    setMicHotkey: (enabled: boolean, hotkey: string) => {
        ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши микрофона: ${hotkey}`);
        ipcRenderer.send("walkie-talkie-status", { enabled: enabled, key: hotkey });
    },
    onMicStateChanged: (callback: (data: boolean) => void) => {
        ipcRenderer.send("preload-log", "Preload: Установка слушателя для toggle-walkie-talkie");
        bridgeEvents.on("toggle-walkie-talkie", callback);
        ipcRenderer.send("preload-log", `Preload: Зарегистрирован слушатель toggle-walkie-talkie, текущих слушателей: ${bridgeEvents.listenerCount("toggle-walkie-talkie")}`);
    }
});

// Expose screen capture API if addon loaded successfully
if (screenCapture) {
  contextBridge.exposeInMainWorld('screenCapture', {
    startCapture: async (options: {
      sourceId: string;
      width: number;
      height: number;
      frameRate: number;
    }) => {
      ipcRenderer.send("preload-log", `Starting capture with options: ${JSON.stringify(options)}`);
      try {
        const result = await screenCapture.startCapture(options);
        ipcRenderer.send("preload-log", `Capture started: ${result}`);
        return result;
      } catch (error: any) {
        ipcRenderer.send("preload-log", `Capture start error: ${error.message}`);
        throw error;
      }
    },
    
    stopCapture: async () => {
      ipcRenderer.send("preload-log", "Stopping capture");
      try {
        await screenCapture.stopCapture();
        ipcRenderer.send("preload-log", "Capture stopped successfully");
      } catch (error: any) {
        ipcRenderer.send("preload-log", `Capture stop error: ${error.message}`);
        throw error;
      }
    },
    
    getFrameStats: () => {
      try {
        const stats = screenCapture.getFrameStats();
        ipcRenderer.send("preload-log", `Frame stats: ${JSON.stringify(stats)}`);
        return stats;
      } catch (error: any) {
        ipcRenderer.send("preload-log", `Get frame stats error: ${error.message}`);
        return { videoFrames: 0, audioFrames: 0, isActive: false };
      }
    },
    
    testMethod: () => {
      try {
        return screenCapture.testMethod();
      } catch (error: any) {
        ipcRenderer.send("preload-log", `Test method error: ${error.message}`);
        return "Error calling test method";
      }
    }
  });
  
  ipcRenderer.send("preload-log", "✅ Screen capture API exposed to renderer");
} else {
  ipcRenderer.send("preload-log", "⚠️ Screen capture API not exposed - addon not loaded");
}

// Остальной код preload.ts остаётся без изменений
contextBridge.exposeInMainWorld("ipcRenderer", {
    invoke: async (channel: any, ...args: unknown[]) => {
        ipcRenderer.send("preload-log", `Zulip Preload: Запрос ${channel} с аргументами: ${JSON.stringify(args)}`);
        try {
            const result = await ipcRenderer.invoke(channel, ...args);
            ipcRenderer.send("preload-log", `Zulip Preload: Успех ${channel}: ${Array.isArray(result) ? result.map((s: any) => s.name || JSON.stringify(s)).join(', ') : JSON.stringify(result)}`);
            return result;
        } catch (error) {
            ipcRenderer.send("preload-log", `Zulip Preload: Ошибка ${channel}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    },
    on: (channel: any, listener: (event: any, ...args: any[]) => void) => {
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
    const sourcesNames = response.sources ? response.sources.map((s: any) => s.name).join(', ') : '[]';
    const errorMessage = response.error || 'none';
    ipcRenderer.send("preload-log", `✅ Preload: Получен ответ desktop-sources-response: sources=[${sourcesNames}], error=${errorMessage}`);
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