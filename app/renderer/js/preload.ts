// Simplified preload.ts - remove all the complex getUserMedia overrides
// Keep only essential parts

import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";


async function sendDesktopSources(sources: any[], error: any = null) {
  ipcRenderer.send("preload-log", `🎯[NativeCapture] sendDesktopSources: ${sources?.length || 0} sources`);
  
  // Метод 1: Через electron_bridge (для текущего webview)
  electron_bridge.send_event("desktop-sources-response", {
    sources: sources,
    error: error
  });
  
  // Метод 2: Через broadcast (для всех webviews)
  if (sources && sources.length > 0) {
    ipcRenderer.send("broadcast-desktop-sources", sources);
  }
  
  // Метод 3: Эмулируем событие напрямую
  window.dispatchEvent(new CustomEvent("desktop-sources-response", {
    detail: { sources, error }
  }));
}

// === Перехват getDisplayMedia в контексте страницы ===
const script = `
(() => {
  if (navigator.mediaDevices && !navigator.mediaDevices._getDisplayMedia) {
    // Сохраняем оригинальный метод
    navigator.mediaDevices._getDisplayMedia = navigator.mediaDevices.getDisplayMedia;

    // Переопределяем
    navigator.mediaDevices.getDisplayMedia = async function(constraints) {
      console.log('🎯[Jitsi Intercept] getDisplayMedia called', constraints);

      // Если это запрос на захват экрана
      if (constraints.video && typeof constraints.video === 'object' && 
          (constraints.video.mediaSource === 'screen' || constraints.video.mandatory?.chromeMediaSource === 'desktop')) {

        // Сообщаем основному процессу, что нужно запустить native capture
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('start-native-capture-simple');

        if (result.success && result.streamId) {
          console.log('🎯[Jitsi Intercept] Using native stream:', result.streamId);
          // Запрашиваем поток с нашим streamId
          return navigator.mediaDevices.getUserMedia({
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: result.streamId
              }
            },
            audio: constraints.audio || false
          });
        }
      }

      // Иначе — стандартное поведение
      return navigator.mediaDevices._getDisplayMedia(constraints);
    };
  }
})();
`;

// Инжектируем скрипт в страницу
window.addEventListener('DOMContentLoaded', () => {
  const scriptEl = document.createElement('script');
  scriptEl.textContent = script;
  scriptEl.type = 'text/javascript';
  document.documentElement.appendChild(scriptEl);
  scriptEl.remove(); // Удаляем, но выполнение уже произошло
});

ipcRenderer.send("preload-log", "🎯[NativeCapture] Preload загружен, версия 2.0");
ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
// В самом начале


// Keep your existing walkie-talkie code
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
    ipcRenderer.send("preload-log", `Preload: Получено событие toggle-walkie-talkie: isMuted=${isMuted}`);
    bridgeEvents.emit("toggle-walkie-talkie", isMuted);
});

