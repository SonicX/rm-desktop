// Очищенный preload.ts с возвратом к стандартному Electron API
import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";

ipcRenderer.send("preload-log", "🎯[DesktopSources] Preload загружен - стандартный Electron API");

// === ОСНОВНЫЕ ФУНКЦИИ ===

// Функция отправки источников в Jitsi (упрощенная)
function sendDesktopSources(sources: any[], error: any = null) {
  ipcRenderer.send("preload-log", `🎯[DesktopSources] sendDesktopSources: ${sources?.length || 0} sources`);
  
  // КРИТИЧНО: Проверяем формат источников
  if (sources && sources.length > 0) {
    sources.forEach((source, i) => {
      if (!source.id || !source.name) {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] ⚠️ Source ${i} missing id/name: ${JSON.stringify(source)}`);
      }
      if (!source.thumbnail || !source.thumbnail.dataUrl) {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] ⚠️ Source ${i} missing thumbnail: ${JSON.stringify(source)}`);
      }
    });
  }
  
  // Метод 1: Через electron_bridge (основной для Zulip)
  if (typeof electron_bridge !== 'undefined') {
    try {
      const result = electron_bridge.send_event("desktop-sources-response", {
        sources: sources,
        error: error
      });
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ electron_bridge.send_event result: ${result}`);
    } catch (e: any) {
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ electron_bridge error: ${e.message}`);
    }
  }
  
  // Метод 2: Прямо в Jitsi API если доступен
  try {
    // @ts-ignore - проверяем JitsiMeetElectron
    if (window.JitsiMeetElectron && typeof window.JitsiMeetElectron._desktopCapturerSourcesResponse === 'function') {
      // @ts-ignore
      window.JitsiMeetElectron._desktopCapturerSourcesResponse(sources);
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ Sent via JitsiMeetElectron._desktopCapturerSourcesResponse`);
    } else {
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ℹ️ JitsiMeetElectron._desktopCapturerSourcesResponse not available`);
    }
  } catch (e: any) {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ JitsiMeetElectron error: ${e.message}`);
  }
  
  // Метод 3: Через postMessage в текущем окне
  try {
    window.postMessage({
      type: '_desktopCapturerSources',
      sources: sources
    }, '*');
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ Sent via window.postMessage`);
  } catch (e: any) {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ postMessage error: ${e.message}`);
  }
  
  // Метод 4: Отправка во ВСЕ iframe (включая скрытые)
  const iframes = document.querySelectorAll('iframe');
  ipcRenderer.send("preload-log", `🎯[DesktopSources] Found ${iframes.length} iframes`);
  
  iframes.forEach((iframe, index) => {
    try {
      const src = iframe.src || iframe.getAttribute('src') || 'no-src';
      ipcRenderer.send("preload-log", `🎯[DesktopSources] Iframe ${index}: ${src}`);
      
      // Отправляем в ВСЕ iframe, не только Jitsi
      if (iframe.contentWindow) {
        // Формат 1: Стандартный Electron
        iframe.contentWindow.postMessage({
          type: '_desktopCapturerSources',
          sources: sources
        }, '*');
        
        // Формат 2: Альтернативный формат для Jitsi
        iframe.contentWindow.postMessage({
          method: 'desktop-capturer-selection',
          sources: sources
        }, '*');
        
        // Формат 3: Jitsi-специфичный
        iframe.contentWindow.postMessage({
          jitsiApiEvent: {
            name: 'desktop-sources-updated',
            sources: sources
          }
        }, '*');
        
        ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ Sent 3 formats to iframe ${index}`);
      } else {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] ⚠️ Iframe ${index} has no contentWindow`);
      }
    } catch (e: any) {
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ Iframe ${index} error: ${e.message}`);
    }
  });
  
  // Метод 5: Custom events
  try {
    // Event 1: Стандартный
    window.dispatchEvent(new CustomEvent("desktop-sources-response", {
      detail: { sources, error },
      bubbles: true,
      cancelable: true
    }));
    
    // Event 2: Jitsi-специфичный
    window.dispatchEvent(new CustomEvent("jitsi-desktop-capturer-sources", {
      detail: { sources },
      bubbles: true,
      cancelable: true
    }));
    
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ Dispatched custom events`);
  } catch (e: any) {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ Custom events error: ${e.message}`);
  }
  
  // Сохраняем источники глобально
  (window as any).__lastDesktopSources = sources;
  (window as any).__lastDesktopSourcesTime = Date.now();
  
  ipcRenderer.send("preload-log", `🎯[DesktopSources] ✅ Sources saved globally`);
}

