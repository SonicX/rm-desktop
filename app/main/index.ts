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
const { setupScreenSharingMain } = require('@jitsi/electron-sdk');



// const { JitsiMeetElectron } = require('@jitsi/electron-sdk');

// Глобальная переменная для Jitsi окна

let JitsiMeetElectron: any;
try {
    const jitsiModule = require('@jitsi/electron-sdk');
    JitsiMeetElectron = jitsiModule.default || jitsiModule.JitsiMeetElectron || jitsiModule;
    log.info(`🎯[Jitsi SDK] Module loaded:`, typeof JitsiMeetElectron);
} catch (error: any) {
    log.error(`🎯[Jitsi SDK] Failed to load module:`, error.message);
}

const JWT_SECRET = "HguV/8QBrJdCih2Ycpoz0g5q5m85apT3Nu6E+lDvufg=";
        

let jitsiWindow: BrowserWindow | null = null;



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
            webviewTag: true,
            nodeIntegration: false,
            contextIsolation: true
        },
        show: false,
        backgroundColor: '#333',
    });

    remoteMain.enable(win.webContents);

    // КРИТИЧНО: Устанавливаем preload для ВСЕХ webContents включая Zulip
    win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
        log.info(`Main: WebView создается с URL: ${params.src}`);
        
        // ИСПРАВЛЕНИЕ: Устанавливаем preload для всех webview
        const preloadPath = path.join(bundlePath, "preload.js");
        webPreferences.preload = preloadPath;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        
        // КРИТИЧНО: Добавляем для Zulip
        if (params.src && params.src.includes('joinrm-svz')) {
            log.info(`Main: Устанавливаем preload для Zulip: ${preloadPath}`);
            webPreferences.preload = preloadPath;
        }
        
        log.info(`Main: Webview preload установлен: ${preloadPath}`);
    });

    // НОВОЕ: Слушаем создание новых webContents
    app.on('web-contents-created', (event, contents) => {
      contents.on('console-message', (event, level, message, line, sourceId) => {
          if (message.includes('[NativeCapture]') || message.includes('[electron_bridge]')) {
              log.info(`Jitsi Console: ${message}`);
          }
      });
      
      // Слушаем IPC сообщения через executeJavaScript bridge
      contents.on('did-finish-load', () => {
          const url = contents.getURL();
          
          // Если это Jitsi окно
          if (url && url.includes('jitsi')) {
              contents.executeJavaScript(`
                  window.addEventListener('message', (event) => {
                      if (event.data.type === 'ELECTRON_BRIDGE_EVENT') {
                          // Пересылаем в main process через console.log с маркером
                          console.log('[ELECTRON_BRIDGE_FORWARD]' + JSON.stringify(event.data));
                      }
                  });
              `);
          }
      });
  });

    const mainHtmlPath = path.join(__dirname, 'app/renderer/main.html');
    const mainUrl = `file://${mainHtmlPath}`;

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

  win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
    log.info(`Main: WebView создается с URL: ${params.src}`);
    
    // ВАЖНО: Устанавливаем правильный preload для webview
    const preloadPath = path.join(bundlePath, "preload.js");
    webPreferences.preload = preloadPath;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    
    log.info(`Main: Webview preload установлен: ${preloadPath}`);
    log.info(`Main: Preload файл существует: ${require('fs').existsSync(preloadPath)}`);
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

  let currentNativeCaptureId: string | null = null;
  let isNativeCapturing: boolean = false;
  let nativeVideoFrames: ArrayBuffer[] = [];
  let nativeAudioFrames: ArrayBuffer[] = [];
  let frameCollectionInterval: NodeJS.Timeout | null = null;

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

  // Функция для форматирования источников из Swift в формат Electron
  function formatNativeSourcesForElectron(nativeSources: any[]): Electron.DesktopCapturerSource[] {
    return nativeSources.map((source, index) => {
      // Определяем тип и префикс
      const sourceType = (source.type || 'screen').toString().toLowerCase();
      const prefix = sourceType === 'window' || sourceType === 'application' ? 'window:' : 'screen:';
      
      // Формируем ID в формате Electron
      const formattedId = `${prefix}${source.id || index}:0`;
      
      // Создаем thumbnail (простая заглушка или SVG)
      const thumbnail = createSourceThumbnail(source);
      
      return {
        id: formattedId,
        name: source.name || `Source ${index + 1}`,
        thumbnail: {
          dataUrl: thumbnail
        },
        display_id: '', // Electron compatibility
        appIcon: null   // Electron compatibility
      } as any;
    });
  }

  // Функция создания thumbnail для источника
  function createSourceThumbnail(source: any): string {
    const colors: { [key: string]: string } = {
      screen: '#4CAF50',
      display: '#4CAF50', 
      window: '#2196F3',
      application: '#FF9800'
    };
    
    const color = colors[source.type] || '#9E9E9E';
    const icon = source.type === 'screen' || source.type === 'display' ? '🖥️' : '🪟';
    
    const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="200" fill="${color}"/>
      <text x="150" y="80" font-size="50" text-anchor="middle" fill="white">${icon}</text>
      <text x="150" y="130" font-size="16" text-anchor="middle" fill="white" font-weight="bold">
        ${(source.name || 'Unknown').replace(/[<>&"']/g, '')}
      </text>
      ${source.appName ? `
        <text x="150" y="155" font-size="14" text-anchor="middle" fill="white" opacity="0.9">
          ${source.appName.replace(/[<>&"']/g, '')}
        </text>
      ` : ''}
      <rect x="20" y="180" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
      <rect x="20" y="180" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
    </svg>`;
    
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
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

  async function injectJitsiScreenShareHandler(jitsiWindow) {
      const injectionCode = `
      (async function() {
          console.log('[NativeCapture] Installing improved screen share handler...');
          
          // Состояние
          let pendingSourcesCallback = null;
          let isWaitingForSources = false;
          let autoShareBlocked = false;
          
          // КРИТИЧНО: Блокируем автоматический запуск демонстрации
          const originalExecuteCommand = window.APP?.conference?.executeCommand;
          if (originalExecuteCommand) {
              window.APP.conference.executeCommand = function(command, ...args) {
                  if (command === 'toggleScreenSharing' && !autoShareBlocked) {
                      console.log('[NativeCapture] Blocking auto screen share');
                      autoShareBlocked = true;
                      return; // Блокируем первый автоматический вызов
                  }
                  return originalExecuteCommand.call(this, command, ...args);
              };
          }
          
          // Перехватываем JitsiMeetScreenObtainer
          if (window.JitsiMeetScreenObtainer) {
              console.log('[NativeCapture] Patching JitsiMeetScreenObtainer...');
              
              const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
              
              window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                  console.log('[NativeCapture] openDesktopPicker intercepted');
                  
                  // Предотвращаем множественные запросы
                  if (isWaitingForSources) {
                      console.log('[NativeCapture] Already waiting for sources, skipping');
                      return;
                  }
                  
                  isWaitingForSources = true;
                  pendingSourcesCallback = callback;
                  
                  // Создаем electron_bridge если его нет
                  if (!window.electron_bridge) {
                      window.electron_bridge = {
                          events: new Map(),
                          send_event: function(eventName, data) {
                              console.log('[electron_bridge] Sending:', eventName);
                              // Отправляем через postMessage в main process
                              window.postMessage({
                                  type: 'ELECTRON_BRIDGE_EVENT',
                                  event: eventName,
                                  data: data
                              }, '*');
                          },
                          on_event: function(eventName, callback) {
                              if (!this.events.has(eventName)) {
                                  this.events.set(eventName, []);
                              }
                              this.events.get(eventName).push(callback);
                          },
                          emit_event: function(eventName, data) {
                              console.log('[electron_bridge] Emitting:', eventName);
                              if (this.events.has(eventName)) {
                                  this.events.get(eventName).forEach(cb => {
                                      try { cb(data); } catch (e) { console.error(e); }
                                  });
                              }
                          }
                      };
                      
                      // Слушаем postMessage для получения событий
                      window.addEventListener('message', (event) => {
                          if (event.data.type === 'ELECTRON_BRIDGE_RESPONSE') {
                              window.electron_bridge.emit_event(event.data.event, event.data.data);
                          }
                      });
                  }
                  
                  // Устанавливаем обработчик ответа ПЕРЕД запросом
                  const responseHandler = (response) => {
                      console.log('[NativeCapture] Got sources response:', response);
                      isWaitingForSources = false;
                      
                      if (response && response.sources && response.sources.length > 0) {
                          // Показываем диалог выбора источника
                          showSourcePicker(response.sources, (selectedId) => {
                              console.log('[NativeCapture] User selected:', selectedId);
                              
                              if (pendingSourcesCallback) {
                                  // Вызываем callback с выбранным источником
                                  pendingSourcesCallback(selectedId, {
                                      audio: true,
                                      screenShareAudio: true
                                  });
                                  pendingSourcesCallback = null;
                              }
                          });
                      } else {
                          console.error('[NativeCapture] No sources received');
                          // Fallback на оригинальный метод
                          originalOpenDesktopPicker.call(this, options, callback);
                      }
                  };
                  
                  // Регистрируем обработчик ОДИН РАЗ
                  window.electron_bridge.on_event('desktop-sources-response', responseHandler);
                  
                  // Запрашиваем источники
                  console.log('[NativeCapture] Requesting desktop sources...');
                  window.electron_bridge.send_event('requestDesktopSources', {});
                  
                  // Таймаут 5 секунд
                  setTimeout(() => {
                      if (isWaitingForSources) {
                          console.log('[NativeCapture] Timeout waiting for sources');
                          isWaitingForSources = false;
                          // Используем оригинальный picker
                          originalOpenDesktopPicker.call(this, options, callback);
                      }
                  }, 5000);
              };
          }
          
          // Функция показа диалога выбора источника
          function showSourcePicker(sources, callback) {
              console.log('[SourcePicker] Showing picker with', sources.length, 'sources');
              
              // ИСПРАВЛЕНО: Правильное определение типа
              let sourceType = 'unknown';
              
              if (sources && sources.length > 0) {
                  // Проверяем по первому источнику
                  const firstSource = sources[0];
                  
                  // Проверяем по нескольким признакам
                  if (firstSource.isNative === true) {
                      sourceType = 'native';
                  } else if (firstSource.isNative === false) {
                      sourceType = 'electron';
                  } else if (firstSource.id && firstSource.id.startsWith('native:')) {
                      sourceType = 'native';
                  } else if (firstSource.id && firstSource.id.startsWith('electron:')) {
                      sourceType = 'electron';
                  } else if (firstSource.name && firstSource.name.includes('🎯')) {
                      sourceType = 'native';
                  } else if (firstSource.name && firstSource.name.includes('📺')) {
                      sourceType = 'electron';
                  } else {
                      // Fallback проверка по формату ID
                      sourceType = firstSource.id.includes('window:') || firstSource.id.includes('screen:') 
                          ? 'electron' 
                          : 'unknown';
                  }
              }
              
              console.log('[SourcePicker] Detected source type:', sourceType);
              console.log('[SourcePicker] First source:', sources[0] ? {
                  id: sources[0].id,
                  name: sources[0].name,
                  isNative: sources[0].isNative
              } : 'no sources');
              
              // ... остальной код диалога ...
              
              // Показываем информационную панель с правильным типом
              let htmlContent = \`
                  <h2 style="margin-top: 0; color: #333;">
                      Выберите экран или окно
                  </h2>
                  <div style="
                      background: \${sourceType === 'native' ? '#e8f5e9' : '#e3f2fd'};
                      border-left: 4px solid \${sourceType === 'native' ? '#4CAF50' : '#2196F3'};
                      padding: 12px;
                      margin-bottom: 20px;
                      border-radius: 4px;
                  ">
                      <strong style="color: \${sourceType === 'native' ? '#2e7d32' : '#1565c0'};">
                          \${sourceType === 'native' 
                              ? '🎯 Native Addon активен' 
                              : sourceType === 'electron'
                                  ? '📺 Electron Capturer активен'
                                  : '❓ Неизвестный тип источника'}
                      </strong>
                      <div style="color: #666; font-size: 13px; margin-top: 4px;">
                          \${sourceType === 'native' 
                              ? 'Демонстрация с изоляцией звука приложения' 
                              : sourceType === 'electron'
                                  ? 'Стандартная демонстрация экрана'
                                  : 'Тип источника не определен'}
                      </div>
                  </div>
                  <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin: 20px 0;">
              \`;
              
              // ... остальной код ...
          }
          
          console.log('[NativeCapture] Handler installed successfully');
          return { success: true };
      })();
      `;
      
      try {
          const result = await jitsiWindow.webContents.executeJavaScript(injectionCode);
          log.info(`[NativeCapture] Injection result: ${JSON.stringify(result)}`);
      } catch (error) {
          log.error(`[NativeCapture] Injection error: ${error.message}`);
      }
  }

  // Функция сбора фреймов от native addon
  function startFrameCollection() {
    log.info("🎯[NativeCapture] Starting frame collection");
    
    // Сбор видео фреймов
    const collectVideoFrames = async () => {
      if (!isNativeCapturing || !screenCaptureAddon) return;
      
      try {
        const frame = await screenCaptureAddon.getVideoFrame();
        if (frame && frame.data) {
          // Сохраняем последние 10 фреймов
          nativeVideoFrames.push(frame.data);
          if (nativeVideoFrames.length > 10) {
            nativeVideoFrames.shift();
          }
        }
      } catch (error) {
        log.error(`🎯[NativeCapture] Error collecting video frame: ${error}`);
      }
      
      if (isNativeCapturing) {
        setTimeout(collectVideoFrames, 33); // ~30 FPS
      }
    };
    
    // Сбор аудио фреймов
    const collectAudioFrames = async () => {
      if (!isNativeCapturing || !screenCaptureAddon) return;
      
      try {
        const frame = await screenCaptureAddon.getAudioFrame();
        if (frame && frame.data) {
          // Сохраняем последние 20 аудио фреймов
          nativeAudioFrames.push(frame.data);
          if (nativeAudioFrames.length > 20) {
            nativeAudioFrames.shift();
          }
        }
      } catch (error) {
        log.error(`🎯[NativeCapture] Error collecting audio frame: ${error}`);
      }
      
      if (isNativeCapturing) {
        setTimeout(collectAudioFrames, 10); // ~100 раз в секунду для аудио
      }
    };
    
    // Запускаем сбор
    collectVideoFrames();
    collectAudioFrames();
  }

  // Полная функция createJitsiWindow с использованием стандартного Electron picker

  async function createJitsiWindow(options: {
      roomName: string;
      serverUrl?: string;
      displayName?: string;
      email?: string;
      avatarUrl?: string;
      jwt?: string;
  }): Promise<{ success: boolean; error?: string; roomName?: string; server?: string; fallbackNeeded?: boolean }> {
      try {
          const server = options.serverUrl || 'https://jitsi-connectrm.ru';
          const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
          const displayName = options.displayName || 'Guest';
          
          log.info(`🎯[Jitsi] Creating Jitsi window: ${server}/${roomName}`);
          
          // Закрываем предыдущее окно если есть
          if (jitsiWindow && !jitsiWindow.isDestroyed()) {
              jitsiWindow.close();
              jitsiWindow = null;
          }
          
          // Создаем окно
          jitsiWindow = new BrowserWindow({
              width: 1200,
              height: 800,
              minWidth: 800,
              minHeight: 600,
              title: `Конференция: ${roomName}`,
              icon: iconPath(),
              webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: false,
                  webSecurity: false,
                  partition: `jitsi-${Date.now()}`,
                  preload: path.join(bundlePath, "preload.js")
              },
              show: true,
              center: true
          });
          
          // URL конференции
          let conferenceUrl = `${server}/${roomName}`;
          
          // Query params (только jwt)
          const queryParams = new URLSearchParams();
          if (options.jwt) queryParams.append('jwt', options.jwt);
          if (queryParams.toString()) {
              conferenceUrl += '?' + queryParams.toString();
          }
          
          // Hash params для config и userInfo
          const hashParams = new URLSearchParams();
          hashParams.append('config.prejoinPageEnabled', 'false');
          hashParams.append('config.prejoinConfig.enabled', 'false');
          hashParams.append('config.startWithAudioMuted', 'false');
          hashParams.append('config.startWithVideoMuted', 'true');
          hashParams.append('config.enableWelcomePage', 'false');
          
          if (options.displayName) hashParams.append('userInfo.displayName', options.displayName);
          if (options.email) hashParams.append('userInfo.email', options.email);
          if (options.avatarUrl) hashParams.append('userInfo.avatar', options.avatarUrl);
          
          if (hashParams.toString()) {
              conferenceUrl += '#' + hashParams.toString();
          }
          
          log.info(`🎯[Jitsi Web] Loading URL: ${conferenceUrl}`);
          await jitsiWindow.loadURL(conferenceUrl);
          
          // ВАЖНО: Используем только ОДИН метод инжекции через setTimeout
          // Убираем did-finish-load чтобы не было конфликтов
          setTimeout(async () => {
              try {
                  log.info(`🎯[Jitsi] Starting injection into Jitsi window...`);
                  
                  // Сначала инжектируем базовую инфраструктуру electron_bridge
                  const bridgeResult = await jitsiWindow.webContents.executeJavaScript(`
                      (function() {
                          console.log('[Bridge] Installing electron_bridge...');
                          
                          if (!window.electron_bridge) {
                              window.electron_bridge = {
                                  events: new Map(),
                                  send_event: function(eventName, data) {
                                      console.log('[electron_bridge] Sending:', eventName, data);
                                      // Отправляем через postMessage в main process
                                      window.postMessage({
                                          type: 'ELECTRON_BRIDGE_EVENT',
                                          event: eventName,
                                          data: data
                                      }, '*');
                                  },
                                  on_event: function(eventName, callback) {
                                      console.log('[electron_bridge] Registering listener for:', eventName);
                                      if (!this.events.has(eventName)) {
                                          this.events.set(eventName, []);
                                      }
                                      this.events.get(eventName).push(callback);
                                  },
                                  emit_event: function(eventName, data) {
                                      console.log('[electron_bridge] Emitting:', eventName);
                                      if (this.events.has(eventName)) {
                                          this.events.get(eventName).forEach(cb => {
                                              try { cb(data); } catch (e) { console.error(e); }
                                          });
                                      }
                                  }
                              };
                              
                              // Слушаем ответы от main process
                              window.addEventListener('message', (event) => {
                                  if (event.data && event.data.type === 'ELECTRON_BRIDGE_RESPONSE') {
                                      window.electron_bridge.emit_event(event.data.event, event.data.data);
                                  }
                              });
                              
                              console.log('[Bridge] electron_bridge installed');
                          }
                          
                          return { bridgeInstalled: true };
                      })();
                  `);
                  
                  log.info(`🎯[Jitsi] Bridge result: ${JSON.stringify(bridgeResult)}`);
                  
                  // Теперь инжектируем основной обработчик
                  const injectionResult = await jitsiWindow.webContents.executeJavaScript(`
                    (async function() {
                        console.log('[NativeCapture] Installing screen share handler...');
                        
                        // Состояние
                        let pendingSourcesCallback = null;
                        let isWaitingForSources = false;
                        let currentNativeStream = null;
                        let currentNativeSourceId = null;
                        let isNativeCaptureActive = false;
                        let isFirstClick = true;
                        
                        // Ждем загрузки JitsiMeetScreenObtainer
                        function waitForJitsiAPI() {
                            return new Promise((resolve) => {
                                let attempts = 0;
                                const checkInterval = setInterval(() => {
                                    attempts++;
                                    if (window.JitsiMeetScreenObtainer) {
                                        clearInterval(checkInterval);
                                        console.log('[NativeCapture] JitsiMeetScreenObtainer found after', attempts, 'attempts');
                                        resolve(true);
                                    } else if (attempts > 50) {
                                        clearInterval(checkInterval);
                                        console.error('[NativeCapture] JitsiMeetScreenObtainer not found');
                                        resolve(false);
                                    }
                                }, 100);
                            });
                        }
                        
                        const jitsiReady = await waitForJitsiAPI();
                        
                        if (!jitsiReady) {
                            console.error('[NativeCapture] Jitsi API not ready, cannot install handler');
                            return { success: false, error: 'Jitsi API not ready' };
                        }
                        
                        // Перехватываем JitsiMeetScreenObtainer
                        const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                        const originalObtainStream = window.JitsiMeetScreenObtainer.obtainDesktopStream;
                        
                        window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                            console.log('[NativeCapture] openDesktopPicker intercepted');
                            
                            if (isFirstClick) {
                                isFirstClick = false;
                                if (window.APP && window.APP.conference) {
                                    try {
                                        const tracks = window.APP.conference.getLocalTracks();
                                        const desktopTrack = tracks.find(t => t.videoType === 'desktop');
                                        if (desktopTrack) {
                                            console.log('[NativeCapture] Stopping existing desktop track');
                                            window.APP.conference.removeTrack(desktopTrack).catch(e => {
                                                console.error('[NativeCapture] Error removing track:', e);
                                            });
                                        }
                                    } catch (e) {
                                        console.error('[NativeCapture] Error checking tracks:', e);
                                    }
                                }
                            }
                            
                            if (isWaitingForSources) {
                                console.log('[NativeCapture] Already waiting for sources');
                                return;
                            }
                            
                            isWaitingForSources = true;
                            pendingSourcesCallback = callback;
                            
                            const responseHandler = (response) => {
                                console.log('[NativeCapture] Got sources response:', response);
                                isWaitingForSources = false;
                                
                                if (window.electron_bridge && window.electron_bridge.events) {
                                    const handlers = window.electron_bridge.events.get('desktop-sources-response');
                                    if (handlers) {
                                        const index = handlers.indexOf(responseHandler);
                                        if (index > -1) {
                                            handlers.splice(index, 1);
                                        }
                                    }
                                }
                                
                                if (response && response.sources && response.sources.length > 0) {
                                    showSourcePicker(response.sources, (selectedId) => {
                                        console.log('[NativeCapture] User selected:', selectedId);
                                        if (pendingSourcesCallback) {
                                            pendingSourcesCallback(selectedId, {
                                                audio: true,
                                                screenShareAudio: true
                                            });
                                            pendingSourcesCallback = null;
                                        }
                                    });
                                } else {
                                    console.error('[NativeCapture] No sources received, using fallback');
                                    isWaitingForSources = false;
                                    originalOpenDesktopPicker.call(this, options, callback);
                                }
                            };
                            
                            window.electron_bridge.on_event('desktop-sources-response', responseHandler);
                            
                            console.log('[NativeCapture] Requesting desktop sources...');
                            window.electron_bridge.send_event('requestDesktopSources', {});
                            
                            setTimeout(() => {
                                if (isWaitingForSources) {
                                    console.log('[NativeCapture] Timeout, using fallback');
                                    isWaitingForSources = false;
                                    
                                    if (window.electron_bridge && window.electron_bridge.events) {
                                        const handlers = window.electron_bridge.events.get('desktop-sources-response');
                                        if (handlers) {
                                            const index = handlers.indexOf(responseHandler);
                                            if (index > -1) {
                                                handlers.splice(index, 1);
                                            }
                                        }
                                    }
                                    
                                    originalOpenDesktopPicker.call(this, options, callback);
                                }
                            }, 5000);
                        };
                        
                        window.JitsiMeetScreenObtainer.obtainDesktopStream = async function(sourceId, callback, errorCallback) {
                            console.log('[NativeCapture] obtainDesktopStream called with:', sourceId);
                            
                            try {
                                let isNativeSource = window._lastSelectedSourceIsNative || window._usingNativeSources;
                                
                                if (isNativeSource) {
                                    console.log('🎯[NativeCapture] Creating NATIVE stream with system audio');
                                    
                                    // === СОЗДАЕМ CANVAS ДЛЯ ВИДЕО ===
                                    const canvas = document.createElement('canvas');
                                    canvas.width = 1920;
                                    canvas.height = 1080;
                                    const ctx = canvas.getContext('2d', {
                                        alpha: false,
                                        desynchronized: true
                                    });
                                    
                                    if (!ctx) {
                                        throw new Error('Failed to get canvas context');
                                    }
                                    
                                    // === СОЗДАЕМ AUDIO CONTEXT ДЛЯ СИСТЕМНОГО ЗВУКА ===
                                    const audioContext = new AudioContext({
                                        sampleRate: 48000,
                                        latencyHint: 'interactive'
                                    });
                                    
                                    // ScriptProcessor для обработки аудио
                                    const scriptProcessor = audioContext.createScriptProcessor(4096, 0, 2);
                                    const audioBufferQueue = [];
                                    let isActive = true;
                                    let frameCount = 0;
                                    let audioFramesReceived = 0;
                                    
                                    // Обработчик аудио процессора
                                    scriptProcessor.onaudioprocess = (event) => {
                                        if (!isActive) return;
                                        
                                        const outputBuffer = event.outputBuffer;
                                        
                                        for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
                                            const outputData = outputBuffer.getChannelData(channel);
                                            
                                            if (audioBufferQueue.length > 0) {
                                                const audioData = audioBufferQueue.shift();
                                                if (audioData && audioData[channel]) {
                                                    outputData.set(audioData[channel]);
                                                } else {
                                                    outputData.fill(0);
                                                }
                                            } else {
                                                outputData.fill(0);
                                            }
                                        }
                                    };
                                    
                                    // Запускаем native capture
                                    if (window.ipcRenderer) {
                                        const startResult = await window.ipcRenderer.invoke('start-native-capture', sourceId);
                                        console.log('[NativeCapture] Native capture started:', startResult);
                                        
                                        if (!startResult.success) {
                                            throw new Error('Failed to start native capture');
                                        }
                                    }
                                    
                                    // === ФУНКЦИЯ ОБРАБОТКИ ФРЕЙМОВ ===
                                    async function processFrames() {
                                        if (!isActive) return;
                                        
                                        try {
                                            if (window.ipcRenderer) {
                                                const frames = await window.ipcRenderer.invoke('get-native-frames');
                                                
                                                // Обработка видео
                                                if (frames.video && frames.video.length > 0) {
                                                    frameCount++;
                                                    
                                                    try {
                                                        const videoData = frames.video[0];
                                                        // Предполагаем что videoData - это ArrayBuffer или Uint8Array
                                                        const imageData = new ImageData(
                                                            new Uint8ClampedArray(videoData),
                                                            1920,
                                                            1080
                                                        );
                                                        ctx.putImageData(imageData, 0, 0);
                                                        
                                                        if (frameCount % 30 === 0) {
                                                            console.log('[NativeCapture] Video frames:', frameCount);
                                                        }
                                                    } catch (e) {
                                                        // Показываем тестовый паттерн если ошибка
                                                        drawTestPattern();
                                                    }
                                                } else {
                                                    drawTestPattern();
                                                }
                                                
                                                // Обработка аудио от системы
                                                if (frames.audio && frames.audio.length > 0) {
                                                    audioFramesReceived++;
                                                    
                                                    const audioData = frames.audio[0];
                                                    // Предполагаем что audioData - это ArrayBuffer с Int16 данными
                                                    const int16Array = new Int16Array(audioData);
                                                    const channels = 2;
                                                    const samplesPerChannel = Math.floor(int16Array.length / channels);
                                                    const channelData = [];
                                                    
                                                    for (let ch = 0; ch < channels; ch++) {
                                                        const float32Array = new Float32Array(samplesPerChannel);
                                                        for (let i = 0; i < samplesPerChannel; i++) {
                                                            const idx = i * channels + ch;
                                                            if (idx < int16Array.length) {
                                                                // Конвертируем Int16 в Float32 с усилением
                                                                float32Array[i] = (int16Array[idx] / 32768.0) * 2.0;
                                                            }
                                                        }
                                                        channelData.push(float32Array);
                                                    }
                                                    
                                                    audioBufferQueue.push(channelData);
                                                    
                                                    // Ограничиваем размер очереди
                                                    if (audioBufferQueue.length > 20) {
                                                        audioBufferQueue.shift();
                                                    }
                                                    
                                                    if (audioFramesReceived % 100 === 0) {
                                                        console.log('[NativeCapture] Audio frames received:', audioFramesReceived);
                                                    }
                                                }
                                            }
                                        } catch (error) {
                                            console.error('[NativeCapture] Error processing frames:', error);
                                        }
                                        
                                        // Запрашиваем следующий кадр
                                        if (isActive) {
                                            setTimeout(processFrames, 10); // 100 раз в секунду для аудио
                                        }
                                    }
                                    
                                    // Тестовый паттерн
                                    function drawTestPattern() {
                                        const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 800);
                                        gradient.addColorStop(0, '#4CAF50');
                                        gradient.addColorStop(1, '#2E7D32');
                                        ctx.fillStyle = gradient;
                                        ctx.fillRect(0, 0, 1920, 1080);
                                        
                                        ctx.fillStyle = 'white';
                                        ctx.font = 'bold 60px Arial';
                                        ctx.textAlign = 'center';
                                        ctx.fillText('🎯 NATIVE CAPTURE', 960, 400);
                                        ctx.fillText('🔊 System Audio Active', 960, 500);
                                        ctx.font = '40px Arial';
                                        ctx.fillText('Video: ${frameCount} | Audio: ${audioFramesReceived}', 960, 600);
                                        ctx.fillText('Queue: ${audioBufferQueue.length}', 960, 700);
                                    }
                                    
                                    // Запускаем обработку
                                    processFrames();
                                    
                                    // === СОЗДАЕМ MEDIASTREAM ===
                                    const videoStream = canvas.captureStream(30);
                                    const videoTrack = videoStream.getVideoTracks()[0];
                                    
                                    // Подключаем аудио процессор к destination
                                    const destination = audioContext.createMediaStreamDestination();
                                    scriptProcessor.connect(destination);
                                    
                                    const audioTrack = destination.stream.getAudioTracks()[0];
                                    
                                    // Помечаем что это системный звук
                                    if (audioTrack) {
                                        (audioTrack as any)._isSystemAudio = true;
                                    }
                                    
                                    // Создаем комбинированный stream
                                    const combinedStream = new MediaStream();
                                    if (videoTrack) {
                                        combinedStream.addTrack(videoTrack);
                                        console.log('[NativeCapture] Added video track');
                                    }
                                    if (audioTrack) {
                                        combinedStream.addTrack(audioTrack);
                                        console.log('[NativeCapture] Added SYSTEM AUDIO track');
                                    }
                                    
                                    console.log('[NativeCapture] Stream created with:');
                                    console.log('  - Video tracks:', combinedStream.getVideoTracks().length);
                                    console.log('  - Audio tracks:', combinedStream.getAudioTracks().length);
                                    
                                    // === ИНДИКАТОР ===
                                    const indicator = document.createElement('div');
                                    indicator.id = 'native-capture-indicator';
                                    indicator.style.cssText = \`
                                        position: fixed;
                                        bottom: 20px;
                                        left: 20px;
                                        background: linear-gradient(135deg, #4CAF50, #66BB6A);
                                        color: white;
                                        padding: 12px 20px;
                                        border-radius: 25px;
                                        z-index: 100000;
                                        font-size: 14px;
                                        font-weight: 600;
                                        display: flex;
                                        align-items: center;
                                        gap: 12px;
                                        box-shadow: 0 4px 20px rgba(76, 175, 80, 0.5);
                                        animation: fadeIn 0.3s ease;
                                    \`;
                                    indicator.innerHTML = \`
                                        <div style="
                                            width: 12px;
                                            height: 12px;
                                            background: white;
                                            border-radius: 50%;
                                            animation: pulse 1.5s infinite;
                                        "></div>
                                        <span>🎯 Native Capture</span>
                                        <div style="
                                            padding-left: 12px;
                                            border-left: 1px solid rgba(255,255,255,0.3);
                                            display: flex;
                                            align-items: center;
                                            gap: 6px;
                                        ">
                                            <span style="font-size: 18px;">🔊</span>
                                            <span style="font-size: 12px;">System Audio</span>
                                        </div>
                                    \`;
                                    
                                    const style = document.createElement('style');
                                    style.textContent = \`
                                        @keyframes pulse {
                                            0%, 100% { opacity: 1; transform: scale(1); }
                                            50% { opacity: 0.6; transform: scale(0.9); }
                                        }
                                        @keyframes fadeIn {
                                            from { opacity: 0; transform: translateY(20px); }
                                            to { opacity: 1; transform: translateY(0); }
                                        }
                                    \`;
                                    document.head.appendChild(style);
                                    document.body.appendChild(indicator);
                                    
                                    // === CLEANUP ===
                                    if (videoTrack) {
                                        videoTrack.addEventListener('ended', async () => {
                                            console.log('[NativeCapture] Stopping...');
                                            isActive = false;
                                            
                                            scriptProcessor.disconnect();
                                            await audioContext.close();
                                            
                                            if (window.ipcRenderer) {
                                                await window.ipcRenderer.invoke('stop-native-capture');
                                            }
                                            
                                            const ind = document.getElementById('native-capture-indicator');
                                            if (ind) ind.remove();
                                            style.remove();
                                        });
                                    }
                                    
                                    // Передаем stream в Jitsi
                                    if (callback) {
                                        console.log('[NativeCapture] Calling Jitsi callback with stream');
                                        callback(combinedStream);
                                    }
                                    
                                } else {
                                    // Стандартный источник
                                    console.log('📺[NativeCapture] Standard source');
                                    originalObtainStream.call(this, sourceId, callback, errorCallback);
                                }
                                
                            } catch (error) {
                                console.error('[NativeCapture] Error:', error);
                                if (errorCallback) {
                                    errorCallback(error);
                                }
                            }
                        };
                        
                        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Упрощенный диалог без лишних обработчиков
                        function showSourcePicker(sources, callback) {
                            console.log('[SourcePicker] Showing picker with', sources.length, 'sources');
                            
                            // Определяем тип источников по первому элементу
                            const sourceType = sources[0]?.isNative ? 'native' : 'electron';
                            console.log('[SourcePicker] Source type:', sourceType);
                            
                            const overlay = document.createElement('div');
                            overlay.id = 'source-picker-overlay';
                            overlay.style.cssText = \`
                                position: fixed;
                                top: 0;
                                left: 0;
                                right: 0;
                                bottom: 0;
                                background: rgba(0, 0, 0, 0.8);
                                z-index: 10000;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            \`;
                            
                            const dialog = document.createElement('div');
                            dialog.style.cssText = \`
                                background: white;
                                border-radius: 12px;
                                padding: 24px;
                                max-width: 90%;
                                max-height: 80%;
                                overflow: auto;
                            \`;
                            
                            let htmlContent = \`
                                <h2 style="margin-top: 0; color: #333;">
                                    Выберите экран или окно
                                </h2>
                                <div style="
                                    background: \${sourceType === 'native' ? '#e8f5e9' : '#e3f2fd'};
                                    border-left: 4px solid \${sourceType === 'native' ? '#4CAF50' : '#2196F3'};
                                    padding: 12px;
                                    margin-bottom: 20px;
                                    border-radius: 4px;
                                ">
                                    <strong style="color: \${sourceType === 'native' ? '#2e7d32' : '#1565c0'};">
                                        \${sourceType === 'native' 
                                            ? '🎯 Native Addon активен' 
                                            : '📺 Electron Capturer активен'}
                                    </strong>
                                    <div style="color: #666; font-size: 13px; margin-top: 4px;">
                                        \${sourceType === 'native' 
                                            ? 'Демонстрация с изоляцией звука приложения' 
                                            : 'Стандартная демонстрация экрана'}
                                    </div>
                                </div>
                                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin: 20px 0;">
                            \`;
                            
                            sources.forEach((source, index) => {
                                const borderColor = source.isNative ? '#4CAF50' : '#2196F3';
                                htmlContent += \`
                                    <div id="source-item-\${index}" style="
                                        border: 2px solid #ddd;
                                        border-radius: 8px;
                                        padding: 12px;
                                        cursor: pointer;
                                        text-align: center;
                                        background: white;
                                        position: relative;
                                    " onmouseover="this.style.borderColor='\${borderColor}'; this.style.transform='scale(1.03)';" 
                                      onmouseout="this.style.borderColor='#ddd'; this.style.transform='scale(1)';">
                                        \${source.isNative ? \`
                                            <div style="
                                                position: absolute;
                                                top: 8px;
                                                right: 8px;
                                                background: #4CAF50;
                                                color: white;
                                                padding: 2px 6px;
                                                border-radius: 4px;
                                                font-size: 11px;
                                                font-weight: bold;
                                            ">NATIVE</div>
                                        \` : ''}
                                        <img src="\${source.thumbnail.dataUrl}" style="
                                            width: 100%; 
                                            height: 140px; 
                                            object-fit: contain; 
                                            margin-bottom: 8px;
                                            border-radius: 4px;
                                            background: #f5f5f5;
                                        ">
                                        <div style="font-size: 14px; color: #666;">\${source.name}</div>
                                    </div>
                                \`;
                            });
                            
                            htmlContent += \`
                                </div>
                                <div style="text-align: center;">
                                    <button id="cancel-picker-btn" style="
                                        background: #f44336;
                                        color: white;
                                        border: none;
                                        padding: 10px 24px;
                                        border-radius: 6px;
                                        cursor: pointer;
                                        font-size: 16px;
                                    ">Отмена</button>
                                </div>
                            \`;
                            
                            dialog.innerHTML = htmlContent;
                            overlay.appendChild(dialog);
                            document.body.appendChild(overlay);
                            
                            // УПРОЩЕННЫЙ обработчик кликов через делегирование
                            overlay.onclick = function(e) {
                                e.stopPropagation();
                                
                                // Клик на источник
                                const sourceItem = e.target.closest('[id^="source-item-"]');
                                if (sourceItem) {
                                    const index = parseInt(sourceItem.id.split('-')[2]);
                                    const selectedSource = sources[index];
                                    if (selectedSource) {
                                        console.log('[SourcePicker] Selected:', selectedSource.id);
                                        
                                        // Немедленно удаляем диалог
                                        overlay.remove();
                                        
                                        // Вызываем callback
                                        callback(selectedSource.id);
                                    }
                                    return;
                                }
                                
                                // Клик на кнопку отмены
                                if (e.target.id === 'cancel-picker-btn') {
                                    console.log('[SourcePicker] Cancelled');
                                    overlay.remove();
                                    return;
                                }
                                
                                // Клик вне диалога
                                if (e.target === overlay) {
                                    console.log('[SourcePicker] Clicked outside');
                                    overlay.remove();
                                    return;
                                }
                            };
                            
                            // Escape для закрытия
                            const handleEscape = function(e) {
                                if (e.key === 'Escape') {
                                    overlay.remove();
                                    document.removeEventListener('keydown', handleEscape);
                                }
                            };
                            document.addEventListener('keydown', handleEscape);
                        }
                        
                        console.log('[NativeCapture] Handler installed successfully');
                        return { 
                            success: true,
                            hasJitsiScreenObtainer: true,
                            hasElectronBridge: !!window.electron_bridge
                        };
                    })();
                `);
                  
                  log.info(`🎯[Jitsi] Injection result: ${JSON.stringify(injectionResult)}`);
                  
              } catch (error: any) {
                  log.error(`🎯[Jitsi] Error injecting: ${error.message}`);
              }
          }, 2000); // Даем 4 секунды на загрузку Jitsi
          
          // Слушаем postMessage от Jitsi окна
          jitsiWindow.webContents.on('console-message', (event, level, message) => {
              if (message.includes('[NativeCapture]') || 
                  message.includes('[electron_bridge]') || 
                  message.includes('[Bridge]') ||
                  message.includes('[SourcePicker]')) {
                  log.info(`Jitsi Console: ${message}`);
              }
          });
          
          // Фокусируем окно
          jitsiWindow.focus();
          
          // Обработчик закрытия окна
          jitsiWindow.on('closed', () => {
              log.info(`🎯[Jitsi] Window closed`);
              
              // Останавливаем нативный захват
              if (screenCaptureAddon && typeof screenCaptureAddon.stopCapture === 'function') {
                  screenCaptureAddon.stopCapture().catch((err: any) => {
                      log.error(`Failed to stop capture: ${err.message}`);
                  });
              }
              
              jitsiWindow = null;
              
              // Уведомляем Zulip
              sendEventToZulip('jitsi-window-closed', {
                  roomName: roomName
              });
          });
          
          // Отправляем событие об успешном создании
          sendEventToZulip('jitsi-window-opened', {
              success: true,
              roomName: roomName,
              server: server
          });

          // В функции createJitsiWindow после загрузки страницы добавьте:
            setTimeout(async () => {
                await jitsiWindow.webContents.executeJavaScript(`
                    // Добавляем кнопку для тестирования native stream
                    const button = document.createElement('button');
                    button.textContent = '🎯 Start Native Stream';
                    button.style.cssText = \`
                        position: fixed;
                        top: 80px;
                        right: 20px;
                        z-index: 100000;
                        padding: 10px 20px;
                        background: linear-gradient(135deg, #4CAF50, #66BB6A);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        font-size: 16px;
                        font-weight: bold;
                        cursor: pointer;
                        box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3);
                    \`;
                    
                    button.onclick = async () => {
                        button.disabled = true;
                        button.textContent = '⏳ Starting...';
                        
                        try {
                            // Запрашиваем создание native stream через IPC
                            const result = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                            
                            if (result.success) {
                                button.textContent = '✅ Native Stream Active';
                                button.style.background = 'linear-gradient(135deg, #66BB6A, #4CAF50)';
                            } else {
                                button.textContent = '❌ Failed';
                                button.style.background = '#f44336';
                                console.error('Failed to start native stream:', result.error);
                            }
                        } catch (error) {
                            button.textContent = '❌ Error';
                            button.style.background = '#f44336';
                            console.error('Error:', error);
                        }
                    };
                    
                    document.body.appendChild(button);
                `);
            }, 3000);
          
          return {
              success: true,
              roomName: roomName,
              server: server
          };
          
      } catch (error: any) {
          log.error(`🎯[Jitsi] Error creating window: ${error.message}`);
          
          sendEventToZulip('jitsi-electron-failed', {
              error: error.message,
              fallbackNeeded: true
          });
          
          return {
              success: false,
              error: error.message,
              fallbackNeeded: true
          };
      }
  }

  function sendEventToZulip(eventName: string, data: any): void {
      const allContents = webContents.getAllWebContents();
      for (const content of allContents) {
          const url = content.getURL();
          if (url && url.includes('joinrm-svz')) {
              content.executeJavaScript(`
                  if (window.electron_bridge && window.electron_bridge.emit_event) {
                      window.electron_bridge.emit_event('${eventName}', ${JSON.stringify(data)});
                      console.log('[Electron->Zulip] Sent event: ${eventName}');
                  }
              `).catch(err => {
                  log.error(`Failed to send event to Zulip: ${err.message}`);
              });
              break;
          }
      }
  }


  // Передача нативного потока в Jitsi
  ipcMain.handle("share-stream-to-jitsi-sdk", async () => {
      log.info("🎯[Jitsi SDK] Sharing native stream...");
      
      try {
          if (!jitsiWindow || jitsiWindow.isDestroyed()) {
              throw new Error('Jitsi window not found. Create a meeting first.');
          }
          
          // Создаем тестовый поток прямо в контексте Jitsi окна
          const streamCreationCode = `
              (function() {
                  console.log('[Stream] Creating test stream...');
                  
                  // Создаем canvas с анимацией
                  const canvas = document.createElement('canvas');
                  canvas.width = 1920;
                  canvas.height = 1080;
                  const ctx = canvas.getContext('2d');
                  
                  let frame = 0;
                  let isActive = true;
                  
                  function animate() {
                      if (!isActive) return;
                      frame++;
                      
                      // Красивый градиент
                      const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 800);
                      gradient.addColorStop(0, 'hsl(' + (frame % 360) + ', 100%, 50%)');
                      gradient.addColorStop(0.5, 'hsl(' + ((frame + 120) % 360) + ', 100%, 40%)');
                      gradient.addColorStop(1, 'hsl(' + ((frame + 240) % 360) + ', 100%, 30%)');
                      ctx.fillStyle = gradient;
                      ctx.fillRect(0, 0, 1920, 1080);
                      
                      // Текст
                      ctx.fillStyle = 'white';
                      ctx.font = 'bold 120px Arial';
                      ctx.textAlign = 'center';
                      ctx.shadowColor = 'rgba(0,0,0,0.8)';
                      ctx.shadowBlur = 20;
                      ctx.fillText('🎯 ELECTRON SDK', 960, 400);
                      ctx.fillText('NATIVE STREAM', 960, 520);
                      
                      ctx.font = '60px Arial';
                      ctx.fillText('Frame: ' + frame, 960, 650);
                      ctx.fillText(new Date().toLocaleTimeString(), 960, 750);
                      
                      requestAnimationFrame(animate);
                  }
                  animate();
                  
                  // Создаем MediaStream
                  const stream = canvas.captureStream(30);
                  window.externalStream = stream;
                  
                  console.log('[Stream] Stream created:', stream.id);
                  
                  // Останавливаем через минуту
                  setTimeout(() => {
                      isActive = false;
                      stream.getTracks().forEach(track => track.stop());
                      console.log('[Stream] Stream stopped');
                  }, 60000);
                  
                  // Пробуем передать в Jitsi
                  if (window.receiveExternalStream) {
                      const result = window.receiveExternalStream(stream.id);
                      return {
                          success: result,
                          streamId: stream.id,
                          message: result ? 'Stream shared' : 'Failed to share'
                      };
                  }
                  
                  return {
                      success: false,
                      streamId: stream.id,
                      message: 'receiveExternalStream not found'
                  };
              })();
          `;
          
          const result = await jitsiWindow.webContents.executeJavaScript(streamCreationCode);
          log.info(`🎯[Jitsi SDK] Stream result: ${JSON.stringify(result)}`);
          
          return result;
          
      } catch (error: any) {
          log.error(`🎯[Jitsi SDK] Error: ${error.message}`);
          return { success: false, error: error.message };
      }
  });

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

  ipcMain.handle("get-desktop-sources", async () => {
      try {
          log.info("🎯[NativeCapture] Getting desktop sources...");
          
          let formattedSources = [];
          let sourceType = 'unknown';
          
          // Создаем маппинг для сохранения оригинальных ID
          const sourceIdMapping = new Map();
          
          // Получаем источники из native addon
          if (screenCaptureAddon && typeof screenCaptureAddon.getAvailableSources === 'function') {
              try {
                  const nativeSources = await screenCaptureAddon.getAvailableSources();
                  log.info(`🎯[NativeCapture] Got ${nativeSources.length} native sources`);
                  
                  if (nativeSources.length > 0) {
                      sourceType = 'native';
                      
                      // Логируем первые несколько источников для отладки
                      nativeSources.slice(0, 3).forEach((source, i) => {
                          log.info(`  Native source ${i}: id=${source.id}, name=${source.name}, type=${source.type}`);
                      });
                      
                      formattedSources = nativeSources.map((source, index) => {
                          const type = source.type === 'window' ? 'window' : 'screen';
                          
                          // ВАЖНО: Сохраняем оригинальный ID от native addon
                          const originalId = source.id;
                          
                          // Создаем ID в формате Electron, но сохраняем оригинальный ID
                          let formattedId;
                          if (originalId && !isNaN(Number(originalId))) {
                              // Если ID - число, используем его напрямую
                              formattedId = `${type}:${originalId}:0`;
                          } else if (originalId) {
                              // Если ID - строка (например, com.microsoft.VSCode)
                              // Генерируем числовой ID для Electron формата
                              const numericId = Math.abs(originalId.toString().split('').reduce((a, b) => {
                                  a = ((a << 5) - a) + b.charCodeAt(0);
                                  return a & a;
                              }, 0));
                              formattedId = `${type}:${numericId}:0`;
                              
                              // Сохраняем маппинг
                              sourceIdMapping.set(formattedId, originalId);
                          } else {
                              // Fallback - генерируем случайный ID
                              const randomId = Math.floor(100000 + Math.random() * 900000);
                              formattedId = `${type}:${randomId}:0`;
                          }
                          
                          log.info(`  Formatted: ${formattedId} -> original: ${originalId}`);
                          
                          return {
                              id: formattedId,
                              name: `🎯 ${source.name || `Source ${index}`}`,
                              thumbnail: { 
                                  dataUrl: createSourceThumbnail(source) 
                              },
                              isNative: true,
                              sourceType: 'native',
                              originalId: originalId, // Сохраняем оригинальный ID
                              originalType: source.type
                          };
                      });
                      
                      // Сохраняем маппинг глобально для последующего использования
                      global.nativeSourceMapping = sourceIdMapping;
                      
                      log.info(`🎯[NativeCapture] Created source mapping with ${sourceIdMapping.size} entries`);
                  }
                  
              } catch (error) {
                  log.error(`🎯[NativeCapture] Error getting native sources: ${error.message}`);
              }
          }
          
          // ... остальной код ...
          
          return formattedSources;
          
      } catch (error) {
          log.error(`🎯[NativeCapture] Error: ${error.message}`);
          return { sources: [], error: error.message };
      }
  });

  ipcMain.handle("jitsi-direct-connect", async (event, options) => {
      return createJitsiWindow(options);
  });

  ipcMain.handle("jitsi-connect-with-zulip-config", async (event, options) => {
      log.info("🎯[Jitsi] Connecting with Zulip config...");
      log.info(`🎯[Jitsi] Options received: ${JSON.stringify(options)}`);

      try {
          // Проверяем обязательные параметры
          const roomUrl = options.roomUrl || '';
          const roomName = options.roomName || '';
          const jwt = options.jwt || '';
          
          if (!roomName && !roomUrl) {
              throw new Error('Room name or URL is required');
          }
          
          // Извлекаем roomName из URL если не передан
          let finalRoomName = roomName;
          if (!finalRoomName && roomUrl) {
              const urlParts = roomUrl.split('/');
              finalRoomName = urlParts[urlParts.length - 1].split('?')[0];
          }
          
          // Определяем server URL
          let serverUrl = options.serverUrl || 'https://jitsi-connectrm.ru';
          if (roomUrl && roomUrl.startsWith('http')) {
              const url = new URL(roomUrl);
              serverUrl = url.origin;
          }
          
          // Создаем окно Jitsi
          const result = await createJitsiWindow({
              roomName: finalRoomName,
              serverUrl: serverUrl,
              displayName: options.userInfo?.displayName || 'Guest',
              email: options.userInfo?.email || '',
              avatarUrl: options.userInfo?.avatarUrl || '',
              jwt: jwt
          });
          
          // Если нужен fallback на браузер
          if (result.fallbackNeeded) {
              log.info(`🎯[Jitsi] Fallback needed, sending signal to Zulip`);
              return {
                  success: false,
                  error: result.error,
                  fallbackToBrowser: true  // Сигнал для Zulip
              };
          }
          
          if (result.success) {
              log.info(`🎯[Jitsi] Conference window created successfully`);
              
              // Отправляем подтверждение обратно в Zulip
              setTimeout(() => {
                  sendEventToZulip('jitsi-conference-ready', {
                      success: true,
                      roomName: result.roomName,
                      server: result.server
                  });
                  const appName = 'RM App';  // Имя для индикатора, например "RM App is sharing your screen"
                  const osxBundleId = process.platform === 'darwin' ? 'ru.rm.desktop' : undefined;  // Ваш bundle ID из package.json или Info.plist

                  try {
                    setupScreenSharingMain(jitsiWindow, appName, osxBundleId);
                    log.info('✅ setupScreenSharingMain вызвана успешно без ошибок');
                  } catch (error) {
                    log.error(`❌ Ошибка при вызове setupScreenSharingMain: ${error.message}`);
                    // Если ошибка, возможно, проблема с разрешениями или версией Electron — проверьте стек
                  }
              }, 1000);
          }
          
          return result;
          
      } catch (error: any) {
          log.error(`🎯[Jitsi] Error: ${error.message}`);
          
          // Отправляем сигнал для fallback на браузер
          return { 
              success: false, 
              error: error.message,
              fallbackToBrowser: true
          };
      }
  });



  ipcMain.handle("start-native-capture-with-audio", async (event, sourceId: string) => {
      try {
          log.info(`🎯[NativeCapture] Starting capture with audio for source: ${sourceId}`);
          
          if (!screenCaptureAddon) {
              throw new Error("Native addon not loaded");
          }
          
          // Запускаем захват с включенным аудио от приложения
          const result = await screenCaptureAddon.startCapture({
              sourceId: sourceId,
              width: 1920,
              height: 1080,
              frameRate: 30,
              enableAppSpecificAudio: true, // ВАЖНО: включаем изоляцию звука приложения
              audioSampleRate: 48000,
              audioChannels: 2
          });
          
          if (!result || !result.success) {
              throw new Error(result?.error || "Failed to start capture");
          }
          
          log.info("🎯[NativeCapture] Capture started with app-specific audio");
          return { success: true };
          
      } catch (error: any) {
          log.error(`🎯[NativeCapture] Error starting capture: ${error.message}`);
          return { success: false, error: error.message };
      }
  });



  // Добавить функцию создания тестовых thumbnail

  ipcMain.handle("create-jitsi-sdk-from-zulip", async (event, options) => {
      log.info("🎯[Jitsi] Creating from Zulip (redirecting to main handler)...");
      // Просто перенаправляем на основной обработчик
      return ipcMain.handle("jitsi-connect-with-zulip-config", event, options);
  });


  ipcMain.handle("check-capture-source-type", async () => {
      const result = {
          nativeAvailable: false,
          nativeSourceCount: 0,
          electronAvailable: true,
          currentType: 'unknown'
      };
      
      // Проверяем native addon
      if (screenCaptureAddon && typeof screenCaptureAddon.getAvailableSources === 'function') {
          try {
              const sources = await screenCaptureAddon.getAvailableSources();
              result.nativeAvailable = true;
              result.nativeSourceCount = sources.length;
              result.currentType = sources.length > 0 ? 'native' : 'electron';
          } catch (error) {
              log.error(`Check source type error: ${error.message}`);
          }
      } else {
          result.currentType = 'electron';
      }
      
      log.info(`🔍 Source type check: ${JSON.stringify(result)}`);
      return result;
  });


  // Добавьте этот обработчик для тестирования аудио
  ipcMain.handle("test-native-audio-recording", async (event) => {
        try {
            log.info("🎬 [Test] Starting native audio/video recording test...");
            
            if (!screenCaptureAddon) {
                throw new Error("Native addon not loaded");
            }
            
            // === ВИДЕО СТРУКТУРЫ ===
            interface VideoFrameInfo {
                timestamp: number;
                width: number;
                height: number;
                data?: Buffer;  // Пиксельные данные если доступны
                pixelFormat: string;
                bytesPerRow: number;
            }
            
            const videoFrames: VideoFrameInfo[] = [];
            const MAX_VIDEO_FRAMES = 300; // Ограничиваем для экономии памяти
            let videoFrameCount = 0;
            const videoFrameStats = {
                minFps: Infinity,
                maxFps: 0,
                avgFps: 0,
                totalFrames: 0,
                width: 0,
                height: 0,
                format: '',
                firstTimestamp: 0,
                lastTimestamp: 0,
                actualDuration: 0,
                savedFrames: 0
            };
            let lastVideoTimestamp = 0;
            let videoFpsBuffer: number[] = [];
            
            // === АУДИО СТРУКТУРЫ (как раньше) ===
            interface AudioChunkInfo {
                buffer: Buffer;
                timestamp: number;
                samples: number;
                source: string;
            }
            
            const microphoneChunks: AudioChunkInfo[] = [];
            const systemChunks: AudioChunkInfo[] = [];
            
            let audioSourceStats = {
                microphone: 0,
                system: 0,
                unknown: 0
            };
            
            let firstTimestamp: number | null = null;
            let lastMicTimestamp = 0;
            let lastSysTimestamp = 0;
            let audioFrameCount = 0;
            const duration = 10000; // 10 секунд
            
            // === УСТАНОВКА КОЛБЭКОВ ===
            log.info("📹 [Test] Setting up audio/video callbacks...");
            
            try {
                // ВИДЕО КОЛБЭК с сохранением фреймов
                log.info("🎥 [VideoTest] Setting up video callback with frame capture...");
                screenCaptureAddon.setWebRTCVideoCallback((videoData: any) => {
                    try {
                        videoFrameCount++;
                        videoFrameStats.totalFrames = videoFrameCount;
                        
                        // Логируем первые несколько фреймов
                        if (videoFrameCount <= 5) {
                            log.info(`🎥 [VideoTest] Video frame ${videoFrameCount}:`);
                            log.info(`  - Resolution: ${videoData?.width}x${videoData?.height}`);
                            log.info(`  - Timestamp: ${videoData?.timestamp}`);
                            log.info(`  - Pixel format: ${videoData?.pixelFormatName} (${videoData?.pixelFormat})`);
                            log.info(`  - Bytes per row: ${videoData?.bytesPerRow}`);
                            log.info(`  - Data size: ${videoData?.dataSize} bytes`);
                            log.info(`  - Has data: ${videoData?.hasData}`);
                            log.info(`  - Has pixel buffer: ${!!videoData?.data}`);
                        }
                        
                        // Сохраняем первую временную метку
                        if (videoFrameCount === 1 && videoData?.timestamp) {
                            videoFrameStats.firstTimestamp = videoData.timestamp;
                        }
                        
                        // Обновляем статистику
                        if (videoData?.width) videoFrameStats.width = videoData.width;
                        if (videoData?.height) videoFrameStats.height = videoData.height;
                        if (videoData?.pixelFormatName) videoFrameStats.format = videoData.pixelFormatName;
                        if (videoData?.timestamp) {
                            videoFrameStats.lastTimestamp = videoData.timestamp;
                            
                            // Расчет FPS
                            if (lastVideoTimestamp > 0) {
                                const deltaTime = videoData.timestamp - lastVideoTimestamp;
                                if (deltaTime > 0) {
                                    const currentFps = 1.0 / deltaTime;
                                    
                                    videoFpsBuffer.push(currentFps);
                                    if (videoFpsBuffer.length > 30) {
                                        videoFpsBuffer.shift();
                                    }
                                    
                                    videoFrameStats.minFps = Math.min(videoFrameStats.minFps, currentFps);
                                    videoFrameStats.maxFps = Math.max(videoFrameStats.maxFps, currentFps);
                                    
                                    const avgFps = videoFpsBuffer.reduce((a, b) => a + b, 0) / videoFpsBuffer.length;
                                    videoFrameStats.avgFps = avgFps;
                                }
                            }
                            lastVideoTimestamp = videoData.timestamp;
                        }
                        
                        // СОХРАНЕНИЕ ВИДЕО ФРЕЙМА
                        // Сохраняем каждый N-й фрейм для экономии памяти
                        const FRAME_SAVE_INTERVAL = Math.ceil(videoFrameStats.avgFps / 10) || 3; // ~10 fps для сохранения
                        
                        if (videoFrameCount % FRAME_SAVE_INTERVAL === 0 && videoFrames.length < MAX_VIDEO_FRAMES) {
                            const frameInfo: VideoFrameInfo = {
                                timestamp: videoData?.timestamp || 0,
                                width: videoData?.width || 0,
                                height: videoData?.height || 0,
                                pixelFormat: videoData?.pixelFormatName || 'unknown',
                                bytesPerRow: videoData?.bytesPerRow || 0
                            };
                            
                            // Если есть пиксельные данные, сохраняем их
                            if (videoData?.data) {
                                if (videoData.data instanceof ArrayBuffer) {
                                    frameInfo.data = Buffer.from(videoData.data);
                                } else if (Buffer.isBuffer(videoData.data)) {
                                    frameInfo.data = videoData.data;
                                }
                                
                                if (frameInfo.data && videoFrameStats.savedFrames === 0) {
                                    log.info(`🎥 [VideoTest] First frame with pixel data saved! Size: ${frameInfo.data.length} bytes`);
                                }
                                videoFrameStats.savedFrames++;
                            }
                            
                            videoFrames.push(frameInfo);
                            
                            if (videoFrames.length % 50 === 0) {
                                log.info(`🎥 [VideoTest] Saved ${videoFrames.length} video frames (${videoFrameStats.savedFrames} with pixel data)`);
                            }
                        }
                        
                        // Периодический отчет
                        if (videoFrameCount % 100 === 0) {
                            const currentDuration = videoFrameStats.lastTimestamp - videoFrameStats.firstTimestamp;
                            log.info(`🎥 [VideoTest] Video progress:`);
                            log.info(`  - Frames captured: ${videoFrameCount}`);
                            log.info(`  - Frames saved: ${videoFrames.length} (${videoFrameStats.savedFrames} with data)`);
                            log.info(`  - Duration: ${currentDuration.toFixed(2)}s`);
                            log.info(`  - Average FPS: ${videoFrameStats.avgFps.toFixed(2)}`);
                        }
                        
                    } catch (error: any) {
                        if (videoFrameCount <= 5) {
                            log.error(`🎥 [VideoTest] Video callback error: ${error.message}`);
                        }
                    }
                });
                
                // АУДИО КОЛБЭК (как раньше)
                log.info("🎤 [AudioTest] Setting up audio callback...");
                screenCaptureAddon.setWebRTCAudioCallback((audioData: any) => {
                    try {
                        audioFrameCount++;
                        
                        const source = audioData?.source || 'unknown';
                        audioSourceStats[source] = (audioSourceStats[source] || 0) + 1;
                        
                        if (firstTimestamp === null && audioData?.timestamp !== undefined) {
                            firstTimestamp = audioData.timestamp;
                        }
                        
                        if (audioSourceStats[source] <= 3) {
                            log.info(`🎤 [AudioTest] ${source.toUpperCase()} audio frame ${audioSourceStats[source]}:`);
                            log.info(`  - Sample rate: ${audioData?.sampleRate}`);
                            log.info(`  - Channels: ${audioData?.channels}`);
                            log.info(`  - Data size: ${audioData?.dataSize} bytes`);
                            log.info(`  - Timestamp: ${audioData?.timestamp}`);
                        }
                        
                        if (audioData && audioData.data && audioData.dataSize > 0) {
                            let buffer: Buffer;
                            
                            if (audioData.data instanceof ArrayBuffer) {
                                buffer = Buffer.from(audioData.data);
                            } else if (Buffer.isBuffer(audioData.data)) {
                                buffer = audioData.data;
                            } else {
                                return;
                            }
                            
                            const numSamples = audioData.numSamples || 960;
                            const chunkInfo: AudioChunkInfo = {
                                buffer: buffer,
                                timestamp: audioData.timestamp || 0,
                                samples: numSamples,
                                source: source
                            };
                            
                            if (source === 'microphone') {
                                if (!audioData.timestamp || audioData.timestamp > lastMicTimestamp) {
                                    microphoneChunks.push(chunkInfo);
                                    lastMicTimestamp = audioData.timestamp || lastMicTimestamp;
                                }
                            } else if (source === 'system') {
                                if (!audioData.timestamp || audioData.timestamp > lastSysTimestamp) {
                                    systemChunks.push(chunkInfo);
                                    lastSysTimestamp = audioData.timestamp || lastSysTimestamp;
                                }
                            }
                        }
                        
                    } catch (error: any) {
                        if (audioFrameCount <= 5) {
                            log.error(`🎤 [AudioTest] Audio callback error: ${error.message}`);
                        }
                    }
                });
                
                log.info("✅ [Test] All callbacks set successfully");
                
            } catch (error: any) {
                log.error(`❌ [Test] Error setting callbacks: ${error.message}`);
                return { success: false, error: `Callback setup failed: ${error.message}` };
            }
            
            // === ЗАПУСК ЗАХВАТА ===
            try {
                log.info("🚀 [Test] Starting capture (will show system picker)...");
                const startResult = await screenCaptureAddon.startCapture();
                log.info(`✅ [Test] Capture started: ${JSON.stringify(startResult)}`);
                
            } catch (error: any) {
                log.error(`❌ [Test] startCapture failed: ${error.message}`);
                
                if (error.message.includes("not initialized") || error.message.includes("No selection")) {
                    log.info("🔄 [Test] Trying with selectSourceWithPicker...");
                    
                    try {
                        const pickerResult = await screenCaptureAddon.selectSourceWithPicker();
                        log.info(`✅ [Test] Picker result: ${JSON.stringify(pickerResult)}`);
                        
                        if (pickerResult && pickerResult.type && pickerResult.id) {
                            await screenCaptureAddon.setCaptureSource({
                                type: pickerResult.type,
                                id: String(pickerResult.id)
                            });
                            
                            const startResult2 = await screenCaptureAddon.startCapture();
                            log.info(`✅ [Test] Capture started: ${JSON.stringify(startResult2)}`);
                        } else {
                            throw new Error("User cancelled picker");
                        }
                        
                    } catch (pickerError: any) {
                        log.error(`❌ [Test] Picker also failed: ${pickerError.message}`);
                        return { success: false, error: `Cannot start capture: ${pickerError.message}` };
                    }
                } else {
                    return { success: false, error: `Failed to start: ${error.message}` };
                }
            }
            
            // === ЗАПИСЬ С ПРОГРЕССОМ ===
            log.info(`⏺️ [Test] Recording for ${duration/1000} seconds...`);
            
            for (let i = 1; i <= duration/1000; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                log.info(`⏺️ [Test] Recording ${i}/${duration/1000}s:`);
                log.info(`  🎥 Video: ${videoFrameCount} frames (${videoFrameStats.avgFps.toFixed(1)} fps), saved: ${videoFrames.length}`);
                log.info(`  🎤 Audio: ${audioFrameCount} frames (Mic:${audioSourceStats.microphone}, Sys:${audioSourceStats.system})`);
                
                if (i % 3 === 0 && typeof screenCaptureAddon.getFrameStats === 'function') {
                    try {
                        const stats = screenCaptureAddon.getFrameStats();
                        log.info(`  📊 Native stats: ${JSON.stringify(stats)}`);
                    } catch (e) {}
                }
            }
            
            // === ОСТАНОВКА ===
            try {
                log.info("⏹️ [Test] Stopping capture...");
                await screenCaptureAddon.stopCapture();
                log.info("✅ [Test] Capture stopped");
            } catch (error: any) {
                log.error(`⚠️ [Test] Warning: stopCapture error: ${error.message}`);
            }
            
            // === ФИНАЛЬНАЯ СТАТИСТИКА ===
            videoFrameStats.actualDuration = videoFrameStats.lastTimestamp - videoFrameStats.firstTimestamp;
            
            log.info("");
            log.info("============ FINAL RESULTS ============");
            
            // Видео статистика
            log.info("🎥 VIDEO STATISTICS:");
            log.info(`  - Total frames: ${videoFrameStats.totalFrames}`);
            log.info(`  - Frames saved: ${videoFrames.length}`);
            log.info(`  - Frames with pixel data: ${videoFrameStats.savedFrames}`);
            log.info(`  - Resolution: ${videoFrameStats.width}x${videoFrameStats.height}`);
            log.info(`  - Pixel format: ${videoFrameStats.format}`);
            log.info(`  - Actual duration: ${videoFrameStats.actualDuration.toFixed(2)}s`);
            log.info(`  - Average FPS: ${videoFrameStats.avgFps.toFixed(2)}`);
            log.info(`  - FPS range: ${videoFrameStats.minFps === Infinity ? 'N/A' : videoFrameStats.minFps.toFixed(2)} - ${videoFrameStats.maxFps.toFixed(2)}`);
            
            // Аудио статистика
            log.info("");
            log.info("🎤 AUDIO STATISTICS:");
            log.info(`  - Total frames: ${audioFrameCount}`);
            log.info(`  - Microphone: ${audioSourceStats.microphone} frames (${microphoneChunks.length} chunks saved)`);
            log.info(`  - System: ${audioSourceStats.system} frames (${systemChunks.length} chunks saved)`);
            
            if (microphoneChunks.length > 0) {
                const micDuration = microphoneChunks[microphoneChunks.length - 1].timestamp - microphoneChunks[0].timestamp;
                log.info(`  - Mic duration: ${micDuration.toFixed(2)}s`);
            }
            
            if (systemChunks.length > 0) {
                const sysDuration = systemChunks[systemChunks.length - 1].timestamp - systemChunks[0].timestamp;
                log.info(`  - System duration: ${sysDuration.toFixed(2)}s`);
            }
            
            // === СОХРАНЕНИЕ ФАЙЛОВ ===
            const timestamp = Date.now();
            const savedFiles: string[] = [];
            
            log.info("");
            log.info("💾 SAVING FILES:");
            
            // Функции сохранения аудио
            const createWavHeader = (dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer => {
                const header = Buffer.alloc(44);
                header.write('RIFF', 0);
                header.writeUInt32LE(36 + dataSize, 4);
                header.write('WAVE', 8);
                header.write('fmt ', 12);
                header.writeUInt32LE(16, 16);
                header.writeUInt16LE(1, 20);
                header.writeUInt16LE(channels, 22);
                header.writeUInt32LE(sampleRate, 24);
                header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
                header.writeUInt16LE(channels * bitsPerSample / 8, 32);
                header.writeUInt16LE(bitsPerSample, 34);
                header.write('data', 36);
                header.writeUInt32LE(dataSize, 40);
                return header;
            };
            
            const saveWavFileWithTimestamps = (chunks: AudioChunkInfo[], sampleRate: number, channels: number, filePath: string) => {
                if (chunks.length === 0) return;
                
                chunks.sort((a, b) => a.timestamp - b.timestamp);
                const audioData = Buffer.concat(chunks.map(c => c.buffer));
                const wavHeader = createWavHeader(audioData.length, sampleRate, channels, 16);
                const wavFile = Buffer.concat([wavHeader, audioData]);
                
                fs.writeFileSync(filePath, wavFile);
                log.info(`  ✅ Saved: ${filePath} (${(wavFile.length / 1024 / 1024).toFixed(2)} MB)`);
                savedFiles.push(filePath);
            };
            
            // Сохранение аудио
            if (microphoneChunks.length > 0) {
                const micFile = path.join(app.getPath('downloads'), `microphone-${timestamp}.wav`);
                saveWavFileWithTimestamps(microphoneChunks, 48000, 2, micFile);
            }
            
            if (systemChunks.length > 0) {
                const sysFile = path.join(app.getPath('downloads'), `system-audio-${timestamp}.wav`);
                saveWavFileWithTimestamps(systemChunks, 48000, 2, sysFile);
            }
            
            // === СОХРАНЕНИЕ ВИДЕО ===
            if (videoFrames.length > 0) {
                const videoInfoFile = path.join(app.getPath('downloads'), `video-info-${timestamp}.json`);
                
                // Сохраняем метаданные видео
                const videoMetadata = {
                    frames: videoFrames.length,
                    framesWithData: videoFrameStats.savedFrames,
                    resolution: `${videoFrameStats.width}x${videoFrameStats.height}`,
                    pixelFormat: videoFrameStats.format,
                    duration: videoFrameStats.actualDuration,
                    avgFps: videoFrameStats.avgFps,
                    frameInfo: videoFrames.map(f => ({
                        timestamp: f.timestamp,
                        hasData: !!f.data,
                        dataSize: f.data ? f.data.length : 0
                    }))
                };
                
                fs.writeFileSync(videoInfoFile, JSON.stringify(videoMetadata, null, 2));
                log.info(`  ✅ Saved video metadata: ${videoInfoFile}`);
                savedFiles.push(videoInfoFile);
                
                // Если есть фреймы с пиксельными данными, сохраняем первый как пример
                const framesWithData = videoFrames.filter(f => f.data);
                if (framesWithData.length > 0) {
                    log.info(`  📹 Found ${framesWithData.length} frames with pixel data`);
                    
                    // Сохраняем несколько кадров как примеры (RAW формат)
                    const samplesToSave = Math.min(5, framesWithData.length);
                    for (let i = 0; i < samplesToSave; i++) {
                        const frame = framesWithData[Math.floor(i * framesWithData.length / samplesToSave)];
                        if (frame.data) {
                            const frameFile = path.join(app.getPath('downloads'), `frame-${timestamp}-${i}.raw`);
                            fs.writeFileSync(frameFile, frame.data);
                            log.info(`  ✅ Saved sample frame ${i}: ${frameFile} (${(frame.data.length / 1024).toFixed(1)} KB)`);
                            
                            // Также сохраним информацию о формате для этого фрейма
                            const frameInfoFile = path.join(app.getPath('downloads'), `frame-${timestamp}-${i}.json`);
                            fs.writeFileSync(frameInfoFile, JSON.stringify({
                                width: frame.width,
                                height: frame.height,
                                pixelFormat: frame.pixelFormat,
                                bytesPerRow: frame.bytesPerRow,
                                timestamp: frame.timestamp,
                                dataSize: frame.data.length,
                                expectedSize: frame.width * frame.height * 4 // для BGRA
                            }, null, 2));
                        }
                    }
                    
                    log.info(`  💡 Note: Video frames saved as RAW pixel data (${videoFrameStats.format} format)`);
                    log.info(`  💡 To convert to image: Use ffmpeg or image processing tool with ${videoFrameStats.width}x${videoFrameStats.height} ${videoFrameStats.format}`);
                } else {
                    log.warn(`  ⚠️ No video frames with pixel data were captured`);
                    log.info(`  💡 Video frame metadata saved, but no pixel data available`);
                }
            }
            
            log.info("=======================================");
            
            // === ВОЗВРАТ РЕЗУЛЬТАТА ===
            const hasVideo = videoFrameStats.totalFrames > 0;
            const hasVideoData = videoFrameStats.savedFrames > 0;
            const hasAudio = audioFrameCount > 0;
            
            if (!hasVideo && !hasAudio) {
                return {
                    success: false,
                    error: "No data captured at all",
                    stats: { video: videoFrameStats, audio: audioSourceStats }
                };
            }
            
            return {
                success: true,
                message: `Capture test completed. Video: ${hasVideo ? '✅' : '❌'} (data: ${hasVideoData ? '✅' : '❌'}), Audio: ${hasAudio ? '✅' : '❌'}`,
                files: savedFiles,
                stats: {
                    video: {
                        frames: videoFrameStats.totalFrames,
                        savedFrames: videoFrames.length,
                        framesWithData: videoFrameStats.savedFrames,
                        resolution: `${videoFrameStats.width}x${videoFrameStats.height}`,
                        format: videoFrameStats.format,
                        duration: videoFrameStats.actualDuration,
                        avgFps: videoFrameStats.avgFps
                    },
                    audio: {
                        frames: audioFrameCount,
                        microphone: audioSourceStats.microphone,
                        system: audioSourceStats.system,
                        micDuration: microphoneChunks.length > 0 ? 
                            (microphoneChunks[microphoneChunks.length - 1].timestamp - microphoneChunks[0].timestamp) : 0,
                        sysDuration: systemChunks.length > 0 ?
                            (systemChunks[systemChunks.length - 1].timestamp - systemChunks[0].timestamp) : 0
                    }
                }
            };
            
        } catch (error: any) {
            log.error(`❌ [Test] Fatal error: ${error.message}`);
            log.error(`❌ [Test] Stack: ${error.stack}`);
            
            try {
                await screenCaptureAddon.stopCapture();
            } catch (e) {}
            
            return {
                success: false,
                error: error.message
            };
        }
    });

  ipcMain.handle("check-native-methods", async () => {
      if (!screenCaptureAddon) {
          return { error: "Native addon not loaded" };
      }
      
      const methods = Object.keys(screenCaptureAddon).filter(key => 
          typeof screenCaptureAddon[key] === 'function'
      );
      
      const result = {
          methods: methods,
          hasGetVideoFrameData: typeof screenCaptureAddon.getVideoFrameData === 'function',
          hasGetAudioFrameData: typeof screenCaptureAddon.getAudioFrameData === 'function',
          hasSetCaptureSource: typeof screenCaptureAddon.setCaptureSource === 'function',
          hasStartCapture: typeof screenCaptureAddon.startCapture === 'function',
          hasStopCapture: typeof screenCaptureAddon.stopCapture === 'function',
      };
      
      log.info("🔍 Native addon check:", result);
      
      return result;
  });

  // Добавьте новый обработчик для создания native MediaStream для Jitsi
    ipcMain.handle("create-native-stream-for-jitsi", async (event) => {
        try {
            log.info("🎯 [NativeStream] Creating native MediaStream for Jitsi...");
            
            if (!screenCaptureAddon) {
                throw new Error("Native addon not loaded");
            }
            
            if (!jitsiWindow || jitsiWindow.isDestroyed()) {
                throw new Error("Jitsi window not found. Please open a conference first.");
            }
            
            let isStreamActive = true;
            let videoFrameCount = 0;
            let audioFrameCount = 0;
            
            // Создаем MediaStream в Jitsi окне
            const streamCreationResult = await jitsiWindow.webContents.executeJavaScript(`
                (async function() {
                    console.log('🎯 [NativeStream] Starting MediaStream creation in Jitsi context...');
                    
                    // === СОЗДАЕМ CANVAS ДЛЯ ВИДЕО ===
                    const canvas = document.createElement('canvas');
                    canvas.width = 1920;
                    canvas.height = 1080;
                    canvas.style.display = 'none';
                    document.body.appendChild(canvas);
                    
                    const ctx = canvas.getContext('2d', {
                        alpha: false,
                        desynchronized: true
                    });
                    
                    if (!ctx) {
                        throw new Error('Failed to get canvas context');
                    }
                    
                    // === СОЗДАЕМ AUDIO CONTEXT ДЛЯ СИСТЕМНОГО ЗВУКА ===
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)({
                        sampleRate: 48000,
                        latencyHint: 'interactive'
                    });
                    
                    const scriptProcessor = audioContext.createScriptProcessor(4096, 0, 2);
                    const audioBufferQueue = [];
                    let isActive = true;
                    let frameCount = 0;
                    let audioFramesReceived = 0;
                    
                    scriptProcessor.onaudioprocess = (event) => {
                        if (!isActive) return;
                        
                        const outputBuffer = event.outputBuffer;
                        
                        for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
                            const outputData = outputBuffer.getChannelData(channel);
                            
                            if (audioBufferQueue.length > 0) {
                                const audioData = audioBufferQueue.shift();
                                if (audioData && audioData[channel]) {
                                    outputData.set(audioData[channel]);
                                } else {
                                    outputData.fill(0);
                                }
                            } else {
                                outputData.fill(0);
                            }
                        }
                    };
                    
                    const destination = audioContext.createMediaStreamDestination();
                    scriptProcessor.connect(destination);
                    
                    // === СОЗДАЕМ MEDIASTREAM ===
                    const videoStream = canvas.captureStream(30);
                    const videoTrack = videoStream.getVideoTracks()[0];
                    const audioTrack = destination.stream.getAudioTracks()[0];
                    
                    if (videoTrack) {
                        videoTrack.contentHint = 'detail';
                        console.log('🎯 [NativeStream] Video track created');
                    }
                    
                    if (audioTrack) {
                        audioTrack._isSystemAudio = true;
                        console.log('🎯 [NativeStream] Audio track created (system audio)');
                    }
                    
                    const combinedStream = new MediaStream();
                    if (videoTrack) combinedStream.addTrack(videoTrack);
                    if (audioTrack) combinedStream.addTrack(audioTrack);
                    
                    console.log('🎯 [NativeStream] Combined stream created with', combinedStream.getTracks().length, 'tracks');
                    
                    // === СОХРАНЯЕМ ГЛОБАЛЬНО ===
                    window._nativeStream = combinedStream;
                    window._nativeCanvas = canvas;
                    window._nativeCtx = ctx;
                    window._nativeAudioQueue = audioBufferQueue;
                    window._nativeAudioContext = audioContext;
                    window._isNativeStreamActive = true;
                    
                    // === ФУНКЦИЯ ОБНОВЛЕНИЯ ВИДЕО ===
                    window._updateNativeVideo = function(width, height) {
                        if (!window._isNativeStreamActive || !ctx) return;
                        
                        frameCount++;
                        
                        try {
                            // Обновляем размер canvas если нужно
                            if (canvas.width !== width || canvas.height !== height) {
                                canvas.width = width;
                                canvas.height = height;
                                console.log('🎯 [NativeStream] Canvas resized to', width, 'x', height);
                            }
                            
                            // Рисуем тестовый паттерн с анимацией
                            const time = Date.now() / 1000;
                            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
                            gradient.addColorStop(0, 'hsl(' + ((time * 30) % 360) + ', 100%, 50%)');
                            gradient.addColorStop(0.5, 'hsl(' + ((time * 30 + 120) % 360) + ', 100%, 40%)');
                            gradient.addColorStop(1, 'hsl(' + ((time * 30 + 240) % 360) + ', 100%, 30%)');
                            
                            ctx.fillStyle = gradient;
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            
                            ctx.fillStyle = 'white';
                            ctx.font = 'bold 60px Arial';
                            ctx.textAlign = 'center';
                            ctx.shadowColor = 'rgba(0,0,0,0.5)';
                            ctx.shadowBlur = 10;
                            ctx.fillText('🎯 NATIVE CAPTURE', canvas.width/2, canvas.height/2 - 50);
                            ctx.fillText('🔊 System Audio', canvas.width/2, canvas.height/2 + 50);
                            ctx.font = '40px Arial';
                            ctx.fillText('Frame: ' + frameCount, canvas.width/2, canvas.height/2 + 120);
                            
                            if (frameCount % 30 === 0) {
                                console.log('🎯 [NativeStream] Video frames:', frameCount);
                            }
                        } catch (error) {
                            console.error('🎯 [NativeStream] Error updating video:', error);
                        }
                    };
                    
                    // === ФУНКЦИЯ ДОБАВЛЕНИЯ АУДИО ===
                    window._addNativeAudio = function(channelData) {
                        if (!window._isNativeStreamActive) return;
                        
                        audioFramesReceived++;
                        
                        try {
                            if (channelData && channelData.length === 2) {
                                audioBufferQueue.push(channelData);
                                
                                if (audioBufferQueue.length > 20) {
                                    audioBufferQueue.shift();
                                }
                                
                                if (audioFramesReceived % 100 === 0) {
                                    console.log('🎯 [NativeStream] Audio frames:', audioFramesReceived);
                                }
                            }
                        } catch (error) {
                            console.error('🎯 [NativeStream] Error adding audio:', error);
                        }
                    };
                    
                    // Начальная отрисовка
                    window._updateNativeVideo(1920, 1080);
                    
                    // === ИНДИКАТОР ===
                    const indicator = document.createElement('div');
                    indicator.id = 'native-stream-indicator';
                    indicator.style.cssText = \`
                        position: fixed;
                        bottom: 20px;
                        left: 20px;
                        background: linear-gradient(135deg, #4CAF50, #66BB6A);
                        color: white;
                        padding: 12px 20px;
                        border-radius: 25px;
                        z-index: 100000;
                        font-size: 14px;
                        font-weight: 600;
                        box-shadow: 0 4px 20px rgba(76, 175, 80, 0.5);
                    \`;
                    indicator.textContent = '🎯 Native Stream Active';
                    document.body.appendChild(indicator);
                    
                    // === ФУНКЦИЯ ОСТАНОВКИ ===
                    window._stopNativeStream = function() {
                        console.log('🎯 [NativeStream] Stopping...');
                        window._isNativeStreamActive = false;
                        
                        combinedStream.getTracks().forEach(track => track.stop());
                        scriptProcessor.disconnect();
                        audioContext.close();
                        
                        canvas.remove();
                        indicator.remove();
                        
                        delete window._nativeStream;
                        delete window._nativeCanvas;
                        delete window._nativeCtx;
                        delete window._nativeAudioQueue;
                        delete window._updateNativeVideo;
                        delete window._addNativeAudio;
                        delete window._stopNativeStream;
                    };
                    
                    return {
                        success: true,
                        streamId: combinedStream.id,
                        hasVideo: !!videoTrack,
                        hasAudio: !!audioTrack
                    };
                })();
            `);
            
            log.info(`🎯 [NativeStream] Stream creation result: ${JSON.stringify(streamCreationResult)}`);
            
            if (!streamCreationResult.success) {
                throw new Error('Failed to create stream');
            }
            
            // Устанавливаем колбэки для native addon
            log.info("🎯 [NativeStream] Setting up native callbacks...");
            
            // Видео колбэк - упрощенный, только обновляем размеры
            screenCaptureAddon.setWebRTCVideoCallback((videoData: any) => {
                if (!isStreamActive) return;
                
                videoFrameCount++;
                
                if (videoData && !jitsiWindow.isDestroyed()) {
                    const width = videoData.width || 1920;
                    const height = videoData.height || 1080;
                    
                    // Обновляем canvas (пока без реальных пикселей)
                    jitsiWindow.webContents.executeJavaScript(`
                        if (window._updateNativeVideo) {
                            window._updateNativeVideo(${width}, ${height});
                        }
                    `).catch(() => {});
                }
                
                if (videoFrameCount % 100 === 0) {
                    log.info(`🎯 [NativeStream] Video frames: ${videoFrameCount}`);
                }
            });
            
            // Аудио колбэк - только системный звук
            screenCaptureAddon.setWebRTCAudioCallback((audioData: any) => {
                if (!isStreamActive) return;
                if (audioData?.source !== 'system') return;
                
                audioFrameCount++;
                
                if (audioData && audioData.data && !jitsiWindow.isDestroyed()) {
                    // Конвертируем аудио для Web Audio API
                    try {
                        const buffer = Buffer.isBuffer(audioData.data) ? audioData.data : Buffer.from(audioData.data);
                        const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
                        
                        const channels = 2;
                        const samplesPerChannel = Math.floor(int16Array.length / channels);
                        
                        // Создаем Float32 массивы для каждого канала
                        const channel0 = new Float32Array(samplesPerChannel);
                        const channel1 = new Float32Array(samplesPerChannel);
                        
                        for (let i = 0; i < samplesPerChannel; i++) {
                            channel0[i] = int16Array[i * 2] / 32768.0;
                            channel1[i] = int16Array[i * 2 + 1] / 32768.0;
                        }
                        
                        // Передаем как JSON массивы
                        jitsiWindow.webContents.executeJavaScript(`
                            if (window._addNativeAudio) {
                                window._addNativeAudio([
                                    new Float32Array([${Array.from(channel0).join(',')}]),
                                    new Float32Array([${Array.from(channel1).join(',')}])
                                ]);
                            }
                        `).catch(() => {});
                        
                    } catch (e) {
                        // Игнорируем ошибки конвертации
                    }
                }
                
                if (audioFrameCount % 200 === 0) {
                    log.info(`🎯 [NativeStream] Audio frames: ${audioFrameCount}`);
                }
            });
            
            // Запускаем захват
            log.info("🎯 [NativeStream] Starting native capture...");
            
            try {
                const startResult = await screenCaptureAddon.startCapture();
                log.info(`🎯 [NativeStream] Capture started: ${JSON.stringify(startResult)}`);
            } catch (error: any) {
                if (error.message.includes("not initialized")) {
                    const pickerResult = await screenCaptureAddon.selectSourceWithPicker();
                    if (pickerResult && pickerResult.type && pickerResult.id) {
                        await screenCaptureAddon.setCaptureSource({
                            type: pickerResult.type,
                            id: String(pickerResult.id)
                        });
                        await screenCaptureAddon.startCapture();
                    } else {
                        throw new Error("User cancelled source selection");
                    }
                } else {
                    throw error;
                }
            }
            
            // Пробуем передать stream в Jitsi
            log.info("🎯 [NativeStream] Attempting to share stream in Jitsi...");
            
            const shareResult = await jitsiWindow.webContents.executeJavaScript(`
                (async function() {
                    console.log('🎯 [NativeStream] Attempting to share native stream...');
                    
                    if (!window._nativeStream) {
                        return { success: false, error: 'Native stream not found' };
                    }
                    
                    try {
                        // Проверяем разные варианты API
                        if (window.APP && window.APP.conference) {
                            // Вариант 1: executeCommand
                            if (typeof window.APP.conference.executeCommand === 'function') {
                                console.log('🎯 [NativeStream] Using executeCommand...');
                                
                                // Подменяем getDisplayMedia
                                const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                                navigator.mediaDevices.getDisplayMedia = async () => window._nativeStream;
                                
                                // Запускаем демонстрацию экрана
                                window.APP.conference.executeCommand('toggleShareScreen');
                                
                                // Восстанавливаем через 100ms
                                setTimeout(() => {
                                    navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
                                }, 100);
                                
                                return { success: true, method: 'executeCommand' };
                            }
                            
                            // Вариант 2: прямой вызов
                            if (window.APP.conference.toggleScreenSharing) {
                                await window.APP.conference.toggleScreenSharing();
                                return { success: true, method: 'toggleScreenSharing' };
                            }
                            
                            // Вариант 3: через API
                            if (window.APP.API && window.APP.API.executeCommand) {
                                const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                                navigator.mediaDevices.getDisplayMedia = async () => window._nativeStream;
                                
                                window.APP.API.executeCommand('toggleShareScreen');
                                
                                setTimeout(() => {
                                    navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
                                }, 100);
                                
                                return { success: true, method: 'API.executeCommand' };
                            }
                        }
                        
                        // Вариант 4: Поиск кнопки
                        const shareButton = document.querySelector('[aria-label*="screen"], [aria-label*="Share"], [aria-label*="Демонстрация"]');
                        if (shareButton) {
                            const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                            navigator.mediaDevices.getDisplayMedia = async () => window._nativeStream;
                            
                            shareButton.click();
                            
                            setTimeout(() => {
                                navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
                            }, 100);
                            
                            return { success: true, method: 'button click' };
                        }
                        
                        return { success: false, error: 'No suitable method found' };
                        
                    } catch (error) {
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            log.info(`🎯 [NativeStream] Share result: ${JSON.stringify(shareResult)}`);
            
            // Обработчик закрытия окна
            if (jitsiWindow) {
                jitsiWindow.once('closed', async () => {
                    log.info("🎯 [NativeStream] Jitsi window closed, stopping stream...");
                    isStreamActive = false;
                    
                    try {
                        await screenCaptureAddon.stopCapture();
                    } catch (e: any) {
                        log.error(`🎯 [NativeStream] Error stopping capture: ${e.message}`);
                    }
                });
            }
            
            // Возвращаем результат БЕЗ функций (чтобы избежать ошибки клонирования)
            return {
                success: true,
                message: "Native stream created",
                stats: {
                    videoFrames: videoFrameCount,
                    audioFrames: audioFrameCount,
                    streamId: streamCreationResult.streamId,
                    shareResult: shareResult
                }
            };
            
        } catch (error: any) {
            log.error(`🎯 [NativeStream] Error: ${error.message}`);
            
            try {
                await screenCaptureAddon.stopCapture();
            } catch (e) {}
            
            return {
                success: false,
                error: error.message
            };
        }
    });







  // Обработчики событий от Jitsi окна
  ipcMain.on('jitsi-api-ready', (event, data) => {
      log.info(`🎯[Jitsi] API ready in window: ${JSON.stringify(data)}`);
      sendEventToZulip('jitsi-api-ready', data);
  });

  ipcMain.on('jitsi-conference-joined', () => {
      log.info(`🎯[Jitsi] User joined conference`);
      sendEventToZulip('jitsi-conference-joined', {});
  });

  ipcMain.on('jitsi-conference-left', () => {
      log.info(`🎯[Jitsi] User left conference`);
      sendEventToZulip('jitsi-conference-left', {});
  });





  // Добавить простой обработчик для прямого тестирования
  ipcMain.handle("get-electron-sources-raw", async () => {
    log.info("🎯[RAW] Getting raw Electron sources...");
    
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window']
      });
      
      log.info(`🎯[RAW] Got ${sources.length} raw sources`);
      return sources;
      
    } catch (error: any) {
      log.error(`🎯[RAW] Error: ${error.message}`);
      throw error;
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

  ipcMain.on('electron-bridge-event', async (event, data) => {
      log.info(`Main: electron_bridge event: ${data.event}`);
      
      if (data.event === 'requestDesktopSources') {
          log.info('🔍 ========== DESKTOP SOURCES REQUEST START ==========');
          
          try {
              let sources = [];
              let sourceType = 'unknown';
              let debugInfo = {
                  nativeAddonExists: !!screenCaptureAddon,
                  hasGetAvailableSources: false,
                  nativeSourcesCount: 0,
                  nativeError: null,
                  electronSourcesCount: 0,
                  finalSourceType: null
              };
              
              // ПРОВЕРКА 1: Native addon загружен?
              log.info(`🔍 Step 1: Checking native addon...`);
              log.info(`  - screenCaptureAddon exists: ${!!screenCaptureAddon}`);
              
              if (screenCaptureAddon) {
                  log.info(`  - screenCaptureAddon type: ${typeof screenCaptureAddon}`);
                  log.info(`  - Available methods: ${Object.keys(screenCaptureAddon).filter(k => typeof screenCaptureAddon[k] === 'function').join(', ')}`);
                  
                  debugInfo.hasGetAvailableSources = typeof screenCaptureAddon.getAvailableSources === 'function';
                  log.info(`  - Has getAvailableSources: ${debugInfo.hasGetAvailableSources}`);
                  
                  if (debugInfo.hasGetAvailableSources) {
                      try {
                          log.info(`🔍 Step 2: Calling native getAvailableSources...`);
                          const startTime = Date.now();
                          
                          const nativeSources = await screenCaptureAddon.getAvailableSources();
                          
                          const elapsed = Date.now() - startTime;
                          log.info(`  - Native call completed in ${elapsed}ms`);
                          log.info(`  - Native sources type: ${typeof nativeSources}`);
                          log.info(`  - Is array: ${Array.isArray(nativeSources)}`);
                          log.info(`  - Native sources count: ${nativeSources ? nativeSources.length : 'null'}`);
                          
                          if (nativeSources && nativeSources.length > 0) {
                              debugInfo.nativeSourcesCount = nativeSources.length;
                              
                              // Логируем первые несколько источников для примера
                              nativeSources.slice(0, 3).forEach((source, i) => {
                                  log.info(`  - Native source ${i}: ${JSON.stringify({
                                      id: source.id,
                                      name: source.name,
                                      type: source.type
                                  })}`);
                              });
                              
                              sourceType = 'native-addon';
                              log.info(`✅ USING NATIVE SOURCES (${nativeSources.length} found)`);
                              
                              // Форматируем native источники
                              sources = nativeSources.map((source, index) => ({
                                  id: `native:${source.type === 'window' ? 'window' : 'screen'}:${source.id || index}`,
                                  name: `🎯 [NATIVE] ${source.name || `Source ${index}`}`,
                                  thumbnail: {
                                      dataUrl: createSourceThumbnail(source)
                                  },
                                  isNative: true,
                                  originalId: source.id
                              }));
                              
                          } else {
                              log.warn(`⚠️ Native returned empty or null: ${JSON.stringify(nativeSources)}`);
                          }
                          
                      } catch (error) {
                          debugInfo.nativeError = error.message;
                          log.error(`❌ Native addon error: ${error.message}`);
                          log.error(`  Stack: ${error.stack}`);
                      }
                  } else {
                      log.error(`❌ Native addon missing getAvailableSources method!`);
                  }
              } else {
                  log.error(`❌ Native addon not loaded at all!`);
              }
              
              // ПРОВЕРКА 2: Если нет native источников - используем Electron?
              if (sources.length === 0) {
                  log.info(`🔍 Step 3: No native sources, trying Electron fallback...`);
                  
                  // Для тестирования - проверяем флаг Native Only Mode
                  const useNativeOnly = true; // ИЗМЕНИТЕ НА false ЧТОБЫ ВКЛЮЧИТЬ ELECTRON
                  
                  if (useNativeOnly) {
                      log.warn(`🚫 NATIVE ONLY MODE - Not using Electron fallback!`);
                      sourceType = 'none';
                  } else {
                      log.info(`📺 Using Electron desktopCapturer...`);
                      
                      const electronSources = await desktopCapturer.getSources({
                          types: ['screen', 'window'],
                          thumbnailSize: { width: 300, height: 200 }
                      });
                      
                      debugInfo.electronSourcesCount = electronSources.length;
                      log.info(`  - Electron sources found: ${electronSources.length}`);
                      
                      // Логируем первые несколько Electron источников
                      electronSources.slice(0, 3).forEach((source, i) => {
                          log.info(`  - Electron source ${i}: ${source.name} (${source.id})`);
                      });
                      
                      sourceType = 'electron';
                      sources = electronSources.map(source => ({
                          id: `electron:${source.id}`,
                          name: `📺 [ELECTRON] ${source.name}`,
                          thumbnail: {
                              dataUrl: source.thumbnail.toDataURL()
                          },
                          isNative: false,
                          originalId: source.id
                      }));
                  }
              }
              
              debugInfo.finalSourceType = sourceType;
              
              // ИТОГОВОЕ ЛОГИРОВАНИЕ
              log.info('🔍 ========== FINAL RESULT ==========');
              log.info(`  Source type: ${sourceType}`);
              log.info(`  Total sources: ${sources.length}`);
              log.info(`  Debug info: ${JSON.stringify(debugInfo, null, 2)}`);
              log.info('🔍 ========== REQUEST END ==========');
              
              // Отправляем в Jitsi окно
              if (jitsiWindow && !jitsiWindow.isDestroyed()) {
                  await jitsiWindow.webContents.executeJavaScript(`
                      (function() {
                          console.log('🔍 SOURCES RECEIVED IN JITSI:');
                          console.log('  Type: ${sourceType}');
                          console.log('  Count: ${sources.length}');
                          console.log('  Debug: ${JSON.stringify(debugInfo)}');
                          
                          // Показываем большое уведомление с информацией
                          const info = document.createElement('div');
                          info.style.cssText = \`
                              position: fixed;
                              top: 50%;
                              left: 50%;
                              transform: translate(-50%, -50%);
                              background: white;
                              padding: 20px;
                              border-radius: 12px;
                              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                              z-index: 100000;
                              max-width: 500px;
                          \`;
                          info.innerHTML = \`
                              <h3 style="margin-top: 0;">🔍 Источники демонстрации</h3>
                              <div style="background: #f5f5f5; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px;">
                                  <div><strong>Тип:</strong> ${sourceType === 'native-addon' ? '🎯 NATIVE' : sourceType === 'electron' ? '📺 ELECTRON' : '🚫 NONE'}</div>
                                  <div><strong>Количество:</strong> ${sources.length}</div>
                                  <div><strong>Native addon:</strong> ${debugInfo.nativeAddonExists ? '✅' : '❌'}</div>
                                  <div><strong>Native sources:</strong> ${debugInfo.nativeSourcesCount}</div>
                                  <div><strong>Electron sources:</strong> ${debugInfo.electronSourcesCount}</div>
                                  ${debugInfo.nativeError ? '<div style="color: red;"><strong>Error:</strong> ' + debugInfo.nativeError + '</div>' : ''}
                              </div>
                              <button onclick="this.parentElement.remove()" style="
                                  margin-top: 16px;
                                  background: #667eea;
                                  color: white;
                                  border: none;
                                  padding: 8px 16px;
                                  border-radius: 6px;
                                  cursor: pointer;
                              ">OK</button>
                          \`;
                          document.body.appendChild(info);
                          
                          // Автоудаление через 10 секунд
                          setTimeout(() => {
                              if (info.parentElement) info.remove();
                          }, 10000);
                          
                          // Эмитим событие
                          if (window.electron_bridge && window.electron_bridge.emit_event) {
                              window.electron_bridge.emit_event('desktop-sources-response', {
                                  sources: ${JSON.stringify(sources)},
                                  sourceType: '${sourceType}'
                              });
                          }
                          
                          return true;
                      })();
                  `);
              }
              
          } catch (error) {
              log.error(`🔍 CRITICAL ERROR: ${error.message}`);
              log.error(`  Stack: ${error.stack}`);
          }
      }
  });

  ipcMain.on('ipc-invoke', async (event, data) => {
      log.info(`Main: Synthetic IPC invoke: ${data.channel}`);
      
      try {
          let result;
          
          // Роутинг к существующим обработчикам
          if (data.channel === 'jitsi-connect-with-zulip-config') {
              result = await ipcMain.handle(data.channel, event, ...data.args);
          } else if (data.channel === 'test-zulip-bridge') {
              result = await ipcMain.handle(data.channel, event, ...data.args);
          } else {
              throw new Error(`Unknown channel: ${data.channel}`);
          }
          
          // Отправляем ответ обратно
          event.sender.executeJavaScript(`
              window.dispatchEvent(new CustomEvent('ipc-response', {
                  detail: {
                      requestId: ${data.requestId},
                      data: ${JSON.stringify(result)},
                      error: null
                  }
              }));
          `);
          
      } catch (error) {
          log.error(`Main: IPC invoke error: ${error.message}`);
          
          event.sender.executeJavaScript(`
              window.dispatchEvent(new CustomEvent('ipc-response', {
                  detail: {
                      requestId: ${data.requestId},
                      data: null,
                      error: "${error.message}"
                  }
              }));
          `);
      }
  });


  ipcMain.handle("share-native-stream-to-jitsi", async () => {
      log.info("🎯[NativeStream] Sharing native stream to Jitsi...");
      
      if (!jitsiWindow || jitsiWindow.isDestroyed()) {
          return { success: false, error: 'No active Jitsi window' };
      }
      
      try {
          const result = await jitsiWindow.webContents.executeJavaScript(`
              (function() {
                  if (typeof window.receiveNativeStream === 'function') {
                      return window.receiveNativeStream({ type: 'electron-native' });
                  } else {
                      return { success: false, error: 'receiveNativeStream not ready yet' };
                  }
              })();
          `);
          
          log.info(`🎯[NativeStream] Result: ${JSON.stringify(result)}`);
          return result;
          
      } catch (error: any) {
          log.error(`🎯[NativeStream] Error: ${error.message}`);
          return { success: false, error: error.message };
      }
  });

  // Тестовый обработчик для проверки связи с Zulip
  ipcMain.handle("test-zulip-bridge", async () => {
      log.info("🧪[Test] Testing Zulip bridge...");
      
      const result = {
          zulipFound: false,
          currentUserName: 'Unknown',
          currentUserEmail: 'Unknown', 
          hasElectronBridge: false,
          hasIpcRenderer: false,
          totalWebContents: 0,
          zulipUrl: '',
          error: null
      };
      
      try {
          const allContents = webContents.getAllWebContents();
          result.totalWebContents = allContents.length;
          
          for (const content of allContents) {
              const url = content.getURL();
              
              if (url && url.includes('joinrm-svz')) {
                  result.zulipFound = true;
                  result.zulipUrl = url;
                  log.info(`🧪[Test] Found Zulip at: ${url}`);
                  
                  try {
                      const testResult = await content.executeJavaScript(`
                          (function() {
                              const hasElectronBridge = typeof window.electron_bridge !== 'undefined';
                              const hasIpcRenderer = typeof window.ipcRenderer !== 'undefined';
                              
                              let userName = 'Unknown';
                              let userEmail = 'Unknown';
                              
                              if (typeof current_user !== 'undefined' && current_user) {
                                  userName = String(current_user.full_name || 'Unknown');
                                  userEmail = String(current_user.email || 'Unknown');
                              }
                              
                              return {
                                  hasElectronBridge: hasElectronBridge,
                                  hasIpcRenderer: hasIpcRenderer,
                                  userName: userName,
                                  userEmail: userEmail,
                                  location: window.location.href,
                                  
                                  // Детали API
                                  electronBridgeOk: hasElectronBridge && 
                                      typeof window.electron_bridge.on_event === 'function' &&
                                      typeof window.electron_bridge.send_event === 'function',
                                      
                                  ipcRendererOk: hasIpcRenderer &&
                                      typeof window.ipcRenderer.invoke === 'function' &&
                                      typeof window.ipcRenderer.send === 'function'
                              };
                          })();
                      `);
                      
                      result.currentUserName = testResult.userName;
                      result.currentUserEmail = testResult.userEmail;
                      result.hasElectronBridge = testResult.electronBridgeOk;
                      result.hasIpcRenderer = testResult.ipcRendererOk;
                      
                      log.info(`🧪[Test] User: ${testResult.userName}, Bridge: ${testResult.electronBridgeOk}, IPC: ${testResult.ipcRendererOk}`);
                      
                  } catch (execError: any) {
                      log.error(`🧪[Test] Error executing in Zulip: ${execError.message}`);
                      result.error = execError.message;
                  }
                  break;
              }
          }
          
          log.info(`🧪[Test] Final result: ${JSON.stringify(result)}`);
          return result;
          
      } catch (error: any) {
          log.error(`🧪[Test] Error: ${error.message}`);
          result.error = error.message;
          return result;
      }
  });


  ipcMain.handle("start-native-stream-in-jitsi", async () => {
      log.info("🎯[NativeStream] Starting native stream in Jitsi window...");
      
      try {
          // Проверяем, что Jitsi окно открыто
          if (!jitsiWindow || jitsiWindow.isDestroyed()) {
              throw new Error("Jitsi window not found. Open conference first.");
          }
          
          // Проверяем наличие native addon
          if (!screenCaptureAddon) {
              throw new Error("Native addon not loaded");
          }
          
          // Инжектируем код создания native stream в Jitsi окно
          const result = await jitsiWindow.webContents.executeJavaScript(`
              (async function() {
                  console.log('[NativeStream] Starting native stream injection...');
                  
                  // Создаем тестовый MediaStream с красивой анимацией
                  const canvas = document.createElement('canvas');
                  canvas.width = 1920;
                  canvas.height = 1080;
                  const ctx = canvas.getContext('2d');
                  
                  if (!ctx) {
                      throw new Error('Failed to get canvas context');
                  }
                  
                  let frame = 0;
                  let isActive = true;
                  
                  function animate() {
                      if (!isActive) return;
                      frame++;
                      
                      // Градиентный фон
                      const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 800);
                      gradient.addColorStop(0, 'hsl(' + (frame % 360) + ', 100%, 50%)');
                      gradient.addColorStop(0.5, 'hsl(' + ((frame + 120) % 360) + ', 100%, 40%)');
                      gradient.addColorStop(1, 'hsl(' + ((frame + 240) % 360) + ', 100%, 30%)');
                      ctx.fillStyle = gradient;
                      ctx.fillRect(0, 0, 1920, 1080);
                      
                      // Основной текст
                      ctx.fillStyle = 'white';
                      ctx.font = 'bold 100px Arial';
                      ctx.textAlign = 'center';
                      ctx.shadowColor = 'rgba(0,0,0,0.8)';
                      ctx.shadowBlur = 20;
                      ctx.fillText('🎯 NATIVE STREAM', 960, 400);
                      
                      ctx.font = 'bold 60px Arial';
                      ctx.fillText('Изоляция звука активна', 960, 500);
                      
                      ctx.font = '40px Arial';
                      ctx.fillText('Frame: ' + frame, 960, 600);
                      ctx.fillText(new Date().toLocaleTimeString(), 960, 680);
                      
                      // Индикатор активности
                      ctx.beginPath();
                      ctx.arc(100, 100, 40, 0, 2 * Math.PI);
                      ctx.fillStyle = (frame % 60 < 30) ? '#4CAF50' : '#FF5722';
                      ctx.fill();
                      
                      requestAnimationFrame(animate);
                  }
                  animate();
                  
                  const stream = canvas.captureStream(30);
                  console.log('[NativeStream] Stream created:', stream.id);
                  
                  // Останавливаем через 60 секунд
                  setTimeout(() => {
                      isActive = false;
                      stream.getTracks().forEach(track => track.stop());
                      console.log('[NativeStream] Stream stopped after timeout');
                  }, 60000);
                  
                  // Пробуем передать stream в Jitsi через различные API
                  try {
                      // Метод 1: Через APP.conference API
                      if (window.APP && window.APP.conference) {
                          // Останавливаем текущую трансляцию если есть
                          if (window.APP.conference.isLocalVideoMuted && !window.APP.conference.isLocalVideoMuted()) {
                              await window.APP.conference.muteVideo(true);
                          }
                          
                          // Пробуем переключить на desktop sharing с нашим stream
                          if (typeof window.APP.conference.toggleScreenSharing === 'function') {
                              // Сохраняем оригинальный getUserMedia
                              const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                              const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                              
                              // Подменяем getDisplayMedia чтобы вернуть наш stream
                              navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                                  console.log('[NativeStream] Intercepted getDisplayMedia, returning custom stream');
                                  return stream;
                              };
                              
                              // Включаем screen sharing
                              await window.APP.conference.toggleScreenSharing();
                              
                              // Восстанавливаем оригинальные функции через 100ms
                              setTimeout(() => {
                                  navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
                                  console.log('[NativeStream] Restored original getDisplayMedia');
                              }, 100);
                              
                              return { success: true, method: 'toggleScreenSharing with override' };
                          }
                          
                          // Метод 2: Прямая замена треков
                          if (window.APP.conference.room && window.APP.conference.room.replaceTrack) {
                              const videoTrack = stream.getVideoTracks()[0];
                              if (videoTrack) {
                                  await window.APP.conference.room.replaceTrack(null, videoTrack);
                                  console.log('[NativeStream] Replaced track directly');
                                  return { success: true, method: 'replaceTrack' };
                              }
                          }
                          
                          // Метод 3: Через JitsiMeetJS если доступен
                          if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                              console.log('[NativeStream] Trying JitsiMeetJS approach...');
                              // Этот метод сложнее и требует более глубокой интеграции
                          }
                          
                          return { success: false, error: 'No suitable API method found' };
                      } else {
                          // Если конференция еще не готова, ждем и пробуем снова
                          console.log('[NativeStream] Conference not ready, waiting...');
                          
                          return new Promise((resolve) => {
                              let attempts = 0;
                              const checkInterval = setInterval(() => {
                                  attempts++;
                                  if (window.APP && window.APP.conference) {
                                      clearInterval(checkInterval);
                                      // Рекурсивно вызываем себя
                                      resolve({ success: false, error: 'Retry needed', retry: true });
                                  } else if (attempts > 20) {
                                      clearInterval(checkInterval);
                                      resolve({ success: false, error: 'Conference not initialized after 10 seconds' });
                                  }
                              }, 500);
                          });
                      }
                  } catch (error) {
                      console.error('[NativeStream] Error injecting stream:', error);
                      return { success: false, error: error.message };
                  }
              })();
          `);
          
          log.info(`🎯[NativeStream] Injection result: ${JSON.stringify(result)}`);
          
          // Если нужен retry, пробуем еще раз
          if (result && result.retry) {
              log.info("🎯[NativeStream] Retrying after conference initialization...");
              await new Promise(resolve => setTimeout(resolve, 1000));
              return ipcMain.handle("start-native-stream-in-jitsi", null);
          }
          
          return result;
          
      } catch (error: any) {
          log.error(`🎯[NativeStream] Error: ${error.message}`);
          return { success: false, error: error.message };
      }
  });

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

  // Обработчик запуска нативного захвата
  ipcMain.handle("start-native-capture", async (event, sourceId: string) => {
      try {
          log.info(`🎯[NativeCapture] Starting capture for source: ${sourceId}`);
          
          if (!screenCaptureAddon) {
              throw new Error("Native addon not loaded");
          }
          
          let realSourceId = sourceId;
          
          // Проверяем маппинг для получения оригинального ID
          if (sourceId && sourceId.includes(':')) {
              if (global.nativeSourceMapping && global.nativeSourceMapping.has(sourceId)) {
                  realSourceId = global.nativeSourceMapping.get(sourceId);
                  log.info(`🎯[NativeCapture] Mapped ${sourceId} to original: ${realSourceId}`);
              } else {
                  // Извлекаем числовую часть
                  const parts = sourceId.split(':');
                  realSourceId = parts[1];
                  log.info(`🎯[NativeCapture] Extracted ID: ${realSourceId}`);
              }
          }
          
          // Запускаем захват с оригинальным ID
          const result = await screenCaptureAddon.startCapture(realSourceId);
          log.info(`🎯[NativeCapture] Capture started: ${JSON.stringify(result)}`);
          
          return { success: true };
          
      } catch (error: any) {
          log.error(`🎯[NativeCapture] Error: ${error.message}`);
          return { success: false, error: error.message };
      }
  });

  // Обработчик остановки захвата
  ipcMain.handle("stop-native-capture", async () => {
    try {
      log.info("🎯[NativeCapture] Stopping capture");
      
      isNativeCapturing = false;
      currentNativeCaptureId = null;
      
      // Останавливаем сбор фреймов
      if (frameCollectionInterval) {
        clearInterval(frameCollectionInterval);
        frameCollectionInterval = null;
      }
      
      // Очищаем буферы
      nativeVideoFrames = [];
      nativeAudioFrames = [];
      
      // Останавливаем нативный захват
      if (screenCaptureAddon) {
        await screenCaptureAddon.stopCapture();
      }
      
      log.info("🎯[NativeCapture] Capture stopped");
      return { success: true };
      
    } catch (error: any) {
      log.error(`🎯[NativeCapture] Error stopping capture: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // Обработчик получения статуса захвата
  ipcMain.handle("get-capture-status", async () => {
    return {
      isCapturing: isNativeCapturing,
      currentSourceId: currentNativeCaptureId
    };
  });

  // Обработчик получения фреймов
  ipcMain.handle("get-native-frames", async () => {
      if (!screenCaptureAddon) {
          return { audio: [], video: [] };
      }
      
      const result = { audio: [], video: [] };
      
      try {
          // Используем правильные названия методов
          if (typeof screenCaptureAddon.getVideoFrameData === 'function') {
              try {
                  const frameData = await screenCaptureAddon.getVideoFrameData();
                  if (frameData && frameData.data) {
                      result.video = [frameData.data];
                  }
              } catch (e) {
                  log.error(`Error getting video frame: ${e}`);
              }
          }
          
          if (typeof screenCaptureAddon.getAudioFrameData === 'function') {
              try {
                  const frameData = await screenCaptureAddon.getAudioFrameData();
                  if (frameData && frameData.data) {
                      result.audio = [frameData.data];
                  }
              } catch (e) {
                  log.error(`Error getting audio frame: ${e}`);
              }
          }
          
      } catch (error) {
          log.error(`Error getting frames: ${error}`);
      }
      
      return result;
  });

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



async function getAvailableSources(): Promise<Electron.DesktopCapturerSource[]> {
  log.info("🎯[NativeCapture] Fetching available sources...");

  // 1. Попробуем нативный способ
  if (screenCaptureAddon && typeof screenCaptureAddon.getAvailableSources === 'function') {
    try {
      const sources = await screenCaptureAddon.getAvailableSources();
      log.info(`🎯[NativeCapture] Swift returned ${sources.length} sources`);
      return sources;
    } catch (error) {
      log.error("🎯[NativeCapture] Error from native getSources:", error);
    }
  }

  // // 2. Fallback на Electron
  // log.info("🎯[NativeCapture] Using Electron desktopCapturer fallback");
  // return desktopCapturer.getSources({ types: ['screen', 'window'] });
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


