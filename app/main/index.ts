import { clipboard } from "electron/common";
import {
  BrowserWindow,
  globalShortcut,
  type IpcMainEvent,
  type WebContents,
  app,
  dialog,
  powerMonitor,
  session,
  webContents,
  desktopCapturer,
} from "electron/main";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { autoUpdater } from "electron-updater";
import log from "electron-log";


import { GlobalKeyboardListener, IGlobalKeyDownMap, IGlobalKeyEvent } from 'node-global-key-listener';

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import * as ConfigUtil from "../common/config-util.js";
import { bundlePath, bundleUrl, publicPath } from "../common/paths.js";
import * as t from "../common/translation-util.js";
import type { MenuProperties } from "../common/types.js";
import type { RendererMessage, DesktopSource, JitsiLogData, WalkieTalkieStatus } from "../common/typed-ipc.js";

import { appUpdater, shouldQuitForUpdate } from "./autoupdater.js";
import * as BadgeSettings from "./badge-settings.js";
import handleExternalLink from "./handle-external-link.js";
import * as AppMenu from "./menu.js";
import { _getServerSettings, _isOnline, _saveServerIcon } from "./request.js";
import { sentryInit } from "./sentry.js";
import { setAutoLaunch } from "./startup.js";
import { ipcMain, send } from "./typed-ipc-main.js";





// В index.ts добавьте в начало файла:
import * as fs from 'fs';

let screenCaptureAddon: any = null;


// Создаем поток для записи логов
const preloadLogStream = fs.createWriteStream(
  path.join(process.cwd(), 'preload-debug.log'),
  { flags: 'a' } // append mode
);

// Затем обновите обработчик:
ipcMain.on("preload-log", (event, message: string) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Пишем в файл напрямую
  preloadLogStream.write(logMessage);
  
  // Также выводим в консоль
  console.log(`Preload Log: ${message}`);
  
  // И в electron-log
  log.info(`Preload Log: ${message}`);
});






// Настройка логирования
if (process.env.NODE_ENV === "development") {
  log.transports.file.level = "info";
  log.transports.console.level = "info"; // Включить консольный вывод
  log.transports.console.format = "[{h}:{i}:{s}] {text}"; // Формат логов
  autoUpdater.logger = log;
} else {
  log.transports.console.level = false
}

// Настройка автообновления
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// eslint-disable-next-line @typescript-eslint/naming-convention
const { GDK_BACKEND } = process.env;

// Инициализация Sentry для основного процесса
sentryInit();

let mainWindowState: windowStateKeeper.State;
let mainWindow: BrowserWindow;
let badgeCount: number;
let isQuitting = false;

// Переменные для управления горячей клавишей микрофона
let currentHotkey: string | null = null;
let originalMuteState: boolean | null = null;

type KeyName = 
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'DOT' | 'FORWARD SLASH'
  | 'SPACE';

const vKeyToName: { [key: number]: KeyName } = {
  // Латинские буквы (A–Z, соответствуют a–z)
  66: 'B',
  78: 'N',
  88: 'X',
  90: 'Z',
  // Дополнительные клавиши
  32: 'SPACE', // Пробел
  190: 'DOT',
  191: 'FORWARD SLASH'
};

class CustomKeyboardListener extends GlobalKeyboardListener {
  public startListener(): Promise<void> {
    return this.start(); // Вызываем защищённый метод start
  }

  public stopListener(): void {
    this.stop(); // Вызываем защищённый метод stop
  }
}

function normalizeKey(key: string): string {
  // Преобразование кириллических букв в латинские эквиваленты
  const cyrillicToLatin: { [key: string]: string } = {
    'а': 'a', // Ф
    'б': 'b', // И
    'в': 'v', // Ц
    'г': 'g', // У
    'д': 'd', // В
    'е': 'e', // У
    'ё': 'e', // Ё (можно сопоставить с E)
    'ж': 'zh', // Ж (нет прямого эквивалента, используем zh)
    'з': 'z', // Я
    'и': 'i', // Ш
    'й': 'j', // Й
    'к': 'k', // Л
    'л': 'l', // Д
    'м': 'm', // Ь
    'н': 'n', // Т
    'о': 'o', // Щ
    'п': 'p', // З
    'р': 'r', // К
    'с': 's', // Ы
    'т': 't', // Е
    'у': 'u', // Г
    'ф': 'f', // А
    'х': 'h', // Р
    'ц': 'c', // С
    'ч': 'ch', // Ч (нет прямого эквивалента, используем ch)
    'ш': 'sh', // Ш (нет прямого эквивалента, используем sh)
    'щ': 'sch', // Щ (нет прямого эквивалента, используем sch)
    'ъ': 'hard_sign', // Ъ (нет прямого эквивалента)
    'ы': 'y', // Ы
    'ь': 'soft_sign', // Ь (нет прямого эквивалента)
    'э': 'e', // Э
    'ю': 'yu', // Ю (нет прямого эквивалента, используем yu)
    'я': 'ya', // Я (нет прямого эквивалента, используем ya)
  };

  let normalized = key.toLowerCase().replace("command", "meta");
  for (const [cyr, lat] of Object.entries(cyrillicToLatin)) {
    normalized = normalized.replace(cyr, lat);
  }
  return normalized;
}

const mainUrl = new URL("app/renderer/main.html", bundleUrl).href;

// Создаём маппинг keycode → имя клавиши
const keyboard = new CustomKeyboardListener();

const permissionCallbacks = new Map<number, (grant: boolean) => void>();
let nextPermissionCallbackId = 0;

