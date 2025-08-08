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

if (typeof setupScreenSharingMain === 'function') {
  log.info('✅ setupScreenSharingMain доступна и является функцией');
} else {
  log.error('❌ setupScreenSharingMain не доступна! Проверьте установку пакета @jitsi/electron-sdk');
}



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
        if (params.src && params.src.includes('localhost:9991')) {
            log.info(`Main: Устанавливаем preload для Zulip: ${preloadPath}`);
            webPreferences.preload = preloadPath;
        }
        
        log.info(`Main: Webview preload установлен: ${preloadPath}`);
    });

    // НОВОЕ: Слушаем создание новых webContents
    app.on('web-contents-created', (event, contents) => {
        const url = contents.getURL();
        log.info(`Main: Новый webContents создан: ${url}`);
        
        // Если это Zulip, инжектируем наши API
        if (url.includes('localhost:9991')) {
            log.info(`Main: Обнаружен Zulip webContents, инжектируем API...`);
            
            contents.once('dom-ready', () => {
                // Инжектируем electron_bridge и ipcRenderer в Zulip
                const injectionCode = `
                    (function() {
                        console.log('[Injection] 🎯 Injecting Electron APIs into Zulip...');
                        
                        // Создаем electron_bridge API
                        if (typeof window.electron_bridge === 'undefined') {
                            window.electron_bridge = {
                                events: new Map(),
                                
                                send_event: function(eventName, data) {
                                    console.log('[electron_bridge] Sending event:', eventName, data);
                                    
                                    // Отправляем в main process
                                    if (window.__ELECTRON_IPC__) {
                                        window.__ELECTRON_IPC__.send('electron-bridge-event', {
                                            event: eventName,
                                            data: data
                                        });
                                    }
                                },
                                
                                on_event: function(eventName, callback) {
                                    console.log('[electron_bridge] Listening for event:', eventName);
                                    
                                    if (!this.events.has(eventName)) {
                                        this.events.set(eventName, []);
                                    }
                                    this.events.get(eventName).push(callback);
                                },
                                
                                emit_event: function(eventName, data) {
                                    console.log('[electron_bridge] Emitting event:', eventName, data);
                                    
                                    if (this.events.has(eventName)) {
                                        this.events.get(eventName).forEach(callback => {
                                            try {
                                                callback(data);
                                            } catch (error) {
                                                console.error('[electron_bridge] Event callback error:', error);
                                            }
                                        });
                                    }
                                }
                            };
                            
                            console.log('[Injection] ✅ electron_bridge created');
                        }
                        
                        // Создаем ipcRenderer API
                        if (typeof window.ipcRenderer === 'undefined') {
                            window.ipcRenderer = {
                                invoke: async function(channel, ...args) {
                                    console.log('[ipcRenderer] Invoke:', channel, args);
                                    
                                    return new Promise((resolve, reject) => {
                                        const requestId = Date.now() + Math.random();
                                        
                                        // Слушаем ответ
                                        const responseHandler = (event, response) => {
                                            if (response.requestId === requestId) {
                                                window.removeEventListener('ipc-response', responseHandler);
                                                if (response.error) {
                                                    reject(new Error(response.error));
                                                } else {
                                                    resolve(response.data);
                                                }
                                            }
                                        };
                                        
                                        window.addEventListener('ipc-response', responseHandler);
                                        
                                        // Отправляем запрос
                                        if (window.__ELECTRON_IPC__) {
                                            window.__ELECTRON_IPC__.send('ipc-invoke', {
                                                requestId: requestId,
                                                channel: channel,
                                                args: args
                                            });
                                        } else {
                                            reject(new Error('Electron IPC not available'));
                                        }
                                        
                                        // Таймаут
                                        setTimeout(() => {
                                            window.removeEventListener('ipc-response', responseHandler);
                                            reject(new Error('IPC timeout'));
                                        }, 10000);
                                    });
                                },
                                
                                send: function(channel, ...args) {
                                    console.log('[ipcRenderer] Send:', channel, args);
                                    
                                    if (window.__ELECTRON_IPC__) {
                                        window.__ELECTRON_IPC__.send('ipc-send', {
                                            channel: channel,
                                            args: args
                                        });
                                    }
                                },
                                
                                on: function(channel, listener) {
                                    console.log('[ipcRenderer] On:', channel);
                                    // Базовая реализация для совместимости
                                }
                            };
                            
                            console.log('[Injection] ✅ ipcRenderer created');
                        }
                        
                        // Создаем __ELECTRON_IPC__ bridge
                        if (typeof window.__ELECTRON_IPC__ === 'undefined') {
                            window.__ELECTRON_IPC__ = {
                                send: function(type, data) {
                                    // Отправляем через postMessage в main process
                                    try {
                                        window.postMessage({
                                            type: 'ELECTRON_IPC',
                                            subType: type,
                                            data: data
                                        }, '*');
                                    } catch (error) {
                                        console.error('[__ELECTRON_IPC__] Send error:', error);
                                    }
                                }
                            };
                            
                            console.log('[Injection] ✅ __ELECTRON_IPC__ created');
                        }
                        
                        return {
                            hasElectronBridge: typeof window.electron_bridge !== 'undefined',
                            hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
                            hasElectronIPC: typeof window.__ELECTRON_IPC__ !== 'undefined'
                        };
                    })();
                `;
                
                contents.executeJavaScript(injectionCode).then(result => {
                    log.info(`Main: API injection result: ${JSON.stringify(result)}`);
                }).catch(error => {
                    log.error(`Main: API injection error: ${error.message}`);
                });
            });
            
            // Слушаем postMessage от Zulip
            contents.on('ipc-message', (event, channel, ...args) => {
                log.info(`Main: IPC message from Zulip: ${channel}`);
            });
        }
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
        
        // Проверяем, загружен ли SDK и как его использовать
        let useSDK = false;
        let jitsiApi: any = null;
        
        if (JitsiMeetElectron) {
            log.info(`🎯[Jitsi SDK] SDK available, type: ${typeof JitsiMeetElectron}`);
            
            // Проверяем разные способы использования SDK
            if (typeof JitsiMeetElectron === 'function') {
                useSDK = true;
                log.info('🎯[Jitsi SDK] SDK is a function/constructor');
            } else if (JitsiMeetElectron.setupRenderer || JitsiMeetElectron.init) {
                useSDK = true;
                log.info('🎯[Jitsi SDK] SDK has setup methods');
            } else {
                log.warn('🎯[Jitsi SDK] SDK loaded but unknown format');
            }
        } else {
            log.warn('🎯[Jitsi SDK] SDK not loaded, will use web version');
        }
        
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
                nodeIntegration: useSDK,      // true для SDK, false для web
                contextIsolation: !useSDK,    // false для SDK, true для web
                sandbox: false,
                webSecurity: false  // Может потребоваться для SDK
            },
            show: true,
            center: true
        });
        
        if (useSDK) {
            // Пробуем использовать SDK
            try {
                log.info('🎯[Jitsi SDK] Attempting to use SDK...');
                
                // Вариант 1: SDK требует загрузки HTML страницы с SDK
                if (JitsiMeetElectron.setupRenderer) {
                    // Загружаем специальную HTML страницу для SDK
                    const sdkHtmlPath = path.join(__dirname, 'jitsi-sdk.html');
                    await jitsiWindow.loadFile(sdkHtmlPath);
                    
                    // Инициализируем SDK в renderer процессе
                    jitsiWindow.webContents.executeJavaScript(`
                        const { JitsiMeetElectron } = require('@jitsi/electron-sdk');
                        JitsiMeetElectron.setupRenderer();
                    `);
                    
                } 
                
                log.info('🎯[Jitsi SDK] SDK initialized successfully');
                
            } catch (sdkError: any) {
                log.error(`🎯[Jitsi SDK] SDK initialization failed: ${sdkError.message}`);
                useSDK = false;
                // Продолжаем с web-версией
            }
        }
        
        if (!useSDK) {
            // Web-версия без SDK
            log.info('🎯[Jitsi Web] Using web-based Jitsi (no SDK)');
            
            // Базовый URL
            let conferenceUrl = `${server}/${roomName}`;
            
            // Query params (только jwt)
            const queryParams = new URLSearchParams();
            if (options.jwt) queryParams.append('jwt', options.jwt);
            if (queryParams.toString()) {
                conferenceUrl += '?' + queryParams.toString();
            }
            
            // Hash params для config и userInfo
            const hashParams = new URLSearchParams();
            
            // Config overrides
            hashParams.append('config.prejoinPageEnabled', 'false');
            hashParams.append('config.prejoinConfig.enabled', 'false');
            hashParams.append('config.startWithAudioMuted', 'false');
            hashParams.append('config.startWithVideoMuted', 'true');
            hashParams.append('config.enableWelcomePage', 'false');
            
            // User info
            if (options.displayName) hashParams.append('userInfo.displayName', options.displayName);
            if (options.email) hashParams.append('userInfo.email', options.email);
            if (options.avatarUrl) hashParams.append('userInfo.avatar', options.avatarUrl);
            
            if (hashParams.toString()) {
                conferenceUrl += '#' + hashParams.toString();
            }
            
            log.info(`🎯[Jitsi Web] Loading URL: ${conferenceUrl}`);
            
            await jitsiWindow.loadURL(conferenceUrl);

            const jwtParam = options.jwt || ''; 

            // Замените существующий setTimeout блок на этот код с перехватом desktop picker:

            // Замените существующий setTimeout блок на этот улучшенный код:

            // Замените существующий setTimeout блок на этот код для многоразового использования:

            setTimeout(async () => {
                try {
                  const injectionResult = await jitsiWindow.webContents.executeJavaScript(`
                    (async function() {
                      console.log('[TestStream] Installing reusable stream injection...');
                      
                      // Глобальные переменные для управления потоками
                      let currentStream = null;
                      let currentCanvas = null;
                      let currentAnimationFrame = null;
                      let streamCounter = 0;
                      
                      // Функция создания нового тестового потока
                      function createTestStream() {
                        // Останавливаем предыдущий поток если есть
                        if (currentStream) {
                          currentStream.getTracks().forEach(track => track.stop());
                          if (currentAnimationFrame) {
                            cancelAnimationFrame(currentAnimationFrame);
                          }
                          if (currentCanvas && currentCanvas.parentNode) {
                            currentCanvas.remove();
                          }
                        }
                        
                        streamCounter++;
                        console.log('[TestStream] Creating new test stream #' + streamCounter);
                        
                        // Создаем новый canvas
                        const canvas = document.createElement('canvas');
                        canvas.width = 1920;
                        canvas.height = 1080;
                        canvas.style.display = 'none';
                        document.body.appendChild(canvas);
                        
                        const ctx = canvas.getContext('2d');
                        if (!ctx) throw new Error('Canvas context failed');
                        
                        let frame = 0;
                        let isActive = true;
                        
                        function animate() {
                          if (!isActive) return;
                          frame++;
                          
                          // Градиентный фон с изменением цвета
                          const hue = (frame * 2 + streamCounter * 60) % 360;
                          const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 800);
                          gradient.addColorStop(0, 'hsl(' + hue + ', 100%, 50%)');
                          gradient.addColorStop(1, 'hsl(' + ((hue + 180) % 360) + ', 100%, 30%)');
                          ctx.fillStyle = gradient;
                          ctx.fillRect(0, 0, 1920, 1080);
                          
                          // Текст с номером потока
                          ctx.fillStyle = 'white';
                          ctx.font = 'bold 100px Arial';
                          ctx.textAlign = 'center';
                          ctx.shadowColor = 'rgba(0,0,0,0.8)';
                          ctx.shadowBlur = 20;
                          ctx.fillText('🎯 NATIVE STREAM #' + streamCounter, 960, 400);
                          
                          ctx.font = '60px Arial';
                          ctx.fillText('Frame: ' + frame, 960, 540);
                          ctx.fillText(new Date().toLocaleTimeString(), 960, 640);
                          
                          // Индикатор активности
                          const pulseSize = 30 + Math.sin(frame * 0.1) * 10;
                          ctx.beginPath();
                          ctx.arc(100, 100, pulseSize, 0, 2 * Math.PI);
                          ctx.fillStyle = '#4CAF50';
                          ctx.fill();
                          
                          currentAnimationFrame = requestAnimationFrame(animate);
                        }
                        
                        animate();
                        
                        const stream = canvas.captureStream(30);
                        currentStream = stream;
                        currentCanvas = canvas;
                        
                        console.log('[TestStream] New stream created with id:', stream.id);
                        
                        // Автоматическая остановка через 5 минут
                        setTimeout(() => {
                          if (currentStream && currentStream.id === stream.id) {
                            isActive = false;
                            stream.getTracks().forEach(track => track.stop());
                            if (canvas.parentNode) {
                              canvas.remove();
                            }
                            console.log('[TestStream] Stream #' + streamCounter + ' auto-stopped after 5 minutes');
                          }
                        }, 300000); // 5 минут
                        
                        return stream;
                      }
                      
                      // Сохраняем оригинальные функции
                      const originalFunctions = {
                        openDesktopPicker: null,
                        obtainDesktopStream: null,
                        createLocalTracks: null,
                        getDisplayMedia: null,
                        getUserMedia: null
                      };
                      
                      // Флаг для отслеживания активного шаринга
                      let isSharingActive = false;
                      
                      // Перехват JitsiMeetScreenObtainer
                      if (window.JitsiMeetScreenObtainer) {
                        console.log('[TestStream] Setting up JitsiMeetScreenObtainer interceptors');
                        
                        originalFunctions.openDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                        
                        window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                          console.log('[TestStream] openDesktopPicker intercepted');
                          
                          // Создаем новый поток при каждом вызове
                          createTestStream();
                          
                          setTimeout(() => {
                            const sourceId = 'screen:' + streamCounter + ':0';
                            const sourceOptions = {
                              audio: false,
                              screenShareAudio: false
                            };
                            
                            console.log('[TestStream] Returning sourceId:', sourceId);
                            if (callback) {
                              callback(sourceId, sourceOptions);
                            }
                          }, 100);
                        };
                        
                        if (window.JitsiMeetScreenObtainer.obtainDesktopStream) {
                          originalFunctions.obtainDesktopStream = window.JitsiMeetScreenObtainer.obtainDesktopStream;
                          
                          window.JitsiMeetScreenObtainer.obtainDesktopStream = function(sourceId, callback, errorCallback) {
                            console.log('[TestStream] obtainDesktopStream intercepted');
                            
                            setTimeout(() => {
                              if (currentStream) {
                                console.log('[TestStream] Returning current stream');
                                if (callback) {
                                  callback(currentStream);
                                }
                              } else {
                                console.error('[TestStream] No current stream available');
                                if (errorCallback) {
                                  errorCallback(new Error('No stream available'));
                                }
                              }
                            }, 100);
                          };
                        }
                      }
                      
                      // Перехват JitsiMeetJS.createLocalTracks
                      if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                        originalFunctions.createLocalTracks = window.JitsiMeetJS.createLocalTracks;
                        
                        window.JitsiMeetJS.createLocalTracks = async function(options) {
                          console.log('[TestStream] createLocalTracks intercepted');
                          
                          if (options && options.devices && options.devices.includes('desktop')) {
                            console.log('[TestStream] Desktop track requested');
                            
                            // Если нет активного потока, создаем новый
                            if (!currentStream || !currentStream.active) {
                              createTestStream();
                            }
                            
                            try {
                              // Временно подменяем getUserMedia и getDisplayMedia
                              const tempGetUserMedia = navigator.mediaDevices.getUserMedia;
                              const tempGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                              
                              navigator.mediaDevices.getUserMedia = async function(constraints) {
                                if (constraints && constraints.video && 
                                    constraints.video.mandatory && 
                                    constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                  console.log('[TestStream] Returning current stream for desktop getUserMedia');
                                  return currentStream;
                                }
                                return tempGetUserMedia.call(this, constraints);
                              };
                              
                              navigator.mediaDevices.getDisplayMedia = async function() {
                                console.log('[TestStream] Returning current stream for getDisplayMedia');
                                return currentStream;
                              };
                              
                              // Вызываем оригинальную функцию
                              const tracks = await originalFunctions.createLocalTracks.call(this, options);
                              
                              // Восстанавливаем
                              navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                              navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                              
                              if (tracks && tracks.length > 0) {
                                isSharingActive = true;
                                console.log('[TestStream] JitsiLocalTrack created successfully');
                                
                                // Добавляем обработчик остановки трека
                                const originalDispose = tracks[0].dispose;
                                tracks[0].dispose = function() {
                                  console.log('[TestStream] Track dispose called');
                                  isSharingActive = false;
                                  if (originalDispose) {
                                    return originalDispose.call(this);
                                  }
                                };
                              }
                              
                              return tracks;
                              
                            } catch (e) {
                              console.error('[TestStream] Error in createLocalTracks:', e);
                              throw e;
                            }
                          }
                          
                          // Для других типов треков вызываем оригинальную функцию
                          return originalFunctions.createLocalTracks.call(this, options);
                        };
                      }
                      
                      // Постоянные перехваты getDisplayMedia и getUserMedia
                      originalFunctions.getDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                      navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                        console.log('[TestStream] getDisplayMedia intercepted');
                        if (!currentStream || !currentStream.active) {
                          createTestStream();
                        }
                        return currentStream;
                      };
                      
                      originalFunctions.getUserMedia = navigator.mediaDevices.getUserMedia;
                      navigator.mediaDevices.getUserMedia = async function(constraints) {
                        if (constraints && constraints.video && 
                            constraints.video.mandatory && 
                            constraints.video.mandatory.chromeMediaSource === 'desktop') {
                          console.log('[TestStream] getUserMedia for desktop intercepted');
                          if (!currentStream || !currentStream.active) {
                            createTestStream();
                          }
                          return currentStream;
                        }
                        return originalFunctions.getUserMedia.call(this, constraints);
                      };
                      
                      // Мониторинг состояния шаринга
                      setInterval(() => {
                        const state = window.APP && window.APP.store && window.APP.store.getState();
                        const tracks = state && state['features/base/tracks'];
                        const desktopTrack = tracks && tracks.find(t => t.videoType === 'desktop');
                        
                        if (desktopTrack && !isSharingActive) {
                          isSharingActive = true;
                          console.log('[TestStream] Desktop sharing started');
                        } else if (!desktopTrack && isSharingActive) {
                          isSharingActive = false;
                          console.log('[TestStream] Desktop sharing stopped');
                          // Останавливаем текущий поток при остановке шаринга
                          if (currentStream) {
                            currentStream.getTracks().forEach(track => track.stop());
                            if (currentCanvas && currentCanvas.parentNode) {
                              currentCanvas.remove();
                            }
                            currentStream = null;
                            currentCanvas = null;
                          }
                        }
                      }, 1000);
                      
                      // Функция для полной очистки (можно вызвать из консоли)
                      window.cleanupTestStream = function() {
                        console.log('[TestStream] Cleaning up...');
                        
                        // Останавливаем поток
                        if (currentStream) {
                          currentStream.getTracks().forEach(track => track.stop());
                        }
                        if (currentAnimationFrame) {
                          cancelAnimationFrame(currentAnimationFrame);
                        }
                        if (currentCanvas && currentCanvas.parentNode) {
                          currentCanvas.remove();
                        }
                        
                        // Восстанавливаем оригинальные функции
                        if (window.JitsiMeetScreenObtainer) {
                          if (originalFunctions.openDesktopPicker) {
                            window.JitsiMeetScreenObtainer.openDesktopPicker = originalFunctions.openDesktopPicker;
                          }
                          if (originalFunctions.obtainDesktopStream) {
                            window.JitsiMeetScreenObtainer.obtainDesktopStream = originalFunctions.obtainDesktopStream;
                          }
                        }
                        if (window.JitsiMeetJS && originalFunctions.createLocalTracks) {
                          window.JitsiMeetJS.createLocalTracks = originalFunctions.createLocalTracks;
                        }
                        if (originalFunctions.getDisplayMedia) {
                          navigator.mediaDevices.getDisplayMedia = originalFunctions.getDisplayMedia;
                        }
                        if (originalFunctions.getUserMedia) {
                          navigator.mediaDevices.getUserMedia = originalFunctions.getUserMedia;
                        }
                        
                        console.log('[TestStream] Cleanup complete');
                      };
                      
                      console.log('[TestStream] Reusable stream injection installed successfully');
                      console.log('[TestStream] You can now click the share screen button multiple times');
                      console.log('[TestStream] To cleanup, run: window.cleanupTestStream()');
                      
                      return { 
                        success: true, 
                        message: 'Reusable stream injection ready',
                        features: {
                          multipleStreams: true,
                          autoCleanup: true,
                          streamLifetime: '5 minutes',
                          manualCleanup: 'window.cleanupTestStream()'
                        }
                      };
                    })();
                  `);
                  
                  log.info(`[TestStream] Injection result: ${JSON.stringify(injectionResult)}`);
                } catch (error) {
                  log.error(`[TestStream] Error injecting stream: ${error.message}`);
                }
              }, 4000); // 4 секунды для загрузки Jitsi
        }
        
        // Фокусируем окно
        jitsiWindow.focus();
        
        // Обработчик закрытия окна
        jitsiWindow.on('closed', () => {
            log.info(`🎯[Jitsi] Window closed`);
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
            server: server,
            usingSDK: useSDK
        });
        
        return {
            success: true,
            roomName: roomName,
            server: server
        };
        
    } catch (error: any) {
        log.error(`🎯[Jitsi] Error creating window: ${error.message}`);
        
        // Если не удалось создать окно в Electron, отправляем сигнал для запуска в браузере
        sendEventToZulip('jitsi-electron-failed', {
            error: error.message,
            fallbackNeeded: true
        });
        
        return {
            success: false,
            error: error.message,
            fallbackNeeded: true  // Сигнал для Zulip запустить браузерную версию
        };
    }
  }

  function sendEventToZulip(eventName: string, data: any): void {
      const allContents = webContents.getAllWebContents();
      for (const content of allContents) {
          const url = content.getURL();
          if (url && url.includes('localhost:9991')) {
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


  // Добавьте эту функцию где-нибудь в index.ts, например, рядом с другими вспомогательными функциями
  function createTestSourceThumbnailAsPngBase64(): string {
    // Создаем очень простой 1x1 пиксель PNG (зеленый, как в SVG)
    // Это стандартный заголовок для 1x1 зеленого пикселя PNG
    return "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAnjDjIgAAAABJRU5ErkJggg==";
  }

  // КРИТИЧНО: Обработчик get-desktop-sources БЕЗ диалога
  // КРИТИЧНО: Обработчик get-desktop-sources БЕЗ диалога
  // КРИТИЧНО: Обработчик get-desktop-sources БЕЗ диалога
  ipcMain.handle("get-desktop-sources", async () => {
    try {
      log.info("Main: [TEST_SOURCE_DEBUG] === НАЧАЛО ЗАПРОСА ИСТОЧНИКОВ ЭКРАНА ===");

      // --- 1. Получаем источники из нативного Swift аддона ---
      let nativeSourcesRaw: any[] = [];
      try {
          log.info("Main: [TEST_SOURCE_DEBUG] Получение источников из нативного Swift аддона...");
          const swiftResult = await getAvailableSources(); // Используем вашу готовую функцию
          if (swiftResult && Array.isArray(swiftResult)) {
              nativeSourcesRaw = swiftResult;
              log.info(`Main: [TEST_SOURCE_DEBUG] Успешно получено ${nativeSourcesRaw.length} сырых источников из Swift аддона`);
              // Логируем каждый полученный источник для отладки (первые 3, чтобы не засорять логи)
              const sourcesToLog = nativeSourcesRaw.slice(0, 3);
              sourcesToLog.forEach((src, idx) => {
                  log.info(`Main: [TEST_SOURCE_DEBUG] Сырой нативный источник ${idx}: ${JSON.stringify(src)}`);
              });
              if (nativeSourcesRaw.length > 3) {
                  log.info(`Main: [TEST_SOURCE_DEBUG] ... и ещё ${nativeSourcesRaw.length - 3} источников`);
              }
          } else {
              log.warn(`Main: [TEST_SOURCE_DEBUG] getAvailableSources вернул не массив:`, swiftResult);
          }
      } catch (swiftError: any) {
          log.error(`Main: [TEST_SOURCE_DEBUG] Ошибка при получении источников из Swift аддона: ${swiftError.message}`);
          // Не прерываем выполнение, продолжаем с пустым массивом
      }

      // --- 2. Форматируем нативные источники в формат Electron/Jitsi ---
      log.info("Main: [TEST_SOURCE_DEBUG] === НАЧАЛО ФОРМАТИРОВАНИЯ НАТИВНЫХ ИСТОЧНИКОВ ===");
      const formattedNativeSources = nativeSourcesRaw.map((source, index) => {
          try {
              log.debug(`Main: [TEST_SOURCE_DEBUG] Форматирование нативного источника ${index}: ${JSON.stringify({type: source.type, id: source.id, name: source.name})}`);
              
              // --- Проверка и извлечение базовых полей ---
              const sourceTypeRaw = source.type;
              const sourceIdRaw = source.id;
              const sourceName = source.name || `Native Source ${index + 1}`;

              if (!sourceTypeRaw) {
                  log.warn(`Main: [TEST_SOURCE_DEBUG] Пропущен нативный источник без 'type' (индекс ${index})`, source);
                  return null; // Будет отфильтрован
              }
              if (!sourceIdRaw && sourceIdRaw !== 0) { // 0 это валидный ID
                  log.warn(`Main: [TEST_SOURCE_DEBUG] Пропущен нативный источник без 'id' (индекс ${index})`, source);
                  return null; // Будет отфильтрован
              }

              const sourceType = sourceTypeRaw.toString().toLowerCase();

              // --- Определение префикса и ID для Electron/Jitsi ---
              let prefix = 'screen:'; // Префикс по умолчанию (для display/screen)
              if (sourceType === 'window' || sourceType === 'application') {
                  prefix = 'window:'; // Окна и приложения получают префикс window:
              }
              // Формируем ID в формате Electron (добавляем :0 в конце для совместимости)
              // Electron обычно использует формат prefix:id:capture_session_id
              // capture_session_id часто 0 для первого запроса
              const formattedId = `${prefix}${sourceIdRaw}:0`; // <-- Изменение здесь
              log.debug(`Main: [TEST_SOURCE_DEBUG]   Исходный тип: ${sourceType}, Исходный ID: ${sourceIdRaw} -> Форматированный ID: ${formattedId}`);

              // --- Создание thumbnail (заглушка в формате PNG) ---
              const thumbnailDataUrl = "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4AQAA/QGOrDGjAAAAAElFTkSuQmCC";
              log.debug(`Main: [TEST_SOURCE_DEBUG]   Thumbnail создан (заглушка)`);

              // --- Возвращаем отформатированный объект ---
              const formattedSource = {
                  id: formattedId,
                  name: sourceName,
                  thumbnail: { dataUrl: thumbnailDataUrl }
              };
              // Не логируем каждый отформатированный источник, чтобы не засорять логи
              // log.debug(`Main: [TEST_SOURCE_DEBUG]   Отформатированный источник ${index}: ${JSON.stringify(formattedSource)}`);
              return formattedSource;
          } catch (formatError: any) {
              log.error(`Main: [TEST_SOURCE_DEBUG] Ошибка форматирования нативного источника (индекс ${index}): ${formatError.message}`, source);
              return null; // Будет отфильтрован
          }
      }).filter((source): source is NonNullable<typeof source> => source !== null); // Убираем null

      log.info(`Main: [TEST_SOURCE_DEBUG] Отформатировано ${formattedNativeSources.length} нативных источников`);

      // --- 3. Создаем тестовые источники (с :0 в конце для совместимости) ---
      log.info("Main: [TEST_SOURCE_DEBUG] === СОЗДАНИЕ ТЕСТОВЫХ ИСТОЧНИКОВ ===");
      const testScreenSource = {
        id: 'screen:test-source-screen-123:0', // <-- Добавлен :0
        name: '🖥️ [TEST] Тестовый Экран (Заглушка)',
        thumbnail: { dataUrl: createTestSourceThumbnailAsPngBase64() } // Убедитесь, что функция существует
      };
      log.info(`Main: [TEST_SOURCE_DEBUG] Тестовый ЭКРАН: ${JSON.stringify({id: testScreenSource.id, name: testScreenSource.name})}`);

      const testWindowSource = {
        id: 'window:test-source-window-456:0', // <-- Добавлен :0
        name: '🪟 [TEST] Тестовое Окно (Заглушка)',
        thumbnail: { dataUrl: createTestSourceThumbnailAsPngBase64() } // Убедитесь, что функция существует
      };
      log.info(`Main: [TEST_SOURCE_DEBUG] Тестовое ОКНО: ${JSON.stringify({id: testWindowSource.id, name: testWindowSource.name})}`);

      // --- 4. Объединяем списки ---
      log.info("Main: [TEST_SOURCE_DEBUG] === ОБЪЕДИНЕНИЕ СПИСКОВ ===");
      // Только нативные источники + тестовые заглушки
      const finalSourcesToSend = [testScreenSource, testWindowSource, ...formattedNativeSources];
      log.info(`Main: [TEST_SOURCE_DEBUG] Всего источников для отправки: ${finalSourcesToSend.length}`);

      // --- 5. Подробное логирование финального списка (первые и последние несколько) ---
      log.info("Main: [TEST_SOURCE_DEBUG] === ФИНАЛЬНЫЙ СПИСОК ИСТОЧНИКОВ ДЛЯ ОТПРАВКИ ===");
      const totalSources = finalSourcesToSend.length;
      const maxToLog = 10; // Логируем не более 10 источников
      const sourcesToLogFinal = totalSources <= maxToLog ? finalSourcesToSend : [
          ...finalSourcesToSend.slice(0, Math.floor(maxToLog / 2)),
          ...finalSourcesToSend.slice(-Math.ceil(maxToLog / 2))
      ];
      
      sourcesToLogFinal.forEach((src, idx) => {
          // Для удобства читаемости в логах
          const displayIndex = totalSources <= maxToLog ? idx : 
              (idx < Math.floor(maxToLog / 2) ? idx : totalSources - (maxToLog - Math.floor(maxToLog / 2)) + idx);
          log.info(`Main: [TEST_SOURCE_DEBUG] Источник ${displayIndex}: ID='${src.id}', Name='${src.name}'`);
      });
      if (totalSources > maxToLog) {
          log.info(`Main: [TEST_SOURCE_DEBUG] ... (пропущено ${totalSources - maxToLog} источников) ...`);
      }

      // --- 6. Отправляем список через webContents.send ---
      log.info("Main: [TEST_SOURCE_DEBUG] === ОТПРАВКА ИСТОЧНИКОВ В WEBVIEW ===");
      webContents.getAllWebContents().forEach(content => {
        log.info(`Main: [TEST_SOURCE_DEBUG] Отправляем ${finalSourcesToSend.length} sources в WebContents #${content.id}`);
        content.send("desktop-sources-response", {
          sources: finalSourcesToSend,
          error: null
        });
      });

      log.info("Main: [TEST_SOURCE_DEBUG] === ИСТОЧНИКИ УСПЕШНО ОТПРАВЛЕНЫ ===");
      return finalSourcesToSend; // Возвращаем для invoke тоже

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Main: [TEST_SOURCE_DEBUG] === КРИТИЧЕСКАЯ ОШИБКА ===", error);

      // Отправляем ошибку
      const errorResponse = { sources: [], error: errorMessage };
      webContents.getAllWebContents().forEach(content => {
        log.info(`Main: [TEST_SOURCE_DEBUG] Отправляем ОШИБКУ в WebContents #${content.id}`);
        content.send("desktop-sources-response", errorResponse);
      });

      return errorResponse;
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



  // Добавить функцию создания тестовых thumbnail

  ipcMain.handle("create-jitsi-sdk-from-zulip", async (event, options) => {
      log.info("🎯[Jitsi] Creating from Zulip (redirecting to main handler)...");
      // Просто перенаправляем на основной обработчик
      return ipcMain.handle("jitsi-connect-with-zulip-config", event, options);
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

  ipcMain.on('electron-bridge-event', (event, data) => {
      log.info(`Main: electron_bridge event: ${data.event}`);
      
      if (data.event === 'jitsi-initialized') {
          log.info('Main: Jitsi initialized in Zulip, triggering integration...');
          
          // Отправляем событие обратно в Zulip через electron_bridge
          setTimeout(() => {
              webContents.getAllWebContents().forEach(content => {
                  const url = content.getURL();
                  if (url.includes('localhost:9991')) {
                      content.executeJavaScript(`
                          if (window.electron_bridge && window.electron_bridge.emit_event) {
                              window.electron_bridge.emit_event('jitsi-initialized', {});
                          }
                      `);
                  }
              });
          }, 1000);
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
              
              if (url && url.includes('localhost:9991')) {
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


async function connectToJitsiWindow(options: {
    roomName: string;
    serverUrl?: string;
    displayName?: string;
}): Promise<any> {
    const server = options.serverUrl || 'https://jitsi-connectrm.ru';
    const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
    const displayName = options.displayName || 'User';
    
    log.info(`🎯[Jitsi] Connecting: ${server}/${roomName} as ${displayName}`);
    
    return { success: true, roomName, server, displayName };
}

