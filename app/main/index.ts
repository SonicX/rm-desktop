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
import Store from 'electron-store';
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import { initializeTrayManager } from './trayManager.js';


import { GlobalKeyboardListener, IGlobalKeyDownMap, IGlobalKeyEvent } from 'node-global-key-listener';

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import * as ConfigUtil from "../common/config-util.js";
import { bundlePath, bundleUrl, publicPath } from "../common/paths.js";
import * as t from "../common/translation-util.js";
import type { MenuProperties } from "../common/types.js";
import type { RendererMessage, DesktopSource, JitsiLogData, WalkieTalkieStatus } from "../common/typed-ipc.js";

import * as BadgeSettings from "./badge-settings.js";
import handleExternalLink from "./handle-external-link.js";
import * as AppMenu from "./menu.js";
import { _getServerSettings, _isOnline, _saveServerIcon } from "./request.js";
import { sentryInit } from "./sentry.js";
import { setAutoLaunch } from "./startup.js";
import { ipcMain, send } from "./typed-ipc-main.js";
const { setupScreenSharingMain } = require('@jitsi/electron-sdk');

import { NativeCaptureManager } from './native-capture';
import { JitsiManager } from './jitsi-manager';
import { JitsiPureManager } from './jitsi-pure.js';
import { JitsiSDKManager } from './jitsi-sdk-manager';

import * as fs from 'fs';
import * as https from 'https';
import * as child_process from 'child_process';
import AdmZip from 'adm-zip';



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
let currentVolumeHotkey: string | null = null;
let currentVolumeHotkeyPressed: boolean = false;
let volumeHotkeyWasPressed = false;
let currentMicHotkey: string | null = null;
let currentMicHotkeyPressed: boolean = false;

type KeyName = 
  // Латинские буквы (A–Z)
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  // Цифры (0–9)
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  // Основные символы
  | 'DOT' | 'FORWARD SLASH' | 'BACKSLASH' | 'SEMICOLON' | 'COMMA' | 'EQUALS' | 'MINUS' | 'QUOTE' |'SPACE'
  // Модификаторы
  | 'LEFT SHIFT' | 'RIGHT SHIFT' | 'LEFT CTRL' | 'LEFT ALT' | 'CAPS LOCK'
  // Control клавиши
  | 'TAB' | 'ESCAPE' | 'BACKSPACE' | 'DELETE' | 'UP ARROW' | 'DOWN ARROW' | 'LEFT ARROW' | 'RIGHT ARROW' | 'PAGE UP' | 'PAGE DOWN' | 'HOME' | 'END'

// Map для Windows: VK Code (decimal) → KeyName
const winVKToName: { [key: number]: KeyName } = {
  // Латинские буквы (A=65, B=66, ..., Z=90)
  65: 'A',
  66: 'B',
  67: 'C',
  68: 'D',
  69: 'E',
  70: 'F',
  71: 'G',
  72: 'H',
  73: 'I',
  74: 'J',
  75: 'K',
  76: 'L',
  77: 'M',
  78: 'N',
  79: 'O',
  80: 'P',
  81: 'Q',
  82: 'R',
  83: 'S',
  84: 'T',
  85: 'U',
  86: 'V',
  87: 'W',
  88: 'X',
  89: 'Y',
  90: 'Z',

  // Цифры (0=48, 1=49, ..., 9=57)
  48: '0',
  49: '1',
  50: '2',
  51: '3',
  52: '4',
  53: '5',
  54: '6',
  55: '7',
  56: '8',
  57: '9',

  // Основные символы
  190: 'DOT',  // VK_OEM_PERIOD
  191: 'FORWARD SLASH',  // VK_OEM_2
  220: 'BACKSLASH',  // VK_OEM_5
  186: 'SEMICOLON',  // VK_OEM_1
  188: 'COMMA',  // VK_OEM_COMMA
  187: 'EQUALS',  // VK_OEM_PLUS
  189: 'MINUS',  // VK_OEM_MINUS
  222: 'QUOTE',  // VK_OEM_7
  32: 'SPACE',  // VK_SPACE

  // Модификаторы
  160: 'LEFT SHIFT',  // VK_LSHIFT
  161: 'RIGHT SHIFT',  // VK_RSHIFT
  162: 'LEFT CTRL',  // VK_LCONTROL
  164: 'LEFT ALT',  // VK_LMENU
  20: 'CAPS LOCK',  // VK_CAPITAL

  // Control клавиши
  9:  'TAB',
  27: 'ESCAPE',  // VK_ESCAPE
  8:  'BACKSPACE',  // VK_BACK
  46: 'DELETE',  // VK_DELETE
  38: 'UP ARROW',  // VK_UP
  40: 'DOWN ARROW',  // VK_DOWN
  37: 'LEFT ARROW',  // VK_LEFT
  39: 'RIGHT ARROW',  // VK_RIGHT
  33: 'PAGE UP',  // VK_PRIOR
  34: 'PAGE DOWN',  // VK_NEXT
  36: 'HOME',  // VK_HOME
  35: 'END'
};