// Keep your existing electron_bridge setup
contextBridge.exposeInMainWorld("electron_bridge", {
    ...electron_bridge,
    setMicHotkey: (enabled: boolean, hotkey: string) => {
        ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши микрофона: ${hotkey}`);
        ipcRenderer.send("walkie-talkie-status", { enabled: enabled, key: hotkey });
    },
    onMicStateChanged: (callback: (data: boolean) => void) => {
        ipcRenderer.send("preload-log", "Preload: Установка слушателя для toggle-walkie-talkie");
        bridgeEvents.on("toggle-walkie-talkie", callback);
    }
});

// SIMPLIFIED screen capture API - only essential methods
contextBridge.exposeInMainWorld('screenCapture', {
  // Only keep the simple method that works
  startForZulip: async () => {
    ipcRenderer.send("preload-log", "🚀 Starting native capture for Zulip");
    try {
      const response = await ipcRenderer.invoke('start-native-capture-simple');
      if (response.success) {
        ipcRenderer.send("preload-log", "✅ Native capture started");
        return { success: true };
      } else {
        throw new Error(response.error);
      }
    } catch (error: any) {
      ipcRenderer.send("preload-log", `❌ Native capture error: ${error.message}`);
      throw error;
    }
  },

  stopForZulip: async () => {
    ipcRenderer.send("preload-log", "🛑 Stopping native capture");
    try {
      const response = await ipcRenderer.invoke('stop-native-capture-simple');
      return response;
    } catch (error: any) {
      ipcRenderer.send("preload-log", `❌ Stop error: ${error.message}`);
      throw error;
    }
  }
});

// Keep your existing ipcRenderer exposure
contextBridge.exposeInMainWorld("ipcRenderer", {
    invoke: async (channel: any, ...args: unknown[]) => {
        ipcRenderer.send("preload-log", `Zulip Preload: Запрос ${channel}`);
        try {
            const result = await ipcRenderer.invoke(channel, ...args);
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

// Keep your essential event handlers
ipcRenderer.on("desktop-sources-response", (event, response) => {
  const sourcesNames = response.sources ? response.sources.map((s: any) => s.name).join(', ') : '[]';
  ipcRenderer.send("preload-log", `✅ Preload: desktop-sources-response: sources=[${sourcesNames}]`);
  electron_bridge.send_event("desktop-sources-response", response);
});

// Keep other essential handlers
ipcRenderer.on("logout", () => {
    bridgeEvents.emit("logout");
});

ipcRenderer.on("trigger-open-desktop-picker", () => {
    ipcRenderer.send("preload-log", "✅ Preload: trigger-open-desktop-picker");
    electron_bridge.send_event("open-desktop-picker");
});

ipcRenderer.on("forward-message", (event, channel) => {
    ipcRenderer.send("preload-log", `✅ Preload: forward-message: ${channel}`);
    
    if (channel === "trigger-open-desktop-picker") {
        electron_bridge.send_event("open-desktop-picker");
    }
    if (channel === "request-desktop-sources") {
        electron_bridge.send_event("requestDesktopSources");
    }
});

// Keep network error handler
window.addEventListener("load", () => {
    if (!location.href.includes("app/renderer/network.html")) {
        return;
    }
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
});







// Глобальные переменные для предотвращения дублей
let isHandlingRequest = false;
let lastDialogTime = 0;
let dialogPromise: Promise<void> | null = null;

// Исправленная функция обработки
async function handleNativeCaptureRequest() {
  // Предотвращаем множественные одновременные вызовы
  if (isHandlingRequest) {
    ipcRenderer.send("preload-log", "🎯[NativeCapture] ⚠️ Already handling request, skipping duplicate");
    return;
  }
  
  // Если диалог уже показывается, ждем его завершения
  if (dialogPromise) {
    ipcRenderer.send("preload-log", "🎯[NativeCapture] ⏳ Waiting for existing dialog...");
    await dialogPromise;
    return;
  }
  
  isHandlingRequest = true;
  
  ipcRenderer.send("preload-log", "🎯[NativeCapture] ============ handleNativeCaptureRequest START ============");
  
  const now = Date.now();
  
  // Проверяем таймаут
  if (lastDialogTime > 0 && (now - lastDialogTime) < 30000) {
    ipcRenderer.send("preload-log", "🎯[NativeCapture] ⏭️ Dialog shown recently, using standard sources");
    isHandlingRequest = false;
    
    try {
      const sources = await ipcRenderer.invoke('get-desktop-sources');
      ipcRenderer.send("preload-log", `🎯[NativeCapture] Got ${sources.length} sources without dialog`);
      
      // Логируем первые несколько источников для отладки
      if (sources && sources.length > 0) {
        sources.slice(0, 3).forEach((source: any, i: number) => {
          ipcRenderer.send("preload-log", `🎯[NativeCapture] Source ${i}: id=${source.id}, name=${source.name}, has thumbnail=${!!source.thumbnail?.dataUrl}`);
        });
      }
      
      await sendDesktopSources(sources, error);
    } catch (error: any) {
      ipcRenderer.send("preload-log", `🎯[NativeCapture] Error getting sources: ${error.message}`);
      await sendDesktopSources(sources, error);
    }
    return;
  }
  
  // Создаем промис для диалога
  dialogPromise = (async () => {
    try {
      lastDialogTime = now;
      ipcRenderer.send("preload-log", "🎯[NativeCapture] 📢 Showing dialog...");
      
      const choice = await ipcRenderer.invoke('show-native-capture-choice');
      ipcRenderer.send("preload-log", `🎯[NativeCapture] ✅ User selected: ${choice}`);
      
      if (choice === 'native') {
        ipcRenderer.send("preload-log", "🎯[NativeCapture] 🚀 Getting native sources...");
        
        // Получаем источники через Swift
        try {
          const sources = await ipcRenderer.invoke('get-desktop-sources');
          ipcRenderer.send("preload-log", `🎯[NativeCapture] Got ${sources.length} native sources`);
          
          if (sources && sources.length > 0) {
            // Логируем первые несколько источников
            sources.slice(0, 3).forEach((source: any, i: number) => {
              ipcRenderer.send("preload-log", `🎯[NativeCapture] Source ${i}: ${source.name} (${source.id})`);
            });
            
            await sendDesktopSources(sources, error);
            
            ipcRenderer.send("preload-log", "🎯[NativeCapture] ✅ Native sources sent to Jitsi");
            return;
          } else {
            ipcRenderer.send("preload-log", "🎯[NativeCapture] ⚠️ No sources returned");
          }
        } catch (sourceError: any) {
          ipcRenderer.send("preload-log", `🎯[NativeCapture] ❌ Error getting sources: ${sourceError.message}`);
        }
      }
      
      // Fallback to standard sources
      ipcRenderer.send("preload-log", "🎯[NativeCapture] Using standard sources");
      const sources = await ipcRenderer.invoke('get-desktop-sources');
      ipcRenderer.send("preload-log", `🎯[NativeCapture] Got ${sources.length} standard sources`);
      
      await sendDesktopSources(sources, error);
      
    } catch (error: any) {
      ipcRenderer.send("preload-log", `🎯[NativeCapture] ❌ Error: ${error.message}`);
      await sendDesktopSources(sources, error);
    } finally {
      isHandlingRequest = false;
      dialogPromise = null;
      ipcRenderer.send("preload-log", "🎯[NativeCapture] ============ END ============");
    }
  })();
  
  await dialogPromise;
}

// Единственная подписка на событие
let isSubscribed = false;

if (!isSubscribed) {
  isSubscribed = true;
  
  // Подписываемся только один раз
  electron_bridge.on_event("requestDesktopSources", () => {
    ipcRenderer.send("preload-log", "🎯[NativeCapture] Event received via on_event");
    handleNativeCaptureRequest();
  });
  
  ipcRenderer.send("preload-log", "🎯[NativeCapture] ✅ Event listener registered");
}

setTimeout(() => {
  const testBtn = document.createElement('button');
  testBtn.innerHTML = '🧪 Test Swift Sources';
  testBtn.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 20px;
    z-index: 99999;
    padding: 10px;
    background: #ff5722;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
  `;
  
  testBtn.onclick = async () => {
    try {
      const result = await ipcRenderer.invoke('get-swift-sources-test');
      console.log('🧪 Swift sources test:', result);
      
      if (result.success) {
        alert(`Swift Sources: ${result.sources.length} found\n\nCheck console for details`);
      } else {
        alert(`Error: ${result.error}`);
      }
    } catch (err) {
      console.error('Test error:', err);
    }
  };
  
  document.body.appendChild(testBtn);
}, 2000);

const originalSendEvent = electron_bridge.send_event;
electron_bridge.send_event = function(eventName: string | symbol, ...args: any[]): boolean {
  const name = String(eventName);
  
  if (name === "desktop-sources-response") {
    ipcRenderer.send("preload-log", `🎯[NativeCapture] Sending desktop-sources-response`);
    const response = args[0];
    if (response) {
      ipcRenderer.send("preload-log", `🎯[NativeCapture] Response has sources: ${!!response.sources}`);
      ipcRenderer.send("preload-log", `🎯[NativeCapture] Response has error: ${!!response.error}`);
      if (response.sources) {
        ipcRenderer.send("preload-log", `🎯[NativeCapture] Sources count: ${response.sources.length}`);
        if (response.sources.length > 0) {
          const first = response.sources[0];
          ipcRenderer.send("preload-log", `🎯[NativeCapture] First source: id=${first.id}, name=${first.name}`);
          ipcRenderer.send("preload-log", `🎯[NativeCapture] Has thumbnail: ${!!first.thumbnail}`);
          ipcRenderer.send("preload-log", `🎯[NativeCapture] Thumbnail dataUrl length: ${first.thumbnail?.dataUrl?.length || 0}`);
        }
      }
    }
  }
  
  return originalSendEvent.apply(this, [eventName, ...args]);
};