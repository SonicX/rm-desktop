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

  win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
    log.info(`Main: WebView будет создан с preload: ${webPreferences.preload}, URL: ${params.src}`);
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



  win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
    log.info(`Main: WebView будет создан с preload: ${webPreferences.preload}, URL: ${params.src}`);
    
    // IMPORTANT: Set the correct preload script for webviews
    const preloadPath = path.join(bundlePath, "preload.js");
    webPreferences.preload = preloadPath;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    
    log.info(`Main: Webview preload path set to: ${preloadPath}`);
    log.info(`Main: File exists: ${require('fs').existsSync(preloadPath)}`);
  });




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



  // Updated addon loading code for index.ts
  // Replace the existing screenCaptureAddon loading section (around lines 317-330)

  let screenCaptureAddon: any;
  try {
    // Try multiple possible paths for the addon
    const possiblePaths = [
      path.join(__dirname, 'native-addon.node'),
      path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
      path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
      '/Users/sg12/zulip-desktop/dist-electron/native-addon.node' // Absolute path as fallback
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
    screenCaptureAddon = require(addonPath);
    log.info(`✅ Native addon loaded successfully from: ${addonPath}`);
    
    // Test the addon
    const testResult = screenCaptureAddon.testMethod();
    log.info(`✅ Native addon test result: ${testResult}`);
  } catch (error) {
    log.error(`❌ Failed to load native addon: ${error}`);
    log.error(`❌ Current __dirname: ${__dirname}`);
    log.error(`❌ Current process.cwd(): ${process.cwd()}`);
  }





  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);
  await ses.clearCache().catch((err) => {
    console.error("Failed to clear cache:", err);
  });

  ipcMain.handle("get-server-settings", async (event, domain: string) =>
    _getServerSettings(domain, ses),
  );

  ipcMain.handle("save-server-icon", async (event, url: string) =>
    _saveServerIcon(url, ses),
  );

  ipcMain.handle("is-online", async (event, url: string) =>
    _isOnline(url, ses),
  );




  // Add these IPC handlers after your existing handlers in index.ts
  // Add this around line 400, after your other ipcMain.handle calls

  // Add IPC handlers for the native addon
  // Make sure these IPC handlers are in your index.ts
  // Add them right after the screenCaptureAddon loading code (around line 350)

  // Add IPC handlers for the native addon
  // Update your IPC handlers in index.ts to include frame forwarding

  // Add IPC handlers for the native addon (replace existing ones)
  if (screenCaptureAddon) {
    log.info("✅ Adding enhanced screen capture IPC handlers with frame forwarding...");
    
    // Set up frame forwarding when the addon loads
    screenCaptureAddon.forwardVideoFrame((frameData: any) => {
      log.info(`📹 Video frame forwarded: ${frameData.width}x${frameData.height}, frame #${frameData.frameNumber}`);
      
      // Send frame to all renderer processes
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(window => {
        window.webContents.send('screen-capture-video-frame', frameData);
      });
    });
    
    screenCaptureAddon.forwardAudioFrame((audioData: any) => {
      log.info(`🔊 Audio frame forwarded: ${audioData.sampleRate}Hz, ${audioData.channels}CH, frame #${audioData.frameNumber}`);
      
      // Send audio frame to all renderer processes
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(window => {
        window.webContents.send('screen-capture-audio-frame', audioData);
      });
    });
    
    ipcMain.handle("screen-capture-test", () => {
      try {
        log.info("🧪 Testing screen capture addon via IPC...");
        const result = screenCaptureAddon.testMethod();
        log.info(`✅ Screen capture test successful: ${result}`);
        return { success: true, result };
      } catch (error: any) {
        log.error(`❌ Failed to test addon: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    // Replace your screen-capture-start handler with this version that has detailed step-by-step logging

    ipcMain.handle("screen-capture-start", async (event, options: {
      sourceId: string;
      width: number;
      height: number;
      frameRate: number;
    }) => {
      try {
        log.info(`🎬 Starting screen capture with options:`, {
          sourceId: options.sourceId,
          width: options.width,
          height: options.height,
          frameRate: options.frameRate
        });
        
        if (!screenCaptureAddon) {
          throw new Error("Screen capture addon not available");
        }
        
        // Check available methods
        if (typeof screenCaptureAddon.forwardVideoFrame !== 'function') {
          log.warn("⚠️ forwardVideoFrame not available - frame forwarding disabled");
        } else {
          log.info("✅ Frame forwarding functions available");
        }
        
        // Parse source info
        const sourceType = options.sourceId.startsWith('screen:') ? 'display' : 
                          options.sourceId.startsWith('window:') ? 'window' : 'window';
        const sourceId = options.sourceId.split(':')[1] || options.sourceId.split(':')[2] || options.sourceId;
        
        log.info(`🎯 Setting capture source: type=${sourceType}, id=${sourceId}`);
        
        // Step 1: Set capture source with detailed logging
        try {
          log.info("📋 Step 1: Calling setCaptureSource...");
          
          const sourceResult = await screenCaptureAddon.setCaptureSource({
            type: sourceType,
            id: sourceId
          });
          
          log.info(`✅ Step 1 complete: setCaptureSource result: ${JSON.stringify(sourceResult)}`);
        } catch (sourceError: any) {
          log.error(`❌ Step 1 failed - setCaptureSource error: ${sourceError.message}`);
          log.error(`❌ Source error stack: ${sourceError.stack}`);
          throw new Error(`Failed to set capture source: ${sourceError.message}`);
        }
        
        // Step 2: Start capture with detailed logging
        try {
          log.info("🚀 Step 2: Calling startCapture...");
          
          const startResult = await screenCaptureAddon.startCapture();
          
          log.info(`✅ Step 2 complete: startCapture result: ${JSON.stringify(startResult)}`);
        } catch (startError: any) {
          log.error(`❌ Step 2 failed - startCapture error: ${startError.message}`);
          log.error(`❌ Start error stack: ${startError.stack}`);
          throw new Error(`Failed to start capture: ${startError.message}`);
        }
        
        // Step 3: Set up frame forwarding (only if capture started successfully)
        try {
          log.info("📹 Step 3: Setting up frame forwarding...");
          
          if (typeof screenCaptureAddon.forwardVideoFrame === 'function') {
            screenCaptureAddon.forwardVideoFrame((frameData: any) => {
              // Reduce logging frequency to avoid spam
              if (frameData.frameNumber % 30 === 0) { // Log every 30th frame
                log.info(`📹 Video frame: ${frameData.width}x${frameData.height}, #${frameData.frameNumber}`);
              }
              
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(window => {
                try {
                  window.webContents.send('screen-capture-video-frame', frameData);
                } catch (sendError) {
                  log.error(`Failed to send video frame: ${sendError}`);
                }
              });
            });
            log.info("✅ Video frame forwarding set up");
          }
          
          if (typeof screenCaptureAddon.forwardAudioFrame === 'function') {
            screenCaptureAddon.forwardAudioFrame((audioData: any) => {
              // Reduce logging frequency
              if (audioData.frameNumber % 100 === 0) { // Log every 100th frame
                log.info(`🔊 Audio frame: ${audioData.sampleRate}Hz, #${audioData.frameNumber}`);
              }
              
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(window => {
                try {
                  window.webContents.send('screen-capture-audio-frame', audioData);
                } catch (sendError) {
                  log.error(`Failed to send audio frame: ${sendError}`);
                }
              });
            });
            log.info("✅ Audio frame forwarding set up");
          }
          
          log.info("✅ Step 3 complete: Frame forwarding configured");
        } catch (forwardingError: any) {
          log.error(`❌ Step 3 failed - frame forwarding error: ${forwardingError.message}`);
          // Don't throw here - capture might still work without forwarding
        }
        
        log.info("🎉 Screen capture started successfully!");
        return { success: true, result: "Capture started with detailed logging" };
        
      } catch (error: any) {
        log.error(`❌ Screen capture start failed at top level: ${error.message}`);
        log.error(`❌ Top level error stack: ${error.stack}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("screen-capture-start-with-picker", async () => {
      try {
        log.info("🎯 Starting capture with Swift native picker...");
        
        if (!screenCaptureAddon) {
          throw new Error("Screen capture addon not available");
        }
        
        // Don't set source - let Swift handle it with its picker
        log.info("🚀 Calling startCapture (Swift will show picker)...");
        
        const result = await screenCaptureAddon.startCapture();
        
        log.info(`✅ Screen capture started with picker: ${JSON.stringify(result)}`);
        
        // Set up frame forwarding
        if (typeof screenCaptureAddon.forwardVideoFrame === 'function') {
          screenCaptureAddon.forwardVideoFrame((frameData: any) => {
            if (frameData.frameNumber % 30 === 0) {
              log.info(`📹 Video frame: ${frameData.width}x${frameData.height}`);
            }
            
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
              window.webContents.send('screen-capture-video-frame', frameData);
            });
          });
        }
        
        if (typeof screenCaptureAddon.forwardAudioFrame === 'function') {
          screenCaptureAddon.forwardAudioFrame((audioData: any) => {
            if (audioData.frameNumber % 100 === 0) {
              log.info(`🔊 Audio frame: ${audioData.sampleRate}Hz`);
            }
            
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(window => {
              window.webContents.send('screen-capture-audio-frame', audioData);
            });
          });
        }
        
        return { success: true, result: result.message || result };
        
      } catch (error: any) {
        log.error(`❌ Screen capture with picker failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("screen-capture-stop", async () => {
      try {
        log.info("🛑 Stopping screen capture...");
        const result = await screenCaptureAddon.stopCapture();
        log.info("✅ Screen capture stopped successfully");
        return { success: true, result: result.message || result };
      } catch (error: any) {
        log.error(`❌ Failed to stop capture: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("screen-capture-stats", () => {
      try {
        log.info("📊 Getting screen capture statistics...");
        const stats = screenCaptureAddon.getFrameStats();
        log.info(`📈 Current stats:`, {
          videoFrames: stats.videoFrames,
          audioFrames: stats.audioFrames,
          isActive: stats.isActive
        });
        return { success: true, stats };
      } catch (error: any) {
        log.error(`❌ Failed to get frame stats: ${error.message}`);
        return { success: false, error: error.message };
      }
    });
    
    log.info("✅ Enhanced screen capture IPC handlers with frame forwarding registered");
  } else {
    log.error("❌ screenCaptureAddon not available, skipping IPC handlers");
  }







  ipcMain.handle("inject-webview-test", async () => {
    try {
      // Find the webview
      const windows = BrowserWindow.getAllWindows();
      const mainWindow = windows[0]; // Assuming first window is main
      
      if (mainWindow && mainWindow.webContents) {
        // Inject test code into the webview
        const testCode = `
          console.log('🔍 Testing screenCapture in webview context...');
          console.log('window.screenCapture:', typeof window.screenCapture);
          console.log('window.electron_bridge:', typeof window.electron_bridge);
          
          if (window.screenCapture) {
            console.log('✅ screenCapture methods:', Object.keys(window.screenCapture));
            
            // Create a test button in the webview
            const testBtn = document.createElement('button');
            testBtn.id = 'webview-test-btn';
            testBtn.innerHTML = '📹 Test Screen Capture (Webview)';
            testBtn.style.cssText = \`
              position: fixed;
              top: 10px;
              right: 10px;
              z-index: 9999;
              padding: 10px 15px;
              background: #28a745;
              color: white;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
              box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            \`;
            
            testBtn.onclick = async () => {
              try {
                console.log('🧪 Testing screenCapture.testMethod...');
                const result = await window.screenCapture.testMethod();
                console.log('✅ Test result:', result);
                alert('✅ Screen capture works! Result: ' + result);
              } catch (error) {
                console.error('❌ Test failed:', error);
                alert('❌ Test failed: ' + error.message);
              }
            };
            
            document.body.appendChild(testBtn);
            console.log('✅ Test button added to webview');
          } else {
            console.log('❌ screenCapture not available in webview');
            alert('❌ screenCapture not available in webview context');
          }
        `;
        
        await mainWindow.webContents.executeJavaScript(testCode);
        log.info("✅ Test code injected into webview");
        return { success: true };
      } else {
        throw new Error("No main window found");
      }
    } catch (error: any) {
      log.error(`❌ Failed to inject webview test: ${error.message}`);
      return { success: false, error: error.message };
    }
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

  console.log("🖼 Создаём окно...");
  mainWindow = await createMainWindow();
  console.log("✅ Окно создано!");
  console.log("✅ Окно создано!-1");
  console.log("✅ Окно создано!-2");

  ipcMain.on("forward-message", (event, channel, ...args) => {
    log.info(`Main: Получено forward-message с каналом: ${channel}`);
    webContents.getAllWebContents().forEach(content => {
      content.send("forward-message", channel, ...args);
    });
  });

  // Кэш для thumbnails
  let thumbnailCache: { [key: string]: { dataUrl: string; timestamp: number } } = {};
  const CACHE_TIMEOUT = 0.1 * 1000; // 1 секунд
  const DEFAULT_THUMBNAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4AQAA/QGOrDGjAAAAAElFTkSuQmCC";

  ipcMain.handle("get-desktop-sources", async () => {
    try {
      log.info("Main: Запрос источников экрана");
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 300, height: 300 }
      });
      if (!sources || sources.length === 0) {
        log.warn("Main: Источники экрана пусты");
        throw new Error("Источники экрана не найдены");
      }
      log.info("Main: Источники экрана и окон:", sources.map(s => `${s.name} (${s.id})`));
      const currentTime = Date.now();
      const formattedSources = sources.map((source, index) => {
        let thumbnailData = thumbnailCache[source.id]?.dataUrl;
        if (!thumbnailData || (currentTime - thumbnailCache[source.id].timestamp > CACHE_TIMEOUT)) {
          const startTime = Date.now();
          thumbnailData = source.thumbnail.toDataURL();
          if (!thumbnailData || thumbnailData === "data:image/png;base64,") {
            log.warn(`Main: Пустой thumbnail для ${source.name} (index: ${index}, id: ${source.id})`);
            thumbnailData = DEFAULT_THUMBNAIL;
          } else {
            thumbnailCache[source.id] = { dataUrl: thumbnailData, timestamp: currentTime };
            log.info(`Main: Сгенерирован thumbnail для ${source.name} (index: ${index}, id: ${source.id}), длина: ${thumbnailData.length}, время: ${Date.now() - startTime}ms`);
          }
        } else {
          log.info(`Main: Использован кэшированный thumbnail для ${source.name} (index: ${index}, id: ${source.id}), длина: ${thumbnailData.length}`);
        }
        return {
          id: source.id,
          name: source.name,
          thumbnail: { dataUrl: thumbnailData }
        };
      });
      webContents.getAllWebContents().forEach(content => {
        log.info(`Main: Отправлен desktop-sources-response to WebContents #${content.id}`);
        content.send("desktop-sources-response", {
          sources: formattedSources,
          error: null
        });
      });
      return formattedSources;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Main: Ошибка получения источников экрана:", errorMessage);
      webContents.getAllWebContents().forEach(content => {
        content.send("desktop-sources-response", {
          sources: null,
          error: errorMessage
        });
      });
      throw error;
    }
  });

  // Обработчик jitsi-log-event
  ipcMain.on('jitsi-log-event', (event, logData) => {
    log.info(`Jitsi Log [${logData.level}]: ${logData.message}`);
    console.log(`Jitsi Log [${logData.level}]: ${logData.message}`);
  });

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