const appIcon = path.join(publicPath, "resources/Icon");

const iconPath = (): string => {
  if (process.platform === "win32") {
    return appIcon + ".ico";
  } else if (process.platform === "darwin") {
    return appIcon + ".png";
  } else {
    return appIcon + ".png";
  }
};

const toggleApp = (): void => {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
    mainWindow.show();
  } else {
    mainWindow.hide();
  }
};

function setFeaturesApp() {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

async function createMainWindow(): Promise<BrowserWindow> {
  setFeaturesApp();
  mainWindowState = windowStateKeeper({
    defaultWidth: 1100,
    defaultHeight: 720,
    path: `${app.getPath("userData")}/config`,
  });

  let icon = iconPath();

  const win = new BrowserWindow({
    title: "RM",
    icon: icon,
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 500,
    minHeight: 400,
    webPreferences: {
      preload: path.join(bundlePath, "renderer.js"),
      sandbox: false,
      webviewTag: true
    },
    show: false,
    backgroundColor: '#333',
  });

  remoteMain.enable(win.webContents);

  win.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('Ошибка загрузки preload:', preloadPath, error);
    log.error('Ошибка загрузки preload:', preloadPath, error);
  });

  const mainHtmlPath = path.join(__dirname, 'app/renderer/main.html');
  const mainUrl = `file://${mainHtmlPath}`;

  console.log('mainUrl:', mainUrl);

  await win.loadURL(mainUrl).then(() => {
    console.log('✅ Окно создано!');
    if (ConfigUtil.getConfigItem('startMinimized', false)) {
      win.hide();
    } else {
      win.show();
    }
  });

  win.on("close", (event) => {
    if (ConfigUtil.getConfigItem("quitOnClose", false)) {
      app.quit();
    }

    if (!isQuitting && !shouldQuitForUpdate()) {
      event.preventDefault();

      if (process.platform === "darwin") {
        if (win.isFullScreen()) {
          win.setFullScreen(false);
          win.once("leave-full-screen", () => {
            app.hide();
          });
        } else {
          app.hide();
        }
      } else {
        win.hide();
      }
    }
  });

  win.on("enter-full-screen", () => {
    send(win.webContents, "enter-fullscreen");
  });

  win.on("leave-full-screen", () => {
    send(win.webContents, "leave-fullscreen");
  });

  win.webContents.on("will-navigate", (event) => {
    if (event) {
      send(win.webContents, "destroytray");
    }
  });

  win.setTitle("Цифровые технологии РМ");

  mainWindowState.manage(win);
  return win;
}