// Map для macOS: CGKeyCode (decimal) → KeyName (Apple Carbon Codes)
const macKeyCodeToName: { [key: number]: KeyName } = {
  // Латинские буквы (unique codes)
  0: 'A',      // A
  11: 'B',     // B
  8: 'C',      // C
  2: 'D',      // D
  14: 'E',     // E
  3: 'F',      // F
  5: 'G',      // G
  4: 'H',      // H
  34: 'I',     // I
  38: 'J',     // J
  40: 'K',     // K
  37: 'L',     // L
  46: 'M',     // M
  45: 'N',     // N
  31: 'O',     // O
  35: 'P',     // P
  12: 'Q',     // Q
  13: 'W',     // W (было 19? Ошибка, W=13)
  15: 'R',     // R
  16: 'Y',     // Y
  17: 'T',     // T
  32: 'U',     // U
  9: 'V',      // V
  7: 'X',      // X (было 25? Ошибка, X=7)
  6: 'Z',      // Z
  1: 'S',      // S

  // Цифры (top row, unique codes)
  29: '0',     // 0
  18: '1',     // 1
  19: '2',     // 2
  20: '3',     // 3
  21: '4',     // 4
  23: '5',     // 5
  22: '6',     // 6
  26: '7',     // 7
  28: '8',     // 8
  25: '9',     // 9

  // Основные символы (unique)
  47: 'DOT',        // . (period)
  44: 'FORWARD SLASH',  // / 
  42: 'BACKSLASH',  // \ 
  41: 'SEMICOLON',   // ; 
  43: 'COMMA',       // , 
  24: 'EQUALS',       // = 
  27: 'MINUS',       // - 
  39: 'QUOTE',       // '
  49: 'SPACE'       // Space
};

const store = new Store();

class CustomKeyboardListener extends GlobalKeyboardListener {
  constructor() {
    // macOS-specific custom config
    let customConfig: any = {};
    if (process.platform === 'darwin') {
      const libPackageJson = require.resolve('node-global-key-listener/package.json');
      const libBinPath = path.join(path.dirname(libPackageJson), 'bin', 'MacKeyServer');
      
      customConfig.mac = {
        serverPath: libBinPath,  // Абсолютный путь к lib binary (обходит project bin)
        // Дополнительно: onError, onInfo если нужно
      };
      
      log.info(`🔧 Custom config for mac: serverPath = ${libBinPath}`);
      
      // Проверяем и chmod lib binary (профилактика)
      if (fs.existsSync(libBinPath)) {
        try {
          child_process.execSync(`chmod +x "${libBinPath}"`, { stdio: 'ignore' });
          log.info(`✅ Lib binary chmod: ${libBinPath}`);
        } catch (err: any) {
          log.warn(`⚠️ Lib chmod ignored: ${err.message}`);  // Уже +x
        }
      } else {
        log.error(`❌ Lib binary missing: ${libBinPath}`);
      }
    } else {
      log.info(`🔧 Default config for ${process.platform}`);
    }
    
    // Передаём customConfig в super — keyServer создастся с ним
    super(customConfig);
  }

  public startListener(): Promise<void> {
    log.info(`🔧 Starting listener with custom config`);
    return this.start();  // Родительский start (keyServer уже с правильным path)
  }

