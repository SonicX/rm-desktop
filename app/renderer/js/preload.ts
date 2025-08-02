import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";

ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
ipcRenderer.send("preload-log", `✅ Preload: Загружен для URL: ${window.location.href}`);

// === ОСНОВНОЕ: Обработчик запроса источников ===
// ЭТО КРИТИЧНО! Без этого диалог будет пустой
electron_bridge.on_event("requestDesktopSources", async () => {
    ipcRenderer.send("preload-log", "🎯 [PRELOAD_DEBUG] requestDesktopSources event received! КРИТИЧНО!");
    
    try {
        // Запрашиваем источники через IPC
        const sources = await ipcRenderer.invoke('get-desktop-sources');
        ipcRenderer.send("preload-log", `🎯 [PRELOAD_DEBUG] Got ${sources.length} sources from main process via invoke`);
        
        if (sources && sources.length > 0) {
            // Логируем источники
            sources.forEach((source: any, i: number) => {
                ipcRenderer.send("preload-log", `🎯 Preload: Source ${i}: ${source.name} (${source.id})`);
            });
            
            // Подготавливаем объект ответа
            const responseToSend = {
                sources: sources,
                error: null
            };

            // КРИТИЧНО: Отправляем ответ через electron_bridge
            // Это нужно для других частей системы, которые могут слушать electron_bridge
            electron_bridge.send_event("desktop-sources-response", responseToSend);
            ipcRenderer.send("preload-log", "✅ Preload: Sources sent via electron_bridge");
            
            // НЕ НУЖНО отправлять через ipcRenderer.send, потому что main process уже отправил
            // через webContents.send, и Jitsi его получил.
            
        } else {
            ipcRenderer.send("preload-log", "⚠️ Preload: No sources received!");
            const errorResponse = {
                sources: [],
                error: "No sources available"
            };
            electron_bridge.send_event("desktop-sources-response", errorResponse);
            // main process тоже отправил ошибку через webContents.send
        }
        
    } catch (error: any) {
        ipcRenderer.send("preload-log", `❌ Preload: Error getting sources: ${error.message}`);
        const errorResponse = {
            sources: [],
            error: error.message
        };
        electron_bridge.send_event("desktop-sources-response", errorResponse);
        // main process тоже отправил ошибку через webContents.send
    }
});


// === ОСТАЛЬНЫЕ ОБРАБОТЧИКИ ===

// Walkie-talkie
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
    ipcRenderer.send("preload-log", `Preload: toggle-walkie-talkie: isMuted=${isMuted}`);
    bridgeEvents.emit("toggle-walkie-talkie", isMuted);
});

// Expose electron_bridge
contextBridge.exposeInMainWorld("electron_bridge", {
    ...electron_bridge,
    setMicHotkey: (enabled: boolean, hotkey: string) => {
        ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши: ${hotkey}`);
        ipcRenderer.send("walkie-talkie-status", { enabled: enabled, key: hotkey });
    },
    onMicStateChanged: (callback: (data: boolean) => void) => {
        bridgeEvents.on("toggle-walkie-talkie", callback);
    }
});

// Expose screen capture API
contextBridge.exposeInMainWorld('screenCapture', {
    startCapture: async (options: {
        sourceId: string;
        width: number;
        height: number;
        frameRate: number;
    }) => {
        try {
            const response = await ipcRenderer.invoke("screen-capture-start", options);
            if (response.success) {
                return response.result;
            } else {
                throw new Error(response.error);
            }
        } catch (error: any) {
            throw error;
        }
    },
    
    stopCapture: async () => {
        try {
            const response = await ipcRenderer.invoke("screen-capture-stop");
            if (!response.success) {
                throw new Error(response.error);
            }
        } catch (error: any) {
            throw error;
        }
    },
    
    testMethod: async () => {
        try {
            const response = await ipcRenderer.invoke("screen-capture-test");
            if (response.success) {
                return response.result;
            } else {
                throw new Error(response.error);
            }
        } catch (error: any) {
            return "Error calling test method";
        }
    }
});

// Expose ipcRenderer for Zulip
contextBridge.exposeInMainWorld("ipcRenderer", {
    invoke: async (channel: any, ...args: unknown[]) => {
        ipcRenderer.send("preload-log", `Zulip: ipcRenderer.invoke ${channel}`);
        try {
            const result = await ipcRenderer.invoke(channel, ...args);
            return result;
        } catch (error) {
            ipcRenderer.send("preload-log", `Zulip: Ошибка ${channel}: ${error}`);
            throw error;
        }
    },
    on: (channel: any, listener: (event: any, ...args: any[]) => void) => {
        ipcRenderer.on(channel, listener);
    }
});

// === ОСТАЛЬНЫЕ ОБРАБОТЧИКИ СОБЫТИЙ ===

ipcRenderer.on("logout", () => {
    bridgeEvents.emit("logout");
});

ipcRenderer.on("show-keyboard-shortcuts", () => {
    bridgeEvents.emit("show-keyboard-shortcuts");
});

ipcRenderer.on("show-notification-settings", () => {
    bridgeEvents.emit("show-notification-settings");
});

// Прямые обработчики
ipcRenderer.on("trigger-open-desktop-picker", () => {
    ipcRenderer.send("preload-log", "✅ Preload: trigger-open-desktop-picker");
    electron_bridge.send_event("open-desktop-picker");
});

ipcRenderer.on("requestDesktopSources", () => {
    ipcRenderer.send("preload-log", "✅ Preload: requestDesktopSources (direct)");
    electron_bridge.send_event("requestDesktopSources");
});

// Forward message handler
ipcRenderer.on("forward-message", (event, channel) => {
    ipcRenderer.send("preload-log", `✅ Preload: forward-message: ${channel}`);
    
    if (channel === "trigger-open-desktop-picker") {
        electron_bridge.send_event("open-desktop-picker");
    }
    if (channel === "request-desktop-sources") {
        electron_bridge.send_event("requestDesktopSources");
    }
    if (channel === "test-screen-capture-in-webview") {
        ipcRenderer.send("preload-log", "🧪 Testing screen capture in webview...");
        if (window.screenCapture) {
            window.screenCapture.testMethod().then(result => {
                ipcRenderer.send("preload-log", `✅ Test result: ${result}`);
            });
        }
    }
});

// КРИТИЧНО: Обработчик ответа от main процесса
ipcRenderer.on("desktop-sources-response", (event, response) => {
    const sourcesNames = response.sources ? response.sources.map((s: any) => s.name).join(', ') : '[]';
    ipcRenderer.send("preload-log", `✅ Preload: desktop-sources-response: sources=[${sourcesNames}]`);
    
    // Пересылаем через electron_bridge
    electron_bridge.send_event("desktop-sources-response", response);
});

// Network error handler
window.addEventListener("load", () => {
    if (!location.href.includes("app/renderer/network.html")) {
        return;
    }
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
});

ipcRenderer.send("preload-log", "✅ Preload: Initialization complete");