(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  setFeaturesApp();
  app.disableHardwareAcceleration();
  await app.whenReady();

  // 1. СНАЧАЛА загружаем native addon (у вас уже правильно)
  try {
    // Try multiple possible paths for the addon
    const possiblePaths = [
      path.join(__dirname, 'native-addon.node'),
      path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
      path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
      '/Users/sg12/zulip-desktop/dist-electron/native-addon.node'
    ];
    
    let addonPath: string | null = null;
    for (const testPath of possiblePaths) {
      if (require('fs').existsSync(testPath)) {
        addonPath = testPath;
        break;
      }
    }
    
    if (!addonPath) {
      throw new Error(`Native addon not found. Searched paths: ${possiblePaths.join(', ')}`);
    }
    
    log.info(`Attempting to load native addon from: ${addonPath}`);
    screenCaptureAddon = require(addonPath); // БЕЗ let - используем глобальную переменную
    log.info(`✅ Native addon loaded successfully from: ${addonPath}`);
    
    // Test the addon
    const testResult = screenCaptureAddon.testMethod();
    log.info(`✅ Native addon test result: ${testResult}`);
    
    // Проверяем наличие нового метода
    if (typeof screenCaptureAddon.getAvailableSources === 'function') {
      log.info("✅ Native addon has getAvailableSources method");
    } else {
      log.warn("⚠️ Native addon missing getAvailableSources method");
    }
    
  } catch (error) {
    log.error(`❌ Failed to load native addon: ${error}`);
    log.error(`❌ Current __dirname: ${__dirname}`);
    log.error(`❌ Current process.cwd(): ${process.cwd()}`);
    screenCaptureAddon = null; // Явно устанавливаем null при ошибке
  }

  // 2. ЗАТЕМ создаем сессию
  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  // 3. РЕГИСТРИРУЕМ ВСЕ IPC ОБРАБОТЧИКИ ДО СОЗДАНИЯ ОКНА
  log.info("🎯[NativeCapture] Registering IPC handlers BEFORE window creation...");

  ipcMain.handle("get-server-settings", async (event, domain: string) =>
    _getServerSettings(domain, ses),
  );

  ipcMain.handle("save-server-icon", async (event, url: string) =>
    _saveServerIcon(url, ses),
  );

  ipcMain.handle("is-online", async (event, url: string) =>
    _isOnline(url, ses),
  );




  function createSwiftSourceThumbnail(source: any): string {
    // Цвета и иконки по типу
    const styles: { [key: string]: { color: string; icon: string } } = {
      display: { color: '#4CAF50', icon: '🖥' },
      window: { color: '#2196F3', icon: '🪟' },
      application: { color: '#FF9800', icon: '📱' },
      tab: { color: '#9C27B0', icon: '🌐' },
      browser_tab: { color: '#9C27B0', icon: '🌐' }
    };
    
    const style = styles[source.type] || { color: '#9E9E9E', icon: '❓' };
    
    // Размер для дисплеев и окон
    const sizeInfo = (source.width && source.height) 
      ? `${source.width}×${source.height}` 
      : '';
    
    // Экранируем HTML в названиях
    const escapedName = (source.name || 'Unknown')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
      
    const escapedAppName = source.appName 
      ? source.appName
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;')
      : '';
    
    const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="300" fill="${style.color}"/>
      <text x="150" y="100" font-size="50" text-anchor="middle" fill="white">${style.icon}</text>
      <text x="150" y="160" font-family="Arial" font-size="14" text-anchor="middle" fill="white" font-weight="bold">
        ${escapedName}
      </text>
      ${escapedAppName ? `
        <text x="150" y="185" font-family="Arial" font-size="12" text-anchor="middle" fill="white" opacity="0.9">
          ${escapedAppName}
        </text>
      ` : ''}
      ${sizeInfo ? `
        <text x="150" y="210" font-family="Arial" font-size="11" text-anchor="middle" fill="white" opacity="0.7">
          ${sizeInfo}
        </text>
      ` : ''}
      <rect x="20" y="270" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
      <rect x="20" y="270" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
    </svg>`;
    
    // Конвертируем в base64
    const base64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  }

  async function getSwiftSourcesSafe(): Promise<any[]> {
    if (!screenCaptureAddon || typeof screenCaptureAddon.getAvailableSources !== 'function') {
      throw new Error('Swift addon not available');
    }
    
    return new Promise((resolve, reject) => {
      try {
        log.info("🎯[Swift] Calling getAvailableSources with callback wrapper...");
        
        // Таймаут 3 секунды
        const timeout = setTimeout(() => {
          log.error("🎯[Swift] Timeout waiting for sources");
          reject(new Error('Timeout waiting for Swift sources'));
        }, 3000);
        
        // Пробуем вызвать метод
        const result = screenCaptureAddon.getAvailableSources();
        
        // Если результат - это Promise
        if (result && typeof result.then === 'function') {
          log.info("🎯[Swift] Method returned a Promise");
          result
            .then((sources: any) => {
              clearTimeout(timeout);
              log.info(`🎯[Swift] Promise resolved with ${sources?.length || 0} sources`);
              resolve(sources || []);
            })
            .catch((err: any) => {
              clearTimeout(timeout);
              log.error(`🎯[Swift] Promise rejected: ${err}`);
              reject(err);
            });
        } 
        // Если результат синхронный
        else if (result !== undefined) {
          clearTimeout(timeout);
          log.info(`🎯[Swift] Synchronous result: ${JSON.stringify(result)}`);
          resolve(Array.isArray(result) ? result : []);
        }
        // Если метод ничего не вернул, возможно он использует колбэк
        else {
          log.info("🎯[Swift] No immediate result, method might use callbacks");
          // Ждём таймаут
        }
        
      } catch (error: any) {
        log.error(`🎯[Swift] Error calling method: ${error.message}`);
        reject(error);
      }
    });
  }

  // Обработчик для тестирования Swift addon отдельно
  ipcMain.handle("get-swift-sources-direct", async () => {
    try {
      log.info("🎯[Swift] Testing Swift addon directly...");
      
      const sources = await getSwiftSourcesSafe();
      log.info(`🎯[Swift] Got ${sources.length} sources`);
      
      // Форматируем для Electron
      const formatted = sources.map((source: any, index: number) => ({
        id: `swift:${source.id || index}`,
        name: source.name || `Source ${index}`,
        thumbnail: {
          dataUrl: createSwiftSourceThumbnail(source)
        }
      }));
      
      return { success: true, sources: formatted };
      
    } catch (error: any) {
      log.error(`🎯[Swift] Error: ${error.message}`);
      return { success: false, error: error.message, sources: [] };
    }
  });


  // КРИТИЧНО: Обработчик get-desktop-sources БЕЗ диалога
  async function testSwiftAddon(): Promise<void> {
    log.info("🔬[Swift Test] Starting Swift addon test...");
    
    if (!screenCaptureAddon) {
      log.error("🔬[Swift Test] screenCaptureAddon is null!");
      return;
    }
    
    // Логируем все доступные методы
    log.info("🔬[Swift Test] Available methods in screenCaptureAddon:");
    for (const key of Object.keys(screenCaptureAddon)) {
      const type = typeof screenCaptureAddon[key];
      log.info(`🔬[Swift Test]   - ${key}: ${type}`);
    }
    
    // Тестируем getAvailableSources разными способами
    if (typeof screenCaptureAddon.getAvailableSources === 'function') {
      log.info("🔬[Swift Test] Testing getAvailableSources...");
      
      // Способ 1: Прямой вызов
      try {
        log.info("🔬[Swift Test] Method 1: Direct call");
        const result1 = screenCaptureAddon.getAvailableSources();
        log.info(`🔬[Swift Test] Direct call returned: ${JSON.stringify(result1)}`);
        log.info(`🔬[Swift Test] Type: ${typeof result1}, isArray: ${Array.isArray(result1)}`);
        
        // Если это Promise
        if (result1 && typeof result1.then === 'function') {
          log.info("🔬[Swift Test] It's a Promise, waiting...");
          const resolved = await result1;
          log.info(`🔬[Swift Test] Promise resolved to: ${JSON.stringify(resolved)}`);
        }
      } catch (e: any) {
        log.error(`🔬[Swift Test] Direct call error: ${e.message}`);
      }
      
      // Способ 2: С колбэком
      try {
        log.info("🔬[Swift Test] Method 2: With callback");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            log.warn("🔬[Swift Test] Callback timeout after 2s");
            resolve();
          }, 2000);
          
          screenCaptureAddon.getAvailableSources((error: any, sources: any) => {
            clearTimeout(timeout);
            if (error) {
              log.error(`🔬[Swift Test] Callback error: ${error}`);
            } else {
              log.info(`🔬[Swift Test] Callback sources: ${JSON.stringify(sources)}`);
            }
            resolve();
          });
        });
      } catch (e: any) {
        log.error(`🔬[Swift Test] Callback error: ${e.message}`);
      }
      
      // Способ 3: С параметрами
      try {
        log.info("🔬[Swift Test] Method 3: With empty object parameter");
        const result3 = screenCaptureAddon.getAvailableSources({});
        log.info(`🔬[Swift Test] With params returned: ${JSON.stringify(result3)}`);
      } catch (e: any) {
        log.error(`🔬[Swift Test] With params error: ${e.message}`);
      }
    }
    
    // Проверяем другие возможные методы
    const methodsToTest = ['getSources', 'listSources', 'getScreens', 'getWindows', 'getCaptureList'];
    for (const method of methodsToTest) {
      if (typeof screenCaptureAddon[method] === 'function') {
        log.info(`🔬[Swift Test] Found method: ${method}, testing...`);
        try {
          const result = screenCaptureAddon[method]();
          log.info(`🔬[Swift Test] ${method} returned: ${JSON.stringify(result)}`);
        } catch (e: any) {
          log.error(`🔬[Swift Test] ${method} error: ${e.message}`);
        }
      }
    }
    
    log.info("🔬[Swift Test] Test complete!");
  }

  // Вызываем тест при загрузке
  setTimeout(() => {
    testSwiftAddon().catch(err => log.error(`🔬[Swift Test] Fatal error: ${err}`));
  }, 3000);

  // Обновленный обработчик get-desktop-sources с дополнительным логированием
  // В index.ts замените обработчик get-desktop-sources на этот:

  ipcMain.handle("get-desktop-sources", async () => {
    try {
      log.info("🎯[NativeCapture] ========== GETTING SOURCES (SWIFT ONLY) ==========");
      
      if (!screenCaptureAddon) {
        log.error("🎯[NativeCapture] screenCaptureAddon is NULL!");
        return [];
      }
      
      log.info(`🎯[NativeCapture] screenCaptureAddon type: ${typeof screenCaptureAddon}`);
      log.info(`🎯[NativeCapture] Available methods: ${Object.keys(screenCaptureAddon).join(', ')}`);
      
      if (typeof screenCaptureAddon.getAvailableSources !== 'function') {
        log.error("🎯[NativeCapture] getAvailableSources is not a function!");
        return [];
      }
      
      // Пробуем разные способы вызова
      log.info("🎯[NativeCapture] Calling getAvailableSources...");
      
      // Способ 1: Прямой вызов без параметров
      try {
        const result = screenCaptureAddon.getAvailableSources();
        log.info(`🎯[NativeCapture] Direct call result type: ${typeof result}`);
        log.info(`🎯[NativeCapture] Direct call result: ${JSON.stringify(result)}`);
        
        // Если это массив - отлично!
        if (Array.isArray(result)) {
          log.info(`🎯[NativeCapture] ✅ Got array with ${result.length} sources`);
          return formatSwiftSources(result);
        }
        
        // Если это объект с полем sources
        if (result && typeof result === 'object' && 'sources' in result) {
          log.info(`🎯[NativeCapture] Got object with sources field`);
          return formatSwiftSources(result.sources);
        }
        
        // Если это Promise
        if (result && typeof result.then === 'function') {
          log.info("🎯[NativeCapture] Got Promise, waiting...");
          const promiseResult = await result;
          log.info(`🎯[NativeCapture] Promise resolved to: ${JSON.stringify(promiseResult)}`);
          
          if (Array.isArray(promiseResult)) {
            return formatSwiftSources(promiseResult);
          }
        }
        
        // Если это пустой объект {} - значит метод асинхронный с колбэком
        if (result && typeof result === 'object' && Object.keys(result).length === 0) {
          log.info("🎯[NativeCapture] Got empty object, trying callback approach...");
          
          // Способ 2: С колбэком
          const callbackResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              log.error("🎯[NativeCapture] Callback timeout!");
              reject(new Error('Callback timeout'));
            }, 3000);
            
            try {
              // Пробуем с колбэком
              screenCaptureAddon.getAvailableSources((error: any, sources: any) => {
                clearTimeout(timeout);
                log.info(`🎯[NativeCapture] Callback called! error=${error}, sources=${JSON.stringify(sources)}`);
                
                if (error) {
                  reject(error);
                } else {
                  resolve(sources);
                }
              });
            } catch (e: any) {
              clearTimeout(timeout);
              log.error(`🎯[NativeCapture] Callback call error: ${e.message}`);
              reject(e);
            }
          });
          
          log.info(`🎯[NativeCapture] Callback result: ${JSON.stringify(callbackResult)}`);
          if (Array.isArray(callbackResult)) {
            return formatSwiftSources(callbackResult);
          }
        }
        
      } catch (error: any) {
        log.error(`🎯[NativeCapture] Error: ${error.message}`);
        log.error(`🎯[NativeCapture] Stack: ${error.stack}`);
      }
      
      // Если ничего не сработало, возвращаем тестовый источник
      log.warn("🎯[NativeCapture] Swift failed, returning test source");
      return [{
        id: 'test:1',
        name: 'Test Source (Swift not working)',
        thumbnail: {
          dataUrl: createSwiftSourceThumbnail({ type: 'window', name: 'Test' })
        }
      }];
      
    } catch (error: any) {
      log.error(`🎯[NativeCapture] ❌ Critical error: ${error.message}`);
      return [];
    }
  });

  ipcMain.on("broadcast-desktop-sources", (event, sources) => {
    log.info(`🎯[NativeCapture] Broadcasting ${sources.length} sources to all webContents`);
    
    // Отправляем всем webContents
    webContents.getAllWebContents().forEach(content => {
      // Не отправляем обратно отправителю
      if (content.id !== event.sender.id) {
        content.send("desktop-sources-response", {
          sources: sources,
          error: null
        });
        log.info(`🎯[NativeCapture] Sent to webContents ${content.id}`);
      }
    });
  });

  // Функция форматирования Swift источников
  function formatSwiftSources(sources: any[]): any[] {
    if (!Array.isArray(sources)) {
      log.warn(`🎯[NativeCapture] formatSwiftSources: not an array: ${typeof sources}`);
      return [];
    }
    
    log.info(`🎯[NativeCapture] Formatting ${sources.length} Swift sources`);
    
    return sources.map((source: any, index: number) => {
      log.info(`🎯[NativeCapture] Source ${index}: ${JSON.stringify(source)}`);
      
      return {
        id: source.id || `swift:${index}`,
        name: source.name || `Source ${index}`,
        thumbnail: {
          dataUrl: createSwiftSourceThumbnail(source)
        }
      };
    });
  }

  // Добавьте обработчик для тестирования Swift напрямую
  ipcMain.handle("test-swift-direct", async () => {
    log.info("🧪[Swift] Direct test starting...");
    
    if (!screenCaptureAddon) {
      return { error: "Addon not loaded" };
    }
    
    const results: any = {};
    
    // Тест 1: Прямой вызов
    try {
      results.direct = screenCaptureAddon.getAvailableSources();
    } catch (e: any) {
      results.direct = `Error: ${e.message}`;
    }
    
    // Тест 2: С пустым объектом
    try {
      results.withEmptyObject = screenCaptureAddon.getAvailableSources({});
    } catch (e: any) {
      results.withEmptyObject = `Error: ${e.message}`;
    }
    
    // Тест 3: С options
    try {
      results.withOptions = screenCaptureAddon.getAvailableSources({
        types: ['screen', 'window']
      });
    } catch (e: any) {
      results.withOptions = `Error: ${e.message}`;
    }
    
    // Тест 4: Проверка других методов
    results.allMethods = Object.keys(screenCaptureAddon).filter(key => 
      typeof screenCaptureAddon[key] === 'function'
    );
    
    // Тест 5: testMethod
    try {
      results.testMethod = screenCaptureAddon.testMethod();
    } catch (e: any) {
      results.testMethod = `Error: ${e.message}`;
    }
    
    log.info(`🧪[Swift] Test results: ${JSON.stringify(results, null, 2)}`);
    return results;
  });

  ipcMain.handle("get-swift-sources-test", async () => {
    try {
      const sources = await getAvailableSources();
      return { success: true, sources };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Обработчик для диалога выбора
  ipcMain.handle("show-native-capture-choice", async () => {
    log.info("🎯[NativeCapture] show-native-capture-choice called");
    
    // Проверяем, что mainWindow уже создан
    if (!mainWindow) {
      log.error("🎯[NativeCapture] mainWindow not created yet!");
      return 'standard';
    }
    
    const { dialog } = require('electron');
    
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Выбор метода захвата экрана',
      message: 'Выберите метод захвата экрана:',
      detail: '🎯 Native Capture:\n• Захват только звука выбранного приложения\n• Нет эха и обратной связи\n• Высокое качество\n\n📺 Стандартный:\n• Обычный захват экрана Electron\n• Захват всего системного звука',
      buttons: ['🎯 Native Capture', '📺 Стандартный'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    
    const choice = result.response === 0 ? 'native' : 'standard';
    log.info(`🎯[NativeCapture] User selected: ${choice}`);
    
    return choice;
  });

  ipcMain.handle("get-native-sources", async () => {
    try {
      log.info("🎯[NativeCapture] Requesting native sources via get-native-sources");

      if (!screenCaptureAddon) {
        throw new Error("Native addon not loaded");
      }

      if (typeof screenCaptureAddon.getSources !== 'function') {
        log.error("🎯[NativeCapture] getSources is not a function");
        throw new Error("getSources not found in native addon");
      }

      const sources = await screenCaptureAddon.getSources();
      log.info(`🎯[NativeCapture] Successfully retrieved ${sources.length} native sources`);
      
      return sources;
    } catch (error) {
      log.error("🎯[NativeCapture] Failed to get native sources:", error);
      throw error;
    }
  });

  // Native capture handlers
  if (screenCaptureAddon) {
    ipcMain.handle("start-native-capture-simple", async () => {
      try {
        log.info("🎯[NativeCapture] Starting native capture...");
        const result = await screenCaptureAddon.startCapture({
          frameRate: 30,
          enableAppSpecificAudio: true
        });
        log.info("🎯[NativeCapture] Native capture started");
        return { success: true, result: "Native capture started" };
      } catch (error) {
        log.error(`🎯[NativeCapture] Native capture failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("stop-native-capture-simple", async () => {
      try {
        log.info("🎯[NativeCapture] Stopping native capture...");
        const result = await screenCaptureAddon.stopCapture();
        return { success: true, result: "Native capture stopped" };
      } catch (error) {
        log.error(`🎯[NativeCapture] Stop failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    });
  }

  ipcMain.on("focus-app", () => {
    mainWindow.show();
  });

  ipcMain.on("quit-app", () => {
    log.info("Main: Получено событие quit-app, закрытие приложения...");
    isQuitting = true;
    app.quit();
  });

  ipcMain.on("reload-full-app", () => {
    mainWindow.reload();
    send(page, "destroytray");
  });

  ipcMain.on("forward-message", (event, channel, ...args) => {
    log.info(`Main: Получено forward-message с каналом: ${channel}`);
    webContents.getAllWebContents().forEach(content => {
      content.send("forward-message", channel, ...args);
    });
  });

  // Обработчик jitsi-log-event
  ipcMain.on('jitsi-log-event', (event, logData) => {
    log.info(`Jitsi Log [${logData.level}]: ${logData.message}`);
    console.log(`Jitsi Log [${logData.level}]: ${logData.message}`);
  });


  ipcMain.on("preload-log", (event, message: string) => {
    log.info(`Preload Log: ${message}`);
    console.log(`Preload Log: ${message}`);
  });

  // Обработчик для установки горячей клавиши микрофона
  ipcMain.on("walkie-talkie-status", (event, status: unknown) => {
    log.info(`Main: Получено событие walkie-talkie-status: ${JSON.stringify(status)}`);
    if (typeof status !== "object" || status === null || !("enabled" in status) || !("key" in status)) {
      log.error(`Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`);
      return;
    }
  
    const { enabled, key: rawKey } = status as WalkieTalkieStatus;
    if (typeof enabled !== "boolean" || typeof rawKey !== "string") {
      log.error(`Main: Некорректные типы в walkie-talkie-status: enabled=${typeof enabled}, key=${typeof rawKey}`);
      return;
    }
  
    // Игнорируем пустые или некорректные ключи
    if (!rawKey || rawKey.trim() === '') {
      log.warn(`Main: Пустой или некорректный ключ: ${rawKey}`);
      return;
    }
  
    if (currentHotkey) {
      keyboard.stopListener();
      log.info(`Main: Остановлен node-global-key-listener для предыдущей клавиши: ${currentHotkey}`);
    }
  
    const key = normalizeKey(rawKey);
    log.info(`Main: Преобразован ключ из ${rawKey} в ${key}`);
  
    const validAccelerators = /^[a-z0-9]+$/;
    const validCombo = /^((ctrl|alt|shift|meta)\+)+[a-z0-9]+$/i;
    if (!validAccelerators.test(key) && !validCombo.test(key)) {
      log.error(`Main: Некорректный формат горячей клавиши: ${key}`);
      return;
    }
  
    currentHotkey = key;
    log.info(`Main: Установка горячей клавиши микрофона: ${key}`);
  
    keyboard.startListener().then(() => {
      log.info(`Main: node-global-key-listener запущен для клавиши: ${key}`);
    }).catch(err => {
      log.error(`Main: Ошибка запуска node-global-key-listener: ${err}`);
    });
  
    keyboard.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
      const parts = key.split('+').map(p => p.toLowerCase());
      const mainKey = parts.pop()!;
      
      log.info(`Main: символ: ${e.name}`);
      log.info(`Main: код: ${e.vKey}`);
      const pressedKeyName = vKeyToName[e.vKey] || '';
  
      // Проверяем, является ли pressedKeyName допустимым ключом
      if (!(pressedKeyName in down)) {
        return;
      }
  
      // Преобразуем mainKey в верхний регистр для соответствия IGlobalKeyDownMap
      const normalizedMainKey = mainKey.toUpperCase() as KeyName;
  
      if (pressedKeyName !== normalizedMainKey) {
        return;
      }
      log.info(`Main: проверка: ${down[pressedKeyName]}`);
      if (down[pressedKeyName]) {
        log.info(`Main: Нажата горячая клавиша: ${key}`);
  
        const allWebContents = webContents.getAllWebContents();
        const activeWebContents = allWebContents.find((content) => {
          const url = content.getURL();
          log.info(`Main: Проверка WebContents URL: ${url}, ID: ${content.id}`);
          return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
        });
  
        if (!activeWebContents) {
          log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru");
          return;
        }
  
        log.info(`Main: Выбран WebContents ID: ${activeWebContents.id}, URL: ${activeWebContents.getURL()}`);
        log.info(`Main: Микрофон переключен в состояние: ${true}`);
        activeWebContents.send("toggle-walkie-talkie", true);
      } else {
        log.info(`Main: Отпущена горячая клавиша: ${key}`);
        const allWebContents = webContents.getAllWebContents();
          const activeWebContents = allWebContents.find((content) => {
            const url = content.getURL();
            log.info(`Main: Проверка WebContents URL (отпускание): ${url}, ID: ${content.id}`);
            return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
          });
  
          if (!activeWebContents) {
            log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru (отпускание)");
            return;
          }
          log.info(`Main: Микрофон восстановлен в состояние: ${false}`);
          activeWebContents.send("toggle-walkie-talkie", false);
      }
    });
  });

  ipcMain.handle("test-swift-addon", async () => {
    log.info("🧪[TEST] Testing Swift addon directly...");
    
    const result: any = {
      addonLoaded: !!screenCaptureAddon,
      methods: [],
      testResults: {}
    };
    
    if (screenCaptureAddon) {
      // Получаем список методов
      result.methods = Object.keys(screenCaptureAddon).filter(key => 
        typeof screenCaptureAddon[key] === 'function'
      );
      
      log.info(`🧪[TEST] Available methods: ${result.methods.join(', ')}`);
      
      // Тестируем testMethod
      if (typeof screenCaptureAddon.testMethod === 'function') {
        try {
          result.testResults.testMethod = screenCaptureAddon.testMethod();
          log.info(`🧪[TEST] testMethod result: ${result.testResults.testMethod}`);
        } catch (e: any) {
          result.testResults.testMethod = `Error: ${e.message}`;
        }
      }
      
      // Тестируем getAvailableSources с разными вариантами
      if (typeof screenCaptureAddon.getAvailableSources === 'function') {
        try {
          log.info("🧪[TEST] Calling getAvailableSources()...");
          
          // Пробуем без параметров
          const sources1 = await screenCaptureAddon.getAvailableSources();
          result.testResults.getAvailableSourcesNoParams = {
            success: true,
            result: sources1,
            type: typeof sources1,
            isArray: Array.isArray(sources1),
            count: Array.isArray(sources1) ? sources1.length : 'N/A'
          };
          
          log.info(`🧪[TEST] Result without params: ${JSON.stringify(result.testResults.getAvailableSourcesNoParams)}`);
          
        } catch (e: any) {
          result.testResults.getAvailableSourcesNoParams = {
            success: false,
            error: e.message,
            stack: e.stack
          };
        }
        
        // Пробуем с колбэком (если поддерживается)
        try {
          log.info("🧪[TEST] Trying with callback...");
          const callbackResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Callback timeout')), 3000);
            
            screenCaptureAddon.getAvailableSources((error: any, sources: any) => {
              clearTimeout(timeout);
              if (error) {
                reject(error);
              } else {
                resolve(sources);
              }
            });
          });
          
          result.testResults.getAvailableSourcesCallback = {
            success: true,
            result: callbackResult
          };
        } catch (e: any) {
          result.testResults.getAvailableSourcesCallback = {
            success: false,
            error: e.message
          };
        }
      }
      
      // Проверяем другие возможные методы
      const possibleMethods = ['getSources', 'listSources', 'getScreens', 'getWindows'];
      for (const method of possibleMethods) {
        if (typeof screenCaptureAddon[method] === 'function') {
          try {
            const methodResult = await screenCaptureAddon[method]();
            result.testResults[method] = {
              success: true,
              result: methodResult
            };
            log.info(`🧪[TEST] ${method} found and returned: ${JSON.stringify(methodResult)}`);
          } catch (e: any) {
            result.testResults[method] = {
              success: false,
              error: e.message
            };
          }
        }
      }
    }
    
    log.info(`🧪[TEST] Complete test results: ${JSON.stringify(result, null, 2)}`);
    return result;
  });

  log.info("🎯[NativeCapture] All IPC handlers registered");

  // После регистрации всех IPC обработчиков добавьте:
  log.info("🎯[NativeCapture] Проверка зарегистрированных обработчиков:");
  log.info(`🎯[NativeCapture] get-desktop-sources: ${ipcMain.listenerCount('get-desktop-sources') > 0 ? '✅' : '❌'}`);
  log.info(`🎯[NativeCapture] get-server-settings: ${ipcMain.listenerCount('get-server-settings') > 0 ? '✅' : '❌'}`);


  if (process.env.GDK_BACKEND !== GDK_BACKEND) {
    console.warn(
      "Возвращаем GDK_BACKEND для обхода проблемы https://github.com/electron/electron/issues/28436",
    );
    if (GDK_BACKEND === undefined) {
      delete process.env.GDK_BACKEND;
    } else {
      process.env.GDK_BACKEND = GDK_BACKEND;
    }
  }

  app.setAppUserModelId("org.rm.rm-electron");
  remoteMain.initialize();

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
    }
  });

  

  mainWindow = await createMainWindow();
  console.log("✅ Окно создано!");

  // Кэш для thumbnails
  let thumbnailCache: { [key: string]: { dataUrl: string; timestamp: number } } = {};
  const CACHE_TIMEOUT = 0.1 * 1000; // 1 секунд
  const DEFAULT_THUMBNAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4AQAA/QGOrDGjAAAAAElFTkSuQmCC";

  if (process.platform !== "darwin") {
    const shouldHideMenu = ConfigUtil.getConfigItem("autoHideMenubar", false);
    mainWindow.autoHideMenuBar = shouldHideMenu;
    mainWindow.setMenuBarVisibility(!shouldHideMenu);
  }

  const page = mainWindow.webContents;

  page.on("dom-ready", () => {
    if (ConfigUtil.getConfigItem("startMinimized", false)) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  page.once("did-frame-finish-load", () => {
    if (ConfigUtil.getConfigItem("autoUpdate", true)) {
      appUpdater().catch((error) => {
        log.error("Ошибка при проверке обновлений:", error);
      });
    }
  });

})();


function createNativeThumbnail(): string {
  const svg = `
    <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="300" fill="#2196F3"/>
      <text x="150" y="150" font-family="Arial" font-size="24" text-anchor="middle" fill="white">
        🎯 Native Capture Active
      </text>
    </svg>
  `;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Обновленный диалог (если еще не добавлен)
async function showNativeCaptureDialog(): Promise<'native' | 'standard'> {
  return new Promise((resolve) => {
    const { dialog } = require('electron');
    
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Выбор метода захвата экрана',
      message: 'Выберите метод захвата экрана:',
      detail: '🎯 Native: Захват с изоляцией звука приложения\n📺 Standard: Обычный захват экрана Electron',
      buttons: ['🎯 Native Capture', '📺 Стандартный'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(result => {
      const choice = result.response === 0 ? 'native' : 'standard';
      log.info(`🎯[NativeCapture] Пользователь выбрал: ${choice}`);
      resolve(choice);
    }).catch((error) => {
      log.error(`🎯[NativeCapture] Ошибка диалога: ${error.message}`);
      resolve('standard');
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  // Очищаем горячую клавишу при выходе
  if (currentHotkey) {
    keyboard.stopListener();
    log.info(`Main: Горячая клавиша ${currentHotkey} удалена при выходе`);
  }
});

autoUpdater.on("checking-for-update", () => {
  log.info("Проверка обновлений...");
});

autoUpdater.on("update-available", (info) => {
  log.info(`Доступно обновление: v${info.version}`);
  mainWindow?.webContents.send("update_available", info.version);
});

autoUpdater.on("update-not-available", () => {
  log.info("Обновлений нет.");
});

autoUpdater.on("download-progress", (progress) => {
  log.info(`Прогресс загрузки: ${progress.percent}%`);
  mainWindow?.webContents.send("update_progress", progress.percent);
});

autoUpdater.on("update-downloaded", () => {
  log.info("Обновление загружено.");
  mainWindow?.webContents.send("update_downloaded");
});

autoUpdater.on("error", (err) => {
  log.error("Ошибка обновления:", err);
  mainWindow?.webContents.send("update_error", err.message);
});

ipcMain.on("restart_app", () => {
  autoUpdater.quitAndInstall();
});

process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});

// Вспомогательные функции
function createSourceThumbnail(source: any): string {
  // Разные цвета для разных типов
  const colors = {
    display: '#4CAF50',
    screen: '#4CAF50',
    window: '#2196F3',
    tab: '#FF9800',
    browser_tab: '#FF9800',
    unknown: '#9E9E9E'
  };
  
  const color = colors[source.type] || colors.unknown;
  
  // Разные иконки для разных типов
  const icons = {
    display: '🖥',
    screen: '🖥',
    window: '🪟',
    tab: '🌐',
    browser_tab: '🌐',
    unknown: '❓'
  };
  
  const icon = icons[source.type] || icons.unknown;
  
  const svg = `
    <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="300" fill="${color}"/>
      <text x="150" y="100" font-size="50" text-anchor="middle">${icon}</text>
      <text x="150" y="160" font-family="Arial" font-size="14" text-anchor="middle" fill="white">
        ${source.name || 'Unknown'}
      </text>
      <text x="150" y="185" font-family="Arial" font-size="11" text-anchor="middle" fill="white" opacity="0.8">
        ${source.appName || source.type || 'Unknown Type'}
      </text>
      <text x="150" y="210" font-family="Arial" font-size="10" text-anchor="middle" fill="white" opacity="0.6">
        ID: ${source.id}
      </text>
    </svg>
  `;
  
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function formatSourceName(source: any): string {
  // Форматируем имя в зависимости от типа
  if (source.type === 'tab' || source.type === 'browser_tab') {
    return `🌐 ${source.name}`;
  } else if (source.type === 'display' || source.type === 'screen') {
    return `🖥 ${source.name || 'Display'}`;
  } else if (source.appName) {
    return `${source.name} - ${source.appName}`;
  }
  
  return source.name || `${source.type} ${source.id}`;
}



async function getAvailableSources(): Promise<Electron.DesktopCapturerSource[]> {
  log.info("🎯[NativeCapture] Fetching available sources...");

  // 1. Попробуем нативный способ
  if (screenCaptureAddon && typeof screenCaptureAddon.getSources === 'function') {
    try {
      const sources = await screenCaptureAddon.getSources();
      log.info(`🎯[NativeCapture] Swift returned ${sources.length} sources`);
      return sources;
    } catch (error) {
      log.error("🎯[NativeCapture] Error from native getSources:", error);
    }
  }

  // 2. Fallback на Electron
  log.info("🎯[NativeCapture] Using Electron desktopCapturer fallback");
  return desktopCapturer.getSources({ types: ['screen', 'window'] });
}

setTimeout(() => {
  const testBtn = document.createElement('button');
  testBtn.innerHTML = '🧪 Test Swift Addon';
  testBtn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    padding: 10px 20px;
    background: #ff5722;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
  `;
  
  testBtn.onclick = async () => {
    try {
      console.log('🧪 Testing Swift addon...');
      testBtn.disabled = true;
      testBtn.innerHTML = '⏳ Testing...';
      
      const result = await ipcRenderer.invoke('test-swift-addon');
      console.log('🧪 Test results:', result);
      
      // Показываем результаты в алерте
      const summary = `
Swift Addon Test Results:
========================
Addon Loaded: ${result.addonLoaded}
Methods Found: ${result.methods.join(', ')}

Test Results:
${Object.entries(result.testResults).map(([key, value]: [string, any]) => 
  `${key}: ${value.success ? '✅ Success' : '❌ Failed'} ${value.error || ''}`
).join('\n')}

Check console for full details.
      `;
      
      alert(summary);
      
    } catch (err: any) {
      console.error('Test error:', err);
      alert(`Test failed: ${err.message}`);
    } finally {
      testBtn.disabled = false;
      testBtn.innerHTML = '🧪 Test Swift Addon';
    }
  };
  
  document.body.appendChild(testBtn);
}, 2000);