  public stopListener(): void {
    this.stop();
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
const keyboardVolume = new CustomKeyboardListener();
const keyboardMic = new CustomKeyboardListener();

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

    await win.loadFile(path.join(__dirname, '..', 'app', 'renderer', 'main.html'));

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

    if (!isQuitting) {
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

  // const nativeCaptureManager = new NativeCaptureManager();
  // const jitsiManager = new JitsiManager(
  //   nativeCaptureManager,
  //   bundlePath,
  //   iconPath(),
  //   {
  //       videoQuality: 'MEDIUM',  // 720p для экономии ресурсов
  //       useHybridMode: true,
  //       enableDebugUI: true,
  //       enablePerformanceMonitoring: true
  //   }
  // );

  // === НОВЫЙ КОД ===
  const nativeCaptureManager = new NativeCaptureManager(); // Оставляем для других целей
  //const jitsiPureManager = new JitsiPureManager(bundlePath, iconPath());
  const jitsiSDKManager = new JitsiSDKManager(iconPath());
  

  // 2. ЗАТЕМ создаем сессию
  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  // 3. РЕГИСТРИРУЕМ ВСЕ IPC ОБРАБОТЧИКИ ДО СОЗДАНИЯ ОКНА

  let isNativeCapturing: boolean = false;
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
                name: `🎯 ${source.name || 'Source ' + index}`,
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
            
        } catch (error: any) {
            log.error(`🎯[NativeCapture] Error getting native sources: ${error.message}`);
        }
        }
        