// Добавьте функцию для агрессивного поиска и отправки в iframe:
function aggressiveFindAndSendToIframes(sources: any[]) {
  ipcRenderer.send("preload-log", `🎯[DesktopSources] 🔍 Aggressive iframe search starting...`);
  
  // Ищем iframe по всем возможным селекторам
  const selectors = [
    'iframe',
    'iframe[src*="jitsi"]',
    'iframe[src*="joinrm"]',
    'iframe[src*="connectrm"]',
    'webview',
    'embed',
    'object'
  ];
  
  let totalFound = 0;
  
  selectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    ipcRenderer.send("preload-log", `🎯[DesktopSources] Selector "${selector}": ${elements.length} found`);
    
    elements.forEach((element, index) => {
      try {
        let contentWindow = null;
        let src = '';
        
        if (element instanceof HTMLIFrameElement) {
          contentWindow = element.contentWindow;
          src = element.src;
        } else if (element instanceof HTMLElement && 'contentWindow' in element) {
          contentWindow = (element as any).contentWindow;
          src = element.getAttribute('src') || '';
        }
        
        if (contentWindow) {
          ipcRenderer.send("preload-log", `🎯[DesktopSources] 📤 Sending to ${selector}[${index}]: ${src}`);
          
          // Отправляем в агрессивном режиме со всеми возможными форматами
          const formats = [
            { type: '_desktopCapturerSources', sources },
            { method: 'desktop-capturer-selection', sources },
            { jitsiApiEvent: { name: 'desktop-sources-updated', sources } },
            { type: 'DESKTOP_CAPTURER_GET_SOURCES_RESPONSE', sources },
            { data: { type: '_desktopCapturerSources', sources } }
          ];
          
          formats.forEach((format, formatIndex) => {
            try {
              contentWindow.postMessage(format, '*');
            } catch (e: any) {
              ipcRenderer.send("preload-log", `🎯[DesktopSources] Format ${formatIndex} failed: ${e.message}`);
            }
          });
          
          totalFound++;
        }
      } catch (e: any) {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ Error with ${selector}[${index}]: ${e.message}`);
      }
    });
  });
  
  ipcRenderer.send("preload-log", `🎯[DesktopSources] 🔍 Aggressive search complete: ${totalFound} targets found`);
}

// Основной обработчик запроса источников (ИСПРАВЛЕННЫЙ)
async function handleDesktopSourcesRequest() {
  ipcRenderer.send("preload-log", "🎯[DesktopSources] ========== HANDLE REQUEST START ==========");
  
  try {
    // Получаем источники
    const sources = await ipcRenderer.invoke('get-desktop-sources');
    ipcRenderer.send("preload-log", `🎯[DesktopSources] Got ${sources.length} sources from main process`);
    
    if (sources && sources.length > 0) {
      // Логируем каждый источник детально
      sources.forEach((source: any, i: number) => {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] Source ${i}: ${source.name} (${source.id}) - thumbnail: ${source.thumbnail ? 'YES' : 'NO'}`);
      });
      
      // Стандартная отправка
      sendDesktopSources(sources, null);
      
      // ДОПОЛНИТЕЛЬНО: Агрессивный поиск iframe через 500мс
      setTimeout(() => {
        aggressiveFindAndSendToIframes(sources);
      }, 500);
      
      // ДОПОЛНИТЕЛЬНО: Повторная отправка через 2 секунды
      setTimeout(() => {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] 🔄 Retry send after 2s...`);
        sendDesktopSources(sources, null);
      }, 2000);
      
    } else {
      ipcRenderer.send("preload-log", `🎯[DesktopSources] ⚠️ No sources received!`);
      sendDesktopSources([], "No sources available");
    }
    
  } catch (error: any) {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] ❌ Error: ${error.message}`);
    sendDesktopSources([], error.message);
  }
  
  ipcRenderer.send("preload-log", "🎯[DesktopSources] ========== HANDLE REQUEST END ==========");
}