        // Если нет native источников, используем Electron
        if (formattedSources.length === 0) {
        log.info("No native sources, using Electron fallback");
        const electronSources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 300, height: 200 }
        });
        
        formattedSources = electronSources.map(source => ({
            id: source.id,
            name: source.name,
            thumbnail: {
            dataUrl: source.thumbnail.toDataURL()
            },
            isNative: false
        }));
        }
        
        return formattedSources;
        
    } catch (error: any) {
        log.error(`🎯[NativeCapture] Error: ${error.message}`);
        return [];
    }
  });


  ipcMain.handle("jitsi-connect-with-zulip-config", async (event, options) => {
    log.info("🎯[Jitsi] Connecting with Zulip config using SDK...");
    log.info(`🎯[Jitsi] Options received: ${JSON.stringify(options)}`);
    
    try {
        // НЕ показываем диалог выбора экрана при старте
        // Он будет показан только когда пользователь нажмет кнопку демонстрации
        const enableScreenPicker = false; // Отключаем предварительный выбор
        
        log.info(`🎯[Jitsi] Starting conference without pre-selection`);
        
        // Используем SDK менеджер
        
        const result = await jitsiSDKManager.createWindow({
            roomName: options.roomName || '',
            serverUrl: options.serverUrl || 'https://jitsi-connectrm.ru',
            displayName: options.userInfo?.displayName || 'Guest',
            email: options.userInfo?.email || '',
            avatarUrl: options.userInfo?.avatarUrl || '',
            jwt: options.jwt || '',
            topic: options.topic || '',
            stream: options.stream || '',
            enableScreenPicker: enableScreenPicker // Отключен предварительный выбор
        });
        
        if (result.success) {
            log.info(`🎯[Jitsi SDK] Conference window created successfully`);

            const soundHotkey = store.get('currentVolumeHotkey', '');
            const micHotkey = store.get('currentMicHotkey', '');

            if (soundHotkey != null) {
              setupAudio(soundHotkey as string)
            }
            if (micHotkey != null) {
              setupMic(micHotkey as string)
            }

            // Отправляем событие в Zulip
            sendEventToZulip('jitsi-conference-ready', {
                success: true,
                roomName: options.roomName
            });
            
            return { 
                success: true,
                conferenceStarted: true
            };
        } else {
            log.error(`🎯[Jitsi SDK] Failed to create window: ${result.error}`);
            
            dialog.showErrorBox(
                'Ошибка подключения', 
                `Не удалось подключиться к конференции: ${result.error}\n\nПроверьте интернет-соединение и попробуйте снова.`
            );
            
            return { 
                success: true,  // Чтобы Zulip не запускал iframe
                conferenceStarted: false,
                error: result.error
            };
        }
        
    } catch (error: any) {
        log.error(`🎯[Jitsi SDK] Error: ${error.message}`);
        
        dialog.showErrorBox(
            'Ошибка подключения', 
            `Не удалось запустить конференцию: ${error.message}`
        );
        
        return { 
            success: true,  // Чтобы Zulip не запускал iframe
            conferenceStarted: false,
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

  ipcMain.on('electron-bridge-event', async (event, data) => {
    log.info(`Main: electron_bridge event: ${data.event}`);
    
    if (data.event === 'requestDesktopSources') {
        try {
            // Используем NativeCaptureManager
            const sources = await nativeCaptureManager.getSources();
            
            log.info(`🔍 Got ${sources.length} sources`);
            
            // Проверяем статус SDK окна
            const jitsiStatus = await jitsiSDKManager.getStatus();
            if (jitsiStatus.hasWindow && jitsiStatus.isConnected) {
                log.info('Jitsi SDK: Conference is active');
            }
            
        } catch (error: any) {
            log.error(`🔍 Error: ${error.message}`);
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

  // Обработчик запуска нативного захвата
  ipcMain.handle("start-native-capture", async (event, sourceId: string) => {
    return nativeCaptureManager.startCapture(sourceId);
  });

  // Обработчик остановки захвата
  ipcMain.handle("stop-native-capture", async () => {
    return nativeCaptureManager.stopCapture();
  });

  // Обработчик получения статуса захвата
  ipcMain.handle("get-capture-status", async () => {
    return nativeCaptureManager.getStatus();
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
  ipcMain.on("global-volume-hotkey", (event, status: WalkieTalkieStatus) => {
    log.info(`Main: Получено новое событие global-volume-hotkey: ${JSON.stringify(status)}`);
    if (typeof status !== "object" || status === null ||!("key" in status)) {
      log.error(`Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`);
      return;
    }

    const { key: rawKey } = status
    setupAudio(rawKey)
  });

  ipcMain.on("walkie-talkie-status", (event, status: WalkieTalkieStatus) => {
    log.info(`Main: Получено новое событие walkie-talkie-status: ${JSON.stringify(status)}`);
    if (typeof status !== "object" || status === null ||!("key" in status)) {
      log.error(`Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`);
      return;
    }
  
    const { key: rawKey } = status
    setupMic(rawKey);
  });

  function setupAudio(rawKey: string) {
    // 🔊 Регистрируем горячую клавишу для управления громкостью
    if (currentVolumeHotkey || rawKey == '') {
      keyboardVolume.stopListener();
      log.info(`Main: Остановлен предыдущий слушатель: ${currentVolumeHotkey}`);
    
    }

    if (rawKey == '') { 
      currentVolumeHotkey = '';
      store.set('currentVolumeHotkey', '');
      return; 
    }

    const key = normalizeKey(rawKey);

    currentVolumeHotkey = key;
    store.set('currentVolumeHotkey', key);

    keyboardVolume.startListener().catch(err => log.error(`Main: Ошибка запуска слушателя: ${err}`));

    keyboardVolume.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
      const parts = key.split('+').map(p => p.toLowerCase());
      const mainKey = parts.pop()!;
      
      let pressedKeyName = '';
      if (process.platform === 'darwin') {
        pressedKeyName = macKeyCodeToName[e.vKey] || '';
      } else {
        pressedKeyName = winVKToName[e.vKey] || '';
      }
      const normalizedMainKey = mainKey.toUpperCase() as KeyName;

      // Проверяем, что нажата именно нужная клавиша
      if (pressedKeyName !== normalizedMainKey) {
        return;
      }

      // Если клавиша нажата И ранее не была зажата — это новое нажатие!
      if (down[pressedKeyName] && !volumeHotkeyWasPressed) {
        volumeHotkeyWasPressed = true; // помечаем, что клавиша уже обработана

        log.info(`Main: Полное нажатие клавиши громкости — переключаем звук`);
        
        // Переключаем состояние: если был выключен — включаем, и наоборот
        const newMutedState = !currentVolumeHotkeyPressed;
        jitsiSDKManager.setLocalAudioMuted(newMutedState);
        currentVolumeHotkeyPressed = newMutedState;
      }

      // Если клавиша отпущена — сбрасываем флаг
      if (!down[pressedKeyName] && volumeHotkeyWasPressed) {
        volumeHotkeyWasPressed = false;
      }
    });
  }

  function setupMic(rawKey: string) {
    // 🔊 Регистрируем горячую клавишу для управления микрофоном
    if (currentMicHotkey || rawKey == '') {
      keyboardMic.stopListener();
      log.info(`Main: Остановлен node-global-key-listener для предыдущей клавиши: ${currentMicHotkey}`);
    }
    
    if (rawKey == '') { 
      currentMicHotkey = '';
      store.set('currentMicHotkey', '');
      return; 
    }

    const key = normalizeKey(rawKey);

    currentMicHotkey = key;
    store.set('currentMicHotkey', key);
  
    keyboardMic.startListener().catch(err => log.error(`Main: Ошибка запуска слушателя: ${err}`));
  
    keyboardMic.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
      const parts = key.split('+').map(p => p.toLowerCase());
      const mainKey = parts.pop()!;
      var pressedKeyName = '';
      if (process.platform === 'darwin') {
        pressedKeyName = macKeyCodeToName[e.vKey] || ''
      } else {
        pressedKeyName = winVKToName[e.vKey] || ''
      }
      const normalizedMainKey = mainKey.toUpperCase() as KeyName;

      if (pressedKeyName !== normalizedMainKey) { return; }

      if (down[pressedKeyName] && !currentMicHotkeyPressed) {
        log.info(`Main: Нажата клавиша микрофона — включаем микрофон`);
        jitsiSDKManager.setLocalMicMuted(false); // включить вывод звук
        currentMicHotkeyPressed = true;
      } else if (down[pressedKeyName] && currentMicHotkeyPressed) {
        return;
      } else {
        log.info(`Main: Отпущена клавиша микрофона — выключаем микрофон`);
        jitsiSDKManager.setLocalMicMuted(true); // выключить вывод звук
        currentMicHotkeyPressed = false
      }
    });
  }

  ipcMain.on("restart-app-test", () => {
    log.info("Test restart requested");
    // Метод 1: Простой перезапуск (работает на всех платформах)
    app.relaunch();
    app.exit(0);
    // Альтернативный метод 2: С аргументами (если нужно)
    // app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) });
    // app.exit(0);
  });

  // Обработчик сброса кнопки
  ipcMain.on("reset-update-button", () => {
      if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.executeJavaScript(`
              const updateBtn = document.querySelector('#update-action');
              if (updateBtn) {
                  // Убираем состояние загрузки
                  updateBtn.classList.remove('downloading');
                  updateBtn.classList.add('available');
                  updateBtn.disabled = false;
                  
                  // Сбрасываем прогресс
                  const progressBar = updateBtn.querySelector('#update-progress-bar');
                  if (progressBar) {
                      progressBar.style.width = '0%';
                  }
                  
                  const progressText = updateBtn.querySelector('#update-progress-text');
                  if (progressText) {
                      progressText.style.display = 'none';
                  }
                  
                  const tooltip = document.querySelector('#update-tooltip');
                  if (tooltip && window.pendingUpdate) {
                      tooltip.innerText = 'Версия ' + window.pendingUpdate.version + ' доступна';
                  }
              }
          `);
      }
  });

  async function downloadUpdate(url: string, destinationPath: string): Promise<void> {
      return new Promise((resolve, reject) => {
          const file = fs.createWriteStream(destinationPath);
          
          https.get(url, (response) => {
              const totalSize = parseInt(response.headers['content-length'] || '0', 10);
              let downloadedSize = 0;
              
              response.pipe(file);
              
              response.on('data', (chunk) => {
                  downloadedSize += chunk.length;
                  const progress = totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;
                  
                  // Отправляем прогресс в renderer окно
                  mainWindow?.webContents.send("update-download-progress", progress);
                  
                  // УБИРАЕМ эту строку - ipcRenderer здесь недоступен
                  // ipcRenderer.send("update-download-progress", progress);
                  
                  // Вместо этого отправляем событие прогресса напрямую
                  if (mainWindow) {
                      const percent = Math.round(progress);
                      mainWindow.webContents.executeJavaScript(`
                          (function() {
                              const updateBtn = document.querySelector('#update-action');
                              if (updateBtn && updateBtn.classList.contains('downloading')) {
                                  const progressBar = updateBtn.querySelector('#update-progress-bar');
                                  const progressText = updateBtn.querySelector('#update-progress-text');
                                  const tooltip = document.querySelector('#update-tooltip');
                                  
                                  if (progressBar) {
                                      progressBar.style.width = '${percent}%';
                                  }
                                  
                                  if (progressText) {
                                      progressText.innerText = '${percent}%';
                                  }
                                  
                                  if (tooltip) {
                                      tooltip.innerText = 'Загрузка: ${percent}%';
                                  }
                              }
                          })();
                      `).catch(() => {});
                  }
                  
                  log.info(`Download progress: ${progress.toFixed(2)}%`);
              });
              
              file.on('finish', () => {
                  file.close();
                  log.info('Download completed');
                  resolve();
              });
              
              response.on('error', (err) => {
                  fs.unlink(destinationPath, () => {});
                  reject(err);
              });
          }).on('error', (err) => {
              fs.unlink(destinationPath, () => {});
              reject(err);
          });
      });
  }

  // Затем функция распаковки, которая использует downloadUpdate
  async function downloadAndExtractUpdate(url: string, updateDir: string): Promise<string> {
    const zipPath = path.join(updateDir, 'update.zip');
    
    // Используем функцию downloadUpdate определенную выше
    await downloadUpdate(url, zipPath);
    
    log.info('Extracting update...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(updateDir, true);
    
    const files = fs.readdirSync(updateDir);
    const exeFile = files.find(file => file.endsWith('.exe'));
    
    if (!exeFile) {
      throw new Error('No .exe file found in archive');
    }
    
    fs.unlinkSync(zipPath);
    
    return path.join(updateDir, exeFile);
  }

  ipcMain.handle("handle-zulip-update", async (event, updateInfo: {
    version: string;
    downloadUrl: string;
    releaseNotes?: string;
  }) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Доступно обновление',
      message: `Доступна новая версия ${updateInfo.version}`,
      detail: updateInfo.releaseNotes || 'Рекомендуется установить обновление',
      buttons: ['Обновить сейчас', 'Позже'],
      defaultId: 0,
      cancelId: 1
    });
    
    if (result.response === 0) {
      try {
        const updateDir = path.join(app.getPath('userData'), 'updates');
        
        // Очищаем старые обновления
        if (fs.existsSync(updateDir)) {
          fs.rmSync(updateDir, { recursive: true, force: true });
        }
        fs.mkdirSync(updateDir, { recursive: true });
        
        mainWindow?.webContents.send("update-status", "Загрузка обновления...");
        
        // Скачиваем и распаковываем
        const exePath = await downloadAndExtractUpdate(updateInfo.downloadUrl, updateDir);
        
        log.info(`Launching installer: ${exePath}`);
        mainWindow?.webContents.send("update-status", "Запуск установщика...");
        
        if (process.platform === 'win32') {
          // Запускаем найденный exe
          child_process.spawn(exePath, [], {
            detached: true,
            stdio: 'ignore'
          }).unref();
          
          // Ждем немного и закрываем приложение
          setTimeout(() => {
            app.quit();
          }, 1000);
        }
        
        return { success: true, action: 'updated' };
      } catch (error: any) {
        log.error('Update failed:', error);
        dialog.showErrorBox('Ошибка обновления', error.message);
        return { success: false, error: error.message };
      }
    }
    
    return { success: true, action: 'postponed' };
  });

  // Добавьте этот обработчик рядом с другими ipcMain
  ipcMain.on("show-update-button", (event, updateInfo) => {
      log.info(`📦 Main: Showing update button for version ${updateInfo.version}`);
      
      if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.executeJavaScript(`
              const updateBtn = document.querySelector('#update-action');
              if (updateBtn) {
                  // Очищаем кнопку
                  updateBtn.classList.remove('hidden', 'inactive');
                  updateBtn.classList.add('available');
                  
                  // Добавляем элементы прогресса если их нет
                  if (!updateBtn.querySelector('#update-progress-bar')) {
                      const progressBar = document.createElement('div');
                      progressBar.id = 'update-progress-bar';
                      updateBtn.appendChild(progressBar);
                      
                      const progressText = document.createElement('div');
                      progressText.id = 'update-progress-text';
                      progressText.style.display = 'none';
                      updateBtn.appendChild(progressText);
                  }
                  
                  const tooltip = document.querySelector('#update-tooltip');
                  if (tooltip) {
                      tooltip.innerText = 'Версия ${updateInfo.version} доступна';
                  }
                  
                  window.pendingUpdate = ${JSON.stringify(updateInfo)};
                  
                  if (!updateBtn.hasUpdateHandler) {
                      updateBtn.addEventListener('click', () => {
                          console.log('Клик по кнопке обновления');
                          
                          // Меняем состояние кнопки на "загрузка"
                          updateBtn.classList.remove('available');
                          updateBtn.classList.add('downloading');
                          updateBtn.disabled = true;
                          
                          const progressText = updateBtn.querySelector('#update-progress-text');
                          if (progressText) {
                              progressText.style.display = 'block';
                              progressText.innerText = '0%';
                          }
                          
                          if (tooltip) {
                              tooltip.innerText = 'Загрузка...';
                          }
                          
                          // Отправляем событие
                          if (window.pendingUpdate) {
                              const webview = document.querySelector('webview');
                              if (webview) {
                                  webview.executeJavaScript(\`
                                      if (window.electron_bridge) {
                                          window.electron_bridge.send_event('trigger-update', \${JSON.stringify(window.pendingUpdate)});
                                      }
                                  \`);
                              }
                          }
                      });
                      updateBtn.hasUpdateHandler = true;
                  }
              }
          `);
      }
  });

  // Обработчик начала обновления
  ipcMain.on("start-update", async (event, updateInfo) => {
      log.info(`📦 Starting update to version ${updateInfo.version}`);
      
      // Используем существующий обработчик
      const result = await ipcMain.handle("handle-zulip-update", event, updateInfo);
      log.info(`📦 Update result: ${JSON.stringify(result)}`);
  });

  ipcMain.handle('get-app-version', () => {
      return app.getVersion();
  });

  ipcMain.handle("download-update", async (event, updateInfo) => {
    try {
      // Если используется electron-updater
      if (autoUpdater) {
        autoUpdater.downloadUpdate();
        return { success: true };
      }
      
      // Или ручная загрузка
      const updateDir = path.join(app.getPath('userData'), 'updates');
      if (!fs.existsSync(updateDir)) {
        fs.mkdirSync(updateDir, { recursive: true });
      }
      
      await downloadUpdateFile(updateInfo.downloadUrl, updateDir, (progress) => {
        mainWindow?.webContents.send("update-download-progress", progress);
      });
      
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.on("install-update", () => {
    if (autoUpdater) {
      autoUpdater.quitAndInstall();
    } else {
      // Ручная установка
      const updatePath = path.join(app.getPath('userData'), 'updates', 'installer.exe');
      if (fs.existsSync(updatePath)) {
        child_process.spawn(updatePath, [], {
          detached: true,
          stdio: 'ignore'
        }).unref();
        
        setTimeout(() => {
          app.quit();
        }, 1000);
      }
    }
  });

  // Функция для загрузки с прогрессом
  async function downloadUpdateFile(url: string, destDir: string, onProgress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const destPath = path.join(destDir, 'update.zip');
      const file = fs.createWriteStream(destPath);
      
      https.get(url, (response) => {
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const progress = totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;
          onProgress(progress);
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
        
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  // Настройка автообновлений с electron-updater
  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("download-progress", (progressObj) => {
    mainWindow?.webContents.send("update-download-progress", progressObj.percent);
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-downloaded");
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
  if (process.platform === 'win32') {
    app.setPath('userData', app.getPath('userData'));
  }

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
  initializeTrayManager(mainWindow);
  console.log("✅ Окно создано!");

  if (process.platform !== "darwin") {
    const shouldHideMenu = ConfigUtil.getConfigItem("autoHideMenubar", false);
    mainWindow.autoHideMenuBar = shouldHideMenu;
    mainWindow.setMenuBarVisibility(!shouldHideMenu);
  }


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
})();


app.on("before-quit", () => {
  isQuitting = true;
  // Очищаем горячую клавишу при выходе
  if (currentVolumeHotkey) {
    keyboardVolume.stopListener();
    log.info(`Main: Горячая клавиша ${currentVolumeHotkey} удалена при выходе`);
  }
  if (currentMicHotkey) {
    keyboardMic.stopListener();
    log.info(`Main: Горячая клавиша ${currentMicHotkey} удалена при выходе`);
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

ipcMain.on("force_update", (event) => {
  log.info(`Производим обновление`);
  mainWindow?.webContents.send("force_update");
});

process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});