// === ЭКСПОРТ В WINDOW ===

// Стандартный electron_bridge
contextBridge.exposeInMainWorld("electron_bridge", {
  ...electron_bridge,
  
  // Walkie-talkie
  setMicHotkey: (enabled: boolean, hotkey: string) => {
    ipcRenderer.send("walkie-talkie-status", { enabled, key: hotkey });
  },
  onMicStateChanged: (callback: (data: boolean) => void) => {
    bridgeEvents.on("toggle-walkie-talkie", callback);
  }
});

// ipcRenderer для Zulip
contextBridge.exposeInMainWorld("ipcRenderer", {
  invoke: async (channel: any, ...args: unknown[]) => {
    ipcRenderer.send("preload-log", `Zulip: ipcRenderer.invoke ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: any, listener: (event: any, ...args: any[]) => void) => {
    ipcRenderer.send("preload-log", `Zulip: ipcRenderer.on ${channel}`);
    ipcRenderer.on(channel, listener);
  }
});

// === ПОДПИСКИ НА СОБЫТИЯ ===

// Основной слушатель запроса источников
electron_bridge.on_event("requestDesktopSources", () => {
  ipcRenderer.send("preload-log", "🎯[DesktopSources] requestDesktopSources event received via electron_bridge");
  handleDesktopSourcesRequest();
});

// Резервные слушатели для совместимости
ipcRenderer.on("desktop-sources-response", (event, response) => {
  ipcRenderer.send("preload-log", `🎯[DesktopSources] Got desktop-sources-response from main`);
  electron_bridge.send_event("desktop-sources-response", response);
});

// Walkie-talkie
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
  bridgeEvents.emit("toggle-walkie-talkie", isMuted);
});

// === ПЕРЕХВАТ send_event ДЛЯ ЛОГИРОВАНИЯ ===
const originalSendEvent = electron_bridge.send_event;
electron_bridge.send_event = function(eventName: string | symbol, ...args: any[]): boolean {
  const name = String(eventName);
  
  if (name === "desktop-sources-response" || name === "requestDesktopSources") {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] send_event: ${name}`);
  }
  
  return originalSendEvent.apply(this, [eventName, ...args]);
};

// === ТЕСТОВЫЕ ФУНКЦИИ ===

// Тестовая функция для проверки стандартного Electron
async function testElectronSources() {
  ipcRenderer.send("preload-log", "🧪[TEST] Testing standard Electron sources...");
  
  try {
    const result = await ipcRenderer.invoke('test-electron-sources');
    ipcRenderer.send("preload-log", `🧪[TEST] Electron test result: ${JSON.stringify(result)}`);
    return result;
  } catch (error: any) {
    ipcRenderer.send("preload-log", `🧪[TEST] Electron test error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// === ГЛОБАЛЬНЫЕ СЛУШАТЕЛИ ===

// Слушаем postMessage для запросов от Jitsi
window.addEventListener('message', (event) => {
  if (event.data && typeof event.data === 'object') {
    // Проверяем запросы от Jitsi на источники экрана
    if (event.data.type === '_requestDesktopSources' || 
        event.data.method === 'get-desktop-sources' ||
        (event.data.jitsiApiEvent && event.data.jitsiApiEvent.name === 'request-desktop-sources')) {
      ipcRenderer.send("preload-log", `🎯[DesktopSources] Desktop sources requested via postMessage!`);
      handleDesktopSourcesRequest();
    }
  }
});

// Мониторинг появления новых iframe
const iframeObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node instanceof HTMLIFrameElement) {
        const src = node.src || '';
        ipcRenderer.send("preload-log", `🎯[DesktopSources] New iframe detected: ${src}`);
        
        // Если это Jitsi iframe и у нас есть сохраненные источники
        if ((src.includes('joinrm-svz.ru') || src.includes('jitsi')) && 
            (window as any).__lastDesktopSources) {
          setTimeout(() => {
            ipcRenderer.send("preload-log", `🎯[DesktopSources] Sending saved sources to new iframe`);
            sendDesktopSources((window as any).__lastDesktopSources);
          }, 2000);
        }
      }
    });
  });
});

// Начинаем наблюдение за DOM
if (document.body) {
  iframeObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    iframeObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  });
}

// Перехват Jitsi API если он загружается позже
let jitsiCheckInterval: any = null;
function checkForJitsiAPI() {
  // @ts-ignore
  if (window.JitsiMeetElectron || window.APP) {
    ipcRenderer.send("preload-log", `🎯[DesktopSources] Jitsi API detected!`);
    
    // Переопределяем метод запроса источников если есть
    // @ts-ignore
    if (window.JitsiMeetElectron && !window.JitsiMeetElectron._requestDesktopSourcesPatched) {
      // @ts-ignore
      const originalRequest = window.JitsiMeetElectron._requestDesktopSources;
      // @ts-ignore
      window.JitsiMeetElectron._requestDesktopSources = function(options: any) {
        ipcRenderer.send("preload-log", `🎯[DesktopSources] Intercepted JitsiMeetElectron._requestDesktopSources`);
        handleDesktopSourcesRequest();
      };
      // @ts-ignore
      window.JitsiMeetElectron._requestDesktopSourcesPatched = true;
    }
    
    if (jitsiCheckInterval) {
      clearInterval(jitsiCheckInterval);
      jitsiCheckInterval = null;
    }
  }
}

// Проверяем каждые 500мс в течение 10 секунд
jitsiCheckInterval = setInterval(checkForJitsiAPI, 500);
setTimeout(() => {
  if (jitsiCheckInterval) {
    clearInterval(jitsiCheckInterval);
    jitsiCheckInterval = null;
  }
}, 10000);

// === ТЕСТОВЫЕ КНОПКИ ===
setTimeout(() => {
  // Кнопка для тестирования стандартного Electron
  const electronTestBtn = document.createElement('button');
  electronTestBtn.innerHTML = '🔬 Test Electron';
  electronTestBtn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    padding: 10px 20px;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  electronTestBtn.onclick = async () => {
    console.log('🔬 Testing Electron desktopCapturer');
    electronTestBtn.innerHTML = '⏳ Testing...';
    
    try {
      const result = await testElectronSources();
      console.log('🔬 Electron test result:', result);
      alert(`Electron Test: ${result.success ? 'SUCCESS' : 'FAILED'}\n${result.success ? `Found ${result.sources.length} sources` : result.error}`);
    } catch (err: any) {
      console.error('🔬 Test error:', err);
      alert(`Test failed: ${err.message}`);
    }
    
    electronTestBtn.innerHTML = '🔬 Test Electron';
  };
  
  document.body.appendChild(electronTestBtn);
  
  // Кнопка для ручного запроса источников
  const requestBtn = document.createElement('button');
  requestBtn.innerHTML = '🎯 Request Sources';
  requestBtn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 160px;
    z-index: 99999;
    padding: 10px 20px;
    background: #2196F3;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  requestBtn.onclick = async () => {
    console.log('🎯 Manual sources request');
    requestBtn.innerHTML = '⏳ Requesting...';
    
    try {
      await handleDesktopSourcesRequest();
      requestBtn.innerHTML = '✅ Done';
      setTimeout(() => {
        requestBtn.innerHTML = '🎯 Request Sources';
      }, 2000);
    } catch (err: any) {
      console.error('🎯 Request error:', err);
      requestBtn.innerHTML = '❌ Error';
      setTimeout(() => {
        requestBtn.innerHTML = '🎯 Request Sources';
      }, 2000);
    }
  };
  
  document.body.appendChild(requestBtn);
  
}, 2000);

// Network error handler
window.addEventListener("load", () => {
  if (location.href.includes("app/renderer/network.html")) {
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
  }
});














const debugDialogBtn = document.createElement('button');
debugDialogBtn.innerHTML = '🔍 Debug Jitsi Dialog';
debugDialogBtn.style.cssText = `
  position: fixed;
  bottom: 80px;
  right: 20px;
  z-index: 99999;
  padding: 10px 20px;
  background: #9C27B0;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-weight: bold;
`;

debugDialogBtn.onclick = () => {
  console.log('🔍 Debugging Jitsi dialog...');
  
  // 1. Проверяем наличие глобальных объектов
  const checks = {
    // @ts-ignore
    hasJitsiMeetElectron: typeof window.JitsiMeetElectron !== 'undefined',
    // @ts-ignore
    hasAPP: typeof window.APP !== 'undefined',
    // @ts-ignore
    hasDesktopCapturerResponse: window.JitsiMeetElectron && typeof window.JitsiMeetElectron._desktopCapturerSourcesResponse === 'function',
    hasElectronBridge: typeof window.electron_bridge !== 'undefined',
    hasSavedSources: !!(window as any).__lastDesktopSources
  };
  
  console.log('🔍 Global objects check:', checks);
  
  // 2. Ищем диалоги выбора источников
  const dialogSelectors = [
    '[data-testid="desktop-capturer-selection"]',
    '.desktop-capturer-selection',
    '[class*="desktop"]',
    '[class*="source"]',
    '[class*="capturer"]',
    '[class*="screen"]',
    '.source-selection',
    '.desktop-picker'
  ];
  
  let dialogsFound = 0;
  dialogSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`🔍 Found ${elements.length} elements with selector: ${selector}`);
      elements.forEach((el, i) => {
        console.log(`  - Element ${i}:`, el);
      });
      dialogsFound += elements.length;
    }
  });
  
  // 3. Ищем кнопки "Share screen" или похожие
  const buttons = document.querySelectorAll('button, [role="button"]');
  const shareButtons = Array.from(buttons).filter(btn => {
    const text = btn.textContent?.toLowerCase() || '';
    return text.includes('share') || text.includes('screen') || text.includes('desktop');
  });
  
  console.log(`🔍 Found ${shareButtons.length} potential share buttons:`, shareButtons);
  
  // 4. Проверяем iframe
  const iframes = document.querySelectorAll('iframe');
  console.log(`🔍 Found ${iframes.length} iframes:`);
  iframes.forEach((iframe, i) => {
    console.log(`  - Iframe ${i}: ${iframe.src || 'no src'}`);
    
    // Пробуем получить доступ к содержимому iframe
    try {
      if (iframe.contentWindow && iframe.contentDocument) {
        const iframeDialogs = iframe.contentDocument.querySelectorAll('[class*="desktop"], [class*="source"], [class*="capturer"]');
        console.log(`    - Iframe ${i} dialogs found: ${iframeDialogs.length}`);
      }
    } catch (e) {
      console.log(`    - Iframe ${i} access blocked (cross-origin)`);
    }
  });
  
  // 5. Имитируем запрос источников
  console.log('🔍 Triggering desktop sources request...');
  handleDesktopSourcesRequest();
  
  // 6. Показываем результат
  const summary = `
🔍 Jitsi Dialog Debug Results:
=============================
✓ JitsiMeetElectron: ${checks.hasJitsiMeetElectron}
✓ APP object: ${checks.hasAPP}
✓ Response function: ${checks.hasDesktopCapturerResponse}
✓ Electron bridge: ${checks.hasElectronBridge}
✓ Saved sources: ${checks.hasSavedSources}

📋 Elements found:
- Dialog elements: ${dialogsFound}
- Share buttons: ${shareButtons.length}
- Iframes: ${iframes.length}

Check console for detailed information.
  `;
  
  alert(summary);
  
  // 7. Принудительно отправляем тестовые источники
  if ((window as any).__lastDesktopSources) {
    console.log('🔍 Re-sending saved sources...');
    sendDesktopSources((window as any).__lastDesktopSources);
  } else {
    console.log('🔍 Sending test sources...');
    const testSources = [
      {
        id: 'test:debug:screen',
        name: '🔍 Debug Test Screen',
        thumbnail: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4AQAA/QGOrDGjAAAAAElFTkSuQmCC' }
      },
      {
        id: 'test:debug:window',
        name: '🔍 Debug Test Window',
        thumbnail: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' }
      }
    ];
    sendDesktopSources(testSources);
  }
};

document.body.appendChild(debugDialogBtn);







ipcRenderer.send("preload-log", "🎯[DesktopSources] Preload initialized with standard Electron API");




