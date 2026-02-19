/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unsafe-call, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unsafe-assignment, unicorn/prevent-abbreviations, @typescript-eslint/no-floating-promises, @typescript-eslint/use-unknown-in-catch-callback-variable, @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, @typescript-eslint/no-empty-function, no-eq-null, no-bitwise, n/prefer-promises/fs, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unsafe-argument, import/order, import/no-extraneous-dependencies, promise/prefer-await-to-then, unicorn/no-array-for-each, unicorn/prefer-number-properties, unicorn/prefer-spread, unicorn/no-array-reduce, unicorn/prefer-code-point, @typescript-eslint/no-unsafe-return, eqeqeq, no-empty */
import {shell} from "electron"; // eslint-disable-line no-restricted-imports
import {
  BrowserWindow,
  type IpcMainEvent,
  type WebContents,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  powerMonitor,
  session,
  systemPreferences,
  webContents,
} from "electron/main";
import {Buffer} from "node:buffer";
import * as child_process from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import path from "node:path";
import process from "node:process";

import log from "electron-log/main";
import Store from "electron-store";

import {autoUpdater} from "electron-updater";
import {
  GlobalKeyboardListener,
  type IGlobalKeyDownMap,
  type IGlobalKeyEvent,
} from "node-global-key-listener";

import * as ConfigUtil from "../common/config-util.js";
import {bundlePath, bundleUrl, publicPath} from "../common/paths.js";

import * as t from "../common/translation-util.js";
import {initializeTrayManager} from "./trayManager.js";

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import type {MenuProperties} from "../common/types.js";
import type {
  DesktopSource,
  JitsiLogData,
  RendererMessage,
  WalkieTalkieStatus,
} from "../common/typed-ipc.js";

import * as BadgeSettings from "./badge-settings.js";
import handleExternalLink from "./handle-external-link.js";
import {
  getPressedKeyNameFromEvent,
  normalizeHotkeyString,
  normalizeKeyNameForMatch,
} from "./hotkey-utils-main.js";
import * as AppMenu from "./menu.js";
import {_getServerSettings, _isOnline, _saveServerIcon} from "./request.js";
import {sentryInit} from "./sentry.js";
import {setAutoLaunch} from "./startup.js";
import {ipcMain, send} from "./typed-ipc-main.js";
import {NativeCaptureManager} from "./native-capture.js";
import {JitsiManager} from "./jitsi-manager.js";
import {JitsiPureManager} from "./jitsi-pure.js";
import {JitsiSDKManager} from "./jitsi-sdk-manager.js";
import {registerAudioHandlers} from "./ipc/audioHandlers.js";

import AdmZip from "adm-zip";

const {setupScreenSharingMain} = require("@jitsi/electron-sdk");

// Const { JitsiMeetElectron } = require('@jitsi/electron-sdk');

// Глобальная переменная для Jitsi окна
let windowCreating = false;
let JitsiMeetElectron: any;
try {
  const jitsiModule = require("@jitsi/electron-sdk");
  JitsiMeetElectron =
    jitsiModule.default || jitsiModule.JitsiMeetElectron || jitsiModule;
  log.info(`🎯[Jitsi SDK] Module loaded:`, typeof JitsiMeetElectron);
} catch (error: any) {
  log.error(`🎯[Jitsi SDK] Failed to load module:`, error.message);
}

const JWT_SECRET = "HguV/8QBrJdCih2Ycpoz0g5q5m85apT3Nu6E+lDvufg=";

const screenCaptureAddon: any = null;

const openAppStoreIfMac = (appId: string) => {
  if (process.platform === "darwin") {
    // Только macOS
    const url = `macappstore://itunes.apple.com/app/id${appId}`;
    shell.openExternal(url).catch(console.error);

    return true;
  }

  console.log("App Store доступен только на macOS");
  // Можно предложить альтернативный способ (например, открыть веб‑страницу)

  return false;
};

// Проверка разрешений на запись экрана для macOS
const checkScreenRecordingPermission = (): {
  granted: boolean;
  status: string;
} => {
  if (process.platform !== "darwin") {
    return {granted: true, status: "not_required"};
  }

  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    log.info(`🎯[ScreenPermission] macOS screen recording status: ${status}`);

    if (status === "granted") {
      return {granted: true, status};
    }

    if (status === "denied") {
      log.warn(
        "🎯[ScreenPermission] Screen recording permission DENIED. User needs to enable it in System Preferences.",
      );
      return {granted: false, status};
    }

    if (status === "not-determined") {
      log.info(
        "🎯[ScreenPermission] Screen recording permission not determined yet. Will be requested on first use.",
      );
      return {granted: false, status};
    }

    // Restricted или unknown
    log.warn(`🎯[ScreenPermission] Screen recording status: ${status}`);
    return {granted: false, status};
  } catch (error: any) {
    log.error(
      `🎯[ScreenPermission] Error checking permission: ${error.message}`,
    );
    return {granted: false, status: "error"};
  }
};

// Создаем поток для записи логов
const preloadLogStream = fs.createWriteStream(
  path.join(process.cwd(), "preload-debug.log"),
  {flags: "a"}, // Append mode
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
  log.transports.console.level = false;
}

// Настройка автообновления
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const {GDK_BACKEND} = process.env;

// Инициализация Sentry для основного процесса
sentryInit();

let mainWindowState: windowStateKeeper.State;
let mainWindow: BrowserWindow;
let badgeCount: number;
let isQuitting = false;

// Переменные для управления горячей клавишей микрофона
let currentVolumeHotkey: string | null = null;
let currentVolumeHotkeyPressed = false;
let volumeHotkeyWasPressed = false;
let currentMicHotkey: string | null = null;
let currentMicHotkeyPressed = false;

type KeyName =
  // Латинские буквы (A–Z)
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  // Цифры (0–9)
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  // Основные символы
  | "DOT"
  | "FORWARD SLASH"
  | "BACKSLASH"
  | "SEMICOLON"
  | "COMMA"
  | "EQUALS"
  | "MINUS"
  | "QUOTE"
  | "SPACE"
  // Модификаторы
  | "LEFT SHIFT"
  | "RIGHT SHIFT"
  | "LEFT CTRL"
  | "LEFT ALT"
  | "CAPS LOCK"
  // Control клавиши
  | "TAB"
  | "ESCAPE"
  | "BACKSPACE"
  | "DELETE"
  | "UP ARROW"
  | "DOWN ARROW"
  | "LEFT ARROW"
  | "RIGHT ARROW"
  | "PAGE UP"
  | "PAGE DOWN"
  | "HOME"
  | "END"
  // Мышь
  | "MOUSE LEFT"
  | "MOUSE RIGHT"
  | "MOUSE MIDDLE"
  | "MOUSE X1"
  | "MOUSE X2"
  | `MOUSE BUTTON ${number}`
  // Расширенные кнопки навигации (часто боковые кнопки мыши на Windows)
  | "BROWSER BACK"
  | "BROWSER FORWARD";

// Map для Windows: VK Code (decimal) → KeyName
const winVKToName: Record<number, KeyName> = {
  // Латинские буквы (A=65, B=66, ..., Z=90)
  65: "A",
  66: "B",
  67: "C",
  68: "D",
  69: "E",
  70: "F",
  71: "G",
  72: "H",
  73: "I",
  74: "J",
  75: "K",
  76: "L",
  77: "M",
  78: "N",
  79: "O",
  80: "P",
  81: "Q",
  82: "R",
  83: "S",
  84: "T",
  85: "U",
  86: "V",
  87: "W",
  88: "X",
  89: "Y",
  90: "Z",

  // Цифры (0=48, 1=49, ..., 9=57)
  48: "0",
  49: "1",
  50: "2",
  51: "3",
  52: "4",
  53: "5",
  54: "6",
  55: "7",
  56: "8",
  57: "9",

  // Основные символы
  190: "DOT", // VK_OEM_PERIOD
  191: "FORWARD SLASH", // VK_OEM_2
  220: "BACKSLASH", // VK_OEM_5
  186: "SEMICOLON", // VK_OEM_1
  188: "COMMA", // VK_OEM_COMMA
  187: "EQUALS", // VK_OEM_PLUS
  189: "MINUS", // VK_OEM_MINUS
  222: "QUOTE", // VK_OEM_7
  32: "SPACE", // VK_SPACE

  // Модификаторы
  160: "LEFT SHIFT", // VK_LSHIFT
  161: "RIGHT SHIFT", // VK_RSHIFT
  162: "LEFT CTRL", // VK_LCONTROL
  164: "LEFT ALT", // VK_LMENU
  20: "CAPS LOCK", // VK_CAPITAL

  // Control клавиши
  9: "TAB",
  27: "ESCAPE", // VK_ESCAPE
  8: "BACKSPACE", // VK_BACK
  46: "DELETE", // VK_DELETE
  38: "UP ARROW", // VK_UP
  40: "DOWN ARROW", // VK_DOWN
  37: "LEFT ARROW", // VK_LEFT
  39: "RIGHT ARROW", // VK_RIGHT
  33: "PAGE UP", // VK_PRIOR
  34: "PAGE DOWN", // VK_NEXT
  36: "HOME", // VK_HOME
  35: "END",
  // Расширенные браузерные кнопки (обычно Mouse4/Mouse5)
  166: "BROWSER BACK", // VK_BROWSER_BACK
  167: "BROWSER FORWARD", // VK_BROWSER_FORWARD
};

// Map для macOS: CGKeyCode (decimal) → KeyName (Apple Carbon Codes)
const macKeyCodeToName: Record<number, KeyName> = {
  // Латинские буквы (unique codes)
  0: "A", // A
  11: "B", // B
  8: "C", // C
  2: "D", // D
  14: "E", // E
  3: "F", // F
  5: "G", // G
  4: "H", // H
  34: "I", // I
  38: "J", // J
  40: "K", // K
  37: "L", // L
  46: "M", // M
  45: "N", // N
  31: "O", // O
  35: "P", // P
  12: "Q", // Q
  13: "W", // W (было 19? Ошибка, W=13)
  15: "R", // R
  16: "Y", // Y
  17: "T", // T
  32: "U", // U
  9: "V", // V
  7: "X", // X (было 25? Ошибка, X=7)
  6: "Z", // Z
  1: "S", // S

  // Цифры (top row, unique codes)
  29: "0", // 0
  18: "1", // 1
  19: "2", // 2
  20: "3", // 3
  21: "4", // 4
  23: "5", // 5
  22: "6", // 6
  26: "7", // 7
  28: "8", // 8
  25: "9", // 9

  // Основные символы (unique)
  47: "DOT", // . (period)
  44: "FORWARD SLASH", // /
  42: "BACKSLASH", // \
  41: "SEMICOLON", // ;
  43: "COMMA", // ,
  24: "EQUALS", // =
  27: "MINUS", // -
  39: "QUOTE", // '
  49: "SPACE", // Space
};

const store = new Store();

class CustomKeyboardListener extends GlobalKeyboardListener {
  constructor() {
    // MacOS-specific custom config
    const customConfig: any = {};
    if (process.platform === "darwin") {
      const libraryPackageJson = require.resolve(
        "node-global-key-listener/package.json",
      );
      const libraryBinaryPath = path.join(
        path.dirname(libraryPackageJson),
        "bin",
        "MacKeyServer",
      );

      customConfig.mac = {
        serverPath: libraryBinaryPath, // Абсолютный путь к lib binary (обходит project bin)
        // Дополнительно: onError, onInfo если нужно
      };

      log.info(`🔧 Custom config for mac: serverPath = ${libraryBinaryPath}`);

      // Проверяем и chmod lib binary (профилактика)
      if (fs.existsSync(libraryBinaryPath)) {
        try {
          child_process.execSync(`chmod +x "${libraryBinaryPath}"`, {
            stdio: "ignore",
          });
          log.info(`✅ Lib binary chmod: ${libraryBinaryPath}`);
        } catch (error: any) {
          log.warn(`⚠️ Lib chmod ignored: ${error.message}`); // Уже +x
        }
      } else {
        log.error(`❌ Lib binary missing: ${libraryBinaryPath}`);
      }
    } else if (process.platform === "win32") {
      // Windows: Lib WinKeyServer.exe
      const libPackageJson = require.resolve(
        "node-global-key-listener/package.json",
      );
      const libBinPath = path.join(
        path.dirname(libPackageJson),
        "bin",
        "WinKeyServer.exe",
      );
      customConfig.windows = {
        serverPath: libBinPath, // Абсолютный путь к bundled .exe (обходит project bin/)
      };
      log.info(`🔧 Windows config: serverPath = ${libBinPath}`);
      // Проверяем существование (bundled .exe должен быть)
      if (fs.existsSync(libBinPath)) {
        log.info(`✅ Windows lib exe found: ${libBinPath}`);
      } else {
        log.error(
          `❌ Windows lib exe missing: ${libBinPath} — reinstall node-global-key-listener`,
        );
      }
    } else {
      log.info(`🔧 Default config for ${process.platform}`);
    }

    // Передаём customConfig в super — keyServer создастся с ним
    super(customConfig);
  }

  public async startListener(): Promise<void> {
    log.info(`🔧 Starting listener with custom config`);
    return this.start(); // Родительский start (keyServer уже с правильным path)
  }

  public stopListener(): void {
    this.stop();
  }
}

const mainUrl = new URL("app/renderer/main.html", bundleUrl).href;

// Создаём маппинг keycode → имя клавиши
const keyboardVolume = new CustomKeyboardListener();
const keyboardMic = new CustomKeyboardListener();

const permissionCallbacks = new Map<number, (grant: boolean) => void>();
const nextPermissionCallbackId = 0;

const appIcon = path.join(publicPath, "resources/Icon");

const iconPath = (): string => {
  if (process.platform === "win32") {
    return appIcon + ".ico";
  }

  if (process.platform === "darwin") {
    return appIcon + ".png";
  }

  return appIcon + ".png";
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

  const icon = iconPath();

  const win = new BrowserWindow({
    title: "RM",
    icon,
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 500,
    minHeight: 400,
    frame: false, // Убираем стандартную рамку окна
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined, // Для macOS
    webPreferences: {
      preload: path.join(bundlePath, "renderer.js"),
      sandbox: false,
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    backgroundColor: "#333",
  });

  remoteMain.enable(win.webContents);

  // КРИТИЧНО: Устанавливаем preload для ВСЕХ webContents включая Zulip
  win.webContents.on(
    "will-attach-webview",
    (
      event: Electron.Event,
      webPreferences: Electron.WebPreferences,
      parameters: any,
    ) => {
      log.info(`Main: WebView создается с URL: ${parameters.src}`);

      // ИСПРАВЛЕНИЕ: Устанавливаем preload для всех webview
      const preloadPath = path.join(bundlePath, "preload.js");
      webPreferences.preload = preloadPath;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;

      log.info(`Main: Webview preload установлен: ${preloadPath}`);
    },
  );

  // НОВОЕ: Слушаем создание новых webContents
  app.on("web-contents-created", (event, contents) => {
    contents.on("console-message", (event, level, message, line, sourceId) => {
      if (
        message.includes("[NativeCapture]") ||
        message.includes("[electron_bridge]")
      ) {
        log.info(`Jitsi Console: ${message}`);
      }
    });

    // Слушаем IPC сообщения через executeJavaScript bridge
    contents.on("did-finish-load", () => {
      const url = contents.getURL();

      // Если это Jitsi окно
      if (url && url.includes("jitsi")) {
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

  await win.loadFile(
    path.join(__dirname, "..", "app", "renderer", "main.html"),
  );

  await win.loadURL(mainUrl).then(() => {
    console.log("✅ Окно создано!");
    if (ConfigUtil.getConfigItem("startMinimized", false)) {
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

  win.webContents.on(
    "will-attach-webview",
    (
      event: Electron.Event,
      webPreferences: Electron.WebPreferences,
      parameters: any,
    ) => {
      log.info(`Main: WebView создается с URL: ${parameters.src}`);

      // ВАЖНО: Устанавливаем правильный preload для webview
      const preloadPath = path.join(bundlePath, "preload.js");
      webPreferences.preload = preloadPath;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;

      log.info(`Main: Webview preload установлен: ${preloadPath}`);
      log.info(
        `Main: Preload файл существует: ${require("node:fs").existsSync(preloadPath)}`,
      );
    },
  );

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

  // Установка кастомного меню приложения
  AppMenu.setMenu({tabs: [], activeTabIndex: 0, enableMenu: false});
  // === НОВЫЙ КОД ===
  const nativeCaptureManager = new NativeCaptureManager(); // Оставляем для других целей
  // const jitsiPureManager = new JitsiPureManager(bundlePath, iconPath());
  const conferenceClose = (roomName: string) => {
    sendEventToZulip("jitsi-conference-close", {roomName});
  };

  const jitsiSDKManager = new JitsiSDKManager(iconPath(), conferenceClose);

  // Связываем NativeCaptureManager с JitsiSDKManager для индикатора статуса и запуска захвата
  jitsiSDKManager.setNativeCaptureManager(nativeCaptureManager);
  nativeCaptureManager.setAudioStatusCallback((isActive, packetCount) => {
    jitsiSDKManager.updateAudioStatus(isActive, packetCount);
  });

  // 2. ЗАТЕМ создаем сессию
  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  // 2.5 Регистрируем Audio IPC handlers (для Virtual Cable на Windows)
  registerAudioHandlers();

  // 3. РЕГИСТРИРУЕМ ВСЕ IPC ОБРАБОТЧИКИ ДО СОЗДАНИЯ ОКНА

  const isNativeCapturing = false;
  const frameCollectionInterval: NodeJS.Timeout | null = null;

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
      if (url && (url.includes("rm-svz") || url.includes("localhost:9991"))) {
        content.send("zulip-message", {
          type: eventName,
          data,
        });
        break;
      }
    }
  }

  function createSourceThumbnail(source: any): string {
    const colors: Record<string, string> = {
      screen: "#4CAF50",
      display: "#4CAF50",
      window: "#2196F3",
      application: "#FF9800",
    };

    const color = colors[source.type] || "#9E9E9E";
    const icon =
      source.type === "screen" || source.type === "display" ? "🖥️" : "🪟";

    const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="200" fill="${color}"/>
        <text x="150" y="80" font-size="50" text-anchor="middle" fill="white">${icon}</text>
        <text x="150" y="130" font-size="16" text-anchor="middle" fill="white" font-weight="bold">
        ${(source.name || "Unknown").replaceAll(/[<>&"']/g, "")}
        </text>
        ${
          source.appName
            ? `
        <text x="150" y="155" font-size="14" text-anchor="middle" fill="white" opacity="0.9">
            ${source.appName.replaceAll(/[<>&"']/g, "")}
        </text>
        `
            : ""
        }
        <rect x="20" y="180" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
        <rect x="20" y="180" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
    </svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  // Обработчик get-desktop-sources с опциональной фильтрацией
  // options.types: ['screen'] - только экраны, ['screen', 'window'] - всё (по умолчанию)
  ipcMain.handle(
    "get-desktop-sources",
    async (event, options?: {types?: string[]}) => {
      try {
        const requestedTypes = options?.types || ["screen", "window"];
        const onlyScreens =
          requestedTypes.length === 1 && requestedTypes[0] === "screen";

        log.info(
          `🎯[DesktopSources] Getting sources, types: ${requestedTypes.join(", ")}`,
        );

        let formattedSources: any[] = [];

        // Создаем маппинг для сохранения оригинальных ID
        const sourceIdMapping = new Map();

        // Получаем источники из native addon
        if (
          screenCaptureAddon &&
          typeof screenCaptureAddon.getAvailableSources === "function"
        ) {
          try {
            const nativeSources =
              await screenCaptureAddon.getAvailableSources();
            log.info(
              `🎯[NativeCapture] Got ${nativeSources.length} native sources`,
            );

            if (nativeSources.length > 0) {
              // Фильтруем источники если запрошены только экраны
              const filteredNative = onlyScreens
                ? nativeSources.filter(
                    (s: {type: string}) => s.type !== "window",
                  )
                : nativeSources;

              log.info(
                `🎯[NativeCapture] After filter: ${filteredNative.length} sources`,
              );

              // Логируем первые несколько источников для отладки
              filteredNative
                .slice(0, 3)
                .forEach(
                  (
                    source: {id: string; name: string; type: string},
                    i: number,
                  ) => {
                    log.info(
                      `  Native source ${i}: id=${source.id}, name=${source.name}, type=${source.type}`,
                    );
                  },
                );

              formattedSources = filteredNative.map(
                (
                  source: {id: string; name: string; type: string},
                  index: number,
                ) => {
                  const type = source.type === "window" ? "window" : "screen";

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
                    const numericId = Math.abs(
                      originalId
                        .toString()
                        .split("")
                        .reduce((a: number, b: string) => {
                          a = (a << 5) - a + b.charCodeAt(0);
                          return a & a;
                        }, 0),
                    );
                    formattedId = `${type}:${numericId}:0`;

                    // Сохраняем маппинг
                    sourceIdMapping.set(formattedId, originalId);
                  } else {
                    // Fallback - генерируем случайный ID
                    const randomId = Math.floor(
                      100_000 + Math.random() * 900_000,
                    );
                    formattedId = `${type}:${randomId}:0`;
                  }

                  log.info(
                    `  Formatted: ${formattedId} -> original: ${originalId}`,
                  );

                  return {
                    id: formattedId,
                    name: `🎯 ${source.name || "Source " + index}`,
                    thumbnail: {
                      dataUrl: createSourceThumbnail(source),
                    },
                    isNative: true,
                    sourceType: "native",
                    originalId, // Сохраняем оригинальный ID
                    originalType: source.type,
                  };
                },
              );

              // Сохраняем маппинг глобально для последующего использования
              (global as any).nativeSourceMapping = sourceIdMapping;

              log.info(
                `🎯[NativeCapture] Created source mapping with ${sourceIdMapping.size} entries`,
              );
            }
          } catch (error: any) {
            log.error(
              `🎯[NativeCapture] Error getting native sources: ${error.message}`,
            );
          }
        }

        // Если нет native источников, используем Electron
        if (formattedSources.length === 0) {
          log.info(
            `🎯[DesktopSources] Using Electron fallback, types: ${requestedTypes.join(", ")}`,
          );
          const electronSources = await desktopCapturer.getSources({
            types: requestedTypes as Array<"screen" | "window">,
            thumbnailSize: {width: 300, height: 200},
          });

          formattedSources = electronSources.map((source) => ({
            id: source.id,
            name: source.name,
            thumbnail: {
              dataUrl: source.thumbnail.toDataURL(),
            },
            isNative: false,
          }));

          log.info(
            `🎯[DesktopSources] Got ${formattedSources.length} Electron sources`,
          );
        }

        return formattedSources;
      } catch (error: any) {
        log.error(`🎯[DesktopSources] Error: ${error.message}`);
        return [];
      }
    },
  );

  // Специальный обработчик для iframe режима Jitsi - возвращает ТОЛЬКО экраны
  ipcMain.handle("get-desktop-sources-screens-only", async () => {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("🎯 [MAIN] get-desktop-sources-screens-only ВЫЗВАН!");
    console.log("═══════════════════════════════════════════════════════════");
    log.info("🎯[DesktopSources-ScreensOnly] Getting screen sources only...");

    try {
      // Проверяем разрешения на macOS
      const permissionCheck = checkScreenRecordingPermission();
      console.log(
        `🎯 [MAIN] Проверка разрешений macOS: granted=${permissionCheck.granted}, status=${permissionCheck.status}`,
      );

      if (!permissionCheck.granted && permissionCheck.status === "denied") {
        console.log("⚠️ [MAIN] Разрешение на запись экрана ОТКЛОНЕНО!");
        log.warn(
          "🎯[DesktopSources-ScreensOnly] Screen recording permission denied on macOS",
        );
        // Можно показать диалог с инструкцией пользователю
        dialog.showMessageBox({
          type: "warning",
          title: "Требуется разрешение",
          message:
            "Для демонстрации экрана необходимо разрешение на запись экрана",
          detail:
            "Пожалуйста, перейдите в Системные настройки → Конфиденциальность и безопасность → Запись экрана и разрешите доступ для этого приложения.",
          buttons: ["Понятно"],
        });
      }

      console.log("🎯 [MAIN] Вызываем desktopCapturer.getSources...");
      const electronSources = await desktopCapturer.getSources({
        types: ["screen"], // Только экраны, без окон
        thumbnailSize: {width: 300, height: 200},
      });

      console.log(
        `🎯 [MAIN] desktopCapturer вернул ${electronSources.length} источников`,
      );

      const formattedSources = electronSources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: {
          dataUrl: source.thumbnail.toDataURL(),
        },
        isNative: false,
      }));

      console.log(
        "───────────────────────────────────────────────────────────",
      );
      console.log(`🎯 [MAIN] Возвращаем ${formattedSources.length} экранов:`);
      formattedSources.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.name} (${s.id})`);
      });
      console.log(
        "───────────────────────────────────────────────────────────",
      );

      log.info(
        `🎯[DesktopSources-ScreensOnly] Returning ${formattedSources.length} screen sources`,
      );

      // Логируем источники
      formattedSources.forEach((s, i) => {
        log.info(`  Screen ${i}: ${s.name} (${s.id})`);
      });

      return formattedSources;
    } catch (error: any) {
      console.error(`❌ [MAIN] ОШИБКА: ${error.message}`);
      console.error(error.stack);
      log.error(`🎯[DesktopSources-ScreensOnly] Error: ${error.message}`);
      return [];
    }
  });

  // Обработчик для проверки разрешений на запись экрана (для отладки и UI)
  ipcMain.handle("check-screen-permission", async () => {
    const result = checkScreenRecordingPermission();
    console.log(
      `🎯 [MAIN] check-screen-permission: granted=${result.granted}, status=${result.status}`,
    );
    return result;
  });

  ipcMain.handle("jitsi-connect-with-zulip-config", async (event, options) => {
    log.info("🎯[Jitsi] Connecting with Zulip config using SDK...");
    log.info(`🎯[Jitsi] Options received: ${JSON.stringify(options)}`);
    if (windowCreating) {
      return {
        success: true,
        conferenceStarted: true,
      };
    }

    windowCreating = true;

    try {
      // НЕ показываем диалог выбора экрана при старте
      // Он будет показан только когда пользователь нажмет кнопку демонстрации
      const enableScreenPicker = false; // Отключаем предварительный выбор

      log.info(`🎯[Jitsi] Starting conference without pre-selection`);

      // Используем SDK менеджер

      const result = await jitsiSDKManager.createWindow({
        roomName: options.roomName || "",
        serverUrl: options.serverUrl || "https://jitsi-connectrm.ru",
        displayName: options.userInfo?.displayName || "Guest",
        email: options.userInfo?.email || "",
        avatarUrl: options.userInfo?.avatarUrl || "",
        jwt: options.jwt || "",
        topic: options.topic || "",
        stream: options.stream || "",
        enableScreenPicker, // Отключен предварительный выбор
      });
      windowCreating = false;
      if (result.success) {
        log.info(`🎯[Jitsi SDK] Conference window created successfully`);

        const soundHotkey = store.get("currentVolumeHotkey", "");
        const micHotkey = store.get("currentMicHotkey", "");

        if (soundHotkey != null) {
          setupAudio(soundHotkey as string);
        }

        if (micHotkey != null) {
          setupMic(micHotkey as string);
        }

        // Отправляем событие в Zulip
        sendEventToZulip("jitsi-conference-ready", {
          success: true,
          roomName: options.roomName,
        });
        return {
          success: true,
          conferenceStarted: true,
        };
      }

      return {
        success: true, // Чтобы Zulip не запускал iframe
        conferenceStarted: false,
      };
    } catch (error: any) {
      windowCreating = false;
      log.error(`🎯[Jitsi SDK] Error: ${error.message}`);

      dialog.showErrorBox(
        "Ошибка подключения",
        `Не удалось запустить конференцию: ${error.message}`,
      );

      return {
        success: true, // Чтобы Zulip не запускал iframe
        conferenceStarted: false,
        error: error.message,
      };
    }
  });

  // Обработчики событий от Jitsi окна
  ipcMain.on("jitsi-api-ready", (event, data) => {
    log.info(`🎯[Jitsi] API ready in window: ${JSON.stringify(data)}`);
    sendEventToZulip("jitsi-api-ready", data);
  });

  ipcMain.on("jitsi-conference-joined", () => {
    log.info(`🎯[Jitsi] User joined conference`);
    sendEventToZulip("jitsi-conference-joined", {});
  });

  ipcMain.on("jitsi-conference-left", () => {
    log.info(`🎯[Jitsi] User left conference`);
    sendEventToZulip("jitsi-conference-left", {});
  });

  ipcMain.on("electron-bridge-event", async (event, data) => {
    log.info(`Main: electron_bridge event: ${data.event}`);

    if (data.event === "requestDesktopSources") {
      try {
        // Используем NativeCaptureManager
        const sources = await nativeCaptureManager.getSources();

        log.info(`🔍 Got ${sources.length} sources`);

        // Проверяем статус SDK окна
        const jitsiStatus = await jitsiSDKManager.getStatus();
        if (jitsiStatus.hasWindow && jitsiStatus.isConnected) {
          log.info("Jitsi SDK: Conference is active");
        }
      } catch (error: any) {
        log.error(`🔍 Error: ${error.message}`);
      }
    }
  });

  (ipcMain as any).on(
    "ipc-invoke",
    async (
      event: any,
      data: {channel: string; requestId: number; args: unknown[]},
    ) => {
      log.info(`Main: Synthetic IPC invoke: ${data.channel}`);

      try {
        let result: unknown;

        // Роутинг к существующим обработчикам напрямую через emit
        // Примечание: ipcMain.handle регистрирует обработчики, но не позволяет вызывать их напрямую
        // Используем отдельную логику для синтетических вызовов
        if (
          data.channel === "jitsi-connect-with-zulip-config" ||
          data.channel === "test-zulip-bridge"
        ) {
          // Отправляем через стандартный invoke со стороны renderer
          log.warn(
            `Main: Synthetic invoke for ${data.channel} - use standard ipcRenderer.invoke instead`,
          );
          result = {success: false, error: "Use standard IPC invoke"};
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
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log.error(`Main: IPC invoke error: ${errorMessage}`);

        event.sender.executeJavaScript(`
              window.dispatchEvent(new CustomEvent('ipc-response', {
                  detail: {
                      requestId: ${data.requestId},
                      data: null,
                      error: "${errorMessage}"
                  }
              }));
          `);
      }
    },
  );

  // Обработчик запуска нативного захвата
  ipcMain.handle("start-native-capture", async (event, sourceId: string) =>
    nativeCaptureManager.startCapture(sourceId),
  );

  // Обработчик остановки захвата
  ipcMain.handle("stop-native-capture", async () =>
    nativeCaptureManager.stopCapture(),
  );

  // Обработчик получения статуса захвата
  (ipcMain as any).handle("get-capture-status", async () =>
    nativeCaptureManager.getStatus(),
  );

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

  ipcMain.on("forward-message", (event, channel, ...arguments_) => {
    log.info(`Main: Получено forward-message с каналом: ${channel}`);
    for (const content of webContents.getAllWebContents()) {
      content.send("forward-message", channel, ...arguments_);
    }
  });

  // Обработчик jitsi-log-event
  ipcMain.on("jitsi-log-event", (event, logData) => {
    log.info(`Jitsi Log [${logData.level}]: ${logData.message}`);
    console.log(`Jitsi Log [${logData.level}]: ${logData.message}`);
  });

  ipcMain.on("preload-log", (event, message: string) => {
    log.info(`Preload Log: ${message}`);
    console.log(`Preload Log: ${message}`);
  });

  // Обработчик для установки горячей клавиши микрофона
  ipcMain.on("global-volume-hotkey", (event, status: WalkieTalkieStatus) => {
    log.info(
      `Main: Получено новое событие global-volume-hotkey: ${JSON.stringify(status)}`,
    );
    if (typeof status !== "object" || status === null || !("key" in status)) {
      log.error(
        `Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`,
      );
      return;
    }

    const {key: rawKey} = status;
    setupAudio(rawKey);
  });

  ipcMain.on("walkie-talkie-status", (event, status: WalkieTalkieStatus) => {
    log.info(
      `Main: Получено новое событие walkie-talkie-status: ${JSON.stringify(status)}`,
    );
    if (typeof status !== "object" || status === null || !("key" in status)) {
      log.error(
        `Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`,
      );
      return;
    }

    const {key: rawKey} = status;
    setupMic(rawKey);
  });

  /**
   * Отправляет сообщение горячей клавиши во все webview (Zulip).
   * Используется когда нет отдельного нативного окна Jitsi SDK —
   * команды управления аудио/микрофоном пересылаются в webview,
   * чтобы веб-приложение (Zulip) могло обработать их самостоятельно.
   */
  function sendHotkeyToWebviews(
    channel: "hotkey-audio-muted" | "hotkey-mic-muted",
    muted: boolean,
  ) {
    log.info(
      `Main: Нет активного Jitsi окна — отправляем ${channel}(${muted}) в webview`,
    );
    for (const content of webContents.getAllWebContents()) {
      // Отправляем во все webContents — preload-скрипт в каждом webview
      // обработает сообщение и пробросит его через electron_bridge
      content.send(channel, muted);
    }
  }

  function setupAudio(rawKey: string) {
    // 🔊 Регистрируем горячую клавишу для управления громкостью
    if (currentVolumeHotkey || rawKey == "") {
      keyboardVolume.stopListener();
      log.info(`Main: Остановлен предыдущий слушатель: ${currentVolumeHotkey}`);
    }

    if (rawKey == "") {
      currentVolumeHotkey = "";
      store.set("currentVolumeHotkey", "");
      return;
    }

    const key = String(normalizeHotkeyString(rawKey));

    currentVolumeHotkey = key;
    store.set("currentVolumeHotkey", key);

    keyboardVolume.startListener().catch((error) => {
      log.error(`Main: Ошибка запуска слушателя: ${error}`);
    });

    keyboardVolume.addListener(
      (e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
        const parts = key.split("+").map((p: string) => p.toLowerCase());
        const mainKey = parts.pop()!;

        const pressedKeyName = String(
          normalizeKeyNameForMatch(
            String(
              getPressedKeyNameFromEvent(e, process.platform, {
                mac: macKeyCodeToName,
                win: winVKToName,
              }),
            ).toLowerCase(),
          ),
        ).toUpperCase();
        const isPressed = Boolean(
          (down as Record<string, boolean>)[pressedKeyName],
        );
        const normalizedMainKey =
          normalizeKeyNameForMatch(mainKey).toUpperCase();

        // Проверяем, что нажата именно нужная клавиша
        if (pressedKeyName !== normalizedMainKey) {
          return;
        }

        // Если клавиша нажата И ранее не была зажата — это новое нажатие!
        if (isPressed && !volumeHotkeyWasPressed) {
          volumeHotkeyWasPressed = true; // Помечаем, что клавиша уже обработана

          log.info(`Main: Полное нажатие клавиши громкости — переключаем звук`);
          log.info(
            `Сейчас ${currentVolumeHotkeyPressed}, а станет ${!currentVolumeHotkeyPressed}`,
          );

          // Переключаем состояние: если был выключен — включаем, и наоборот
          const newMutedState = !currentVolumeHotkeyPressed;

          if (jitsiSDKManager.hasActiveWindow()) {
            // Есть нативное окно Jitsi — управляем через SDK
            jitsiSDKManager.setLocalAudioMuted(newMutedState);
          } else {
            // Нет нативного окна — отправляем в webview
            sendHotkeyToWebviews("hotkey-audio-muted", newMutedState);
          }

          currentVolumeHotkeyPressed = newMutedState;
        }

        // Если клавиша отпущена — сбрасываем флаг
        if (!isPressed && volumeHotkeyWasPressed) {
          volumeHotkeyWasPressed = false;
        }
      },
    );
  }

  function setupMic(rawKey: string) {
    // 🔊 Регистрируем горячую клавишу для управления микрофоном
    if (currentMicHotkey || rawKey == "") {
      keyboardMic.stopListener();
      log.info(
        `Main: Остановлен node-global-key-listener для предыдущей клавиши: ${currentMicHotkey}`,
      );
    }

    if (rawKey == "") {
      currentMicHotkey = "";
      store.set("currentMicHotkey", "");
      return;
    }

    const key = String(normalizeHotkeyString(rawKey));

    currentMicHotkey = key;
    store.set("currentMicHotkey", key);

    keyboardMic.startListener().catch((error) => {
      log.error(`Main: Ошибка запуска слушателя: ${error}`);
    });

    keyboardMic.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
      const parts = key.split("+").map((p: string) => p.toLowerCase());
      const mainKey = parts.pop()!;
      const pressedKeyName = String(
        normalizeKeyNameForMatch(
          String(
            getPressedKeyNameFromEvent(e, process.platform, {
              mac: macKeyCodeToName,
              win: winVKToName,
            }),
          ).toLowerCase(),
        ),
      ).toUpperCase();
      const isPressed = Boolean(
        (down as Record<string, boolean>)[pressedKeyName],
      );
      const normalizedMainKey = normalizeKeyNameForMatch(mainKey).toUpperCase();

      if (pressedKeyName !== normalizedMainKey) {
        return;
      }

      if (isPressed && !currentMicHotkeyPressed) {
        log.info(`Main: Нажата клавиша микрофона — включаем микрофон`);

        if (jitsiSDKManager.hasActiveWindow()) {
          jitsiSDKManager.setLocalMicMuted(false);
        } else {
          sendHotkeyToWebviews("hotkey-mic-muted", false);
        }

        currentMicHotkeyPressed = true;
      } else if (isPressed && currentMicHotkeyPressed) {
      } else {
        log.info(`Main: Отпущена клавиша микрофона — выключаем микрофон`);

        if (jitsiSDKManager.hasActiveWindow()) {
          jitsiSDKManager.setLocalMicMuted(true);
        } else {
          sendHotkeyToWebviews("hotkey-mic-muted", true);
        }

        currentMicHotkeyPressed = false;
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

  // Обработчик сброса кнопки - отправляем событие в renderer
  ipcMain.on("reset-update-button", () => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("reset-update-ui");
    }
  });

  async function downloadUpdate(
    url: string,
    destinationPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destinationPath);

      https
        .get(url, (response) => {
          const totalSize = Number.parseInt(
            response.headers["content-length"] || "0",
            10,
          );
          let downloadedSize = 0;

          response.pipe(file);

          response.on("data", (chunk) => {
            downloadedSize += chunk.length;
            const progress =
              totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;

            // Отправляем прогресс в renderer окно
            mainWindow?.webContents.send("update-download-progress", progress);

            // УБИРАЕМ эту строку - ipcRenderer здесь недоступен
            // ipcRenderer.send("update-download-progress", progress);

            // Вместо этого отправляем событие прогресса напрямую
            if (mainWindow) {
              const percent = Math.round(progress);
              mainWindow.webContents
                .executeJavaScript(
                  `
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
                      `,
                )
                .catch(() => {});
            }

            log.info(`Download progress: ${progress.toFixed(2)}%`);
          });

          file.on("finish", () => {
            file.close();
            log.info("Download completed");
            resolve();
          });

          response.on("error", (error) => {
            fs.unlink(destinationPath, () => {});
            reject(error);
          });
        })
        .on("error", (error) => {
          fs.unlink(destinationPath, () => {});
          reject(error);
        });
    });
  }

  // Затем функция распаковки, которая использует downloadUpdate
  async function downloadAndExtractUpdate(
    url: string,
    updateDir: string,
  ): Promise<string> {
    const zipPath = path.join(updateDir, "update.zip");

    // Используем функцию downloadUpdate определенную выше
    await downloadUpdate(url, zipPath);

    log.info("Extracting update...");
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(updateDir, true);

    const files = fs.readdirSync(updateDir);
    const exeFile = files.find((file) => file.endsWith(".exe"));

    if (!exeFile) {
      throw new Error("No .exe file found in archive");
    }

    fs.unlinkSync(zipPath);

    return path.join(updateDir, exeFile);
  }

  ipcMain.handle(
    "handle-zulip-update",
    async (
      event,
      updateInfo: {
        version: string;
        downloadUrl: string;
        releaseNotes?: string;
      },
    ) => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Доступно обновление",
        message: `Доступна новая версия ${updateInfo.version}`,
        detail:
          updateInfo.releaseNotes || "Рекомендуется установить обновление",
        buttons: ["Обновить сейчас", "Позже"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        try {
          const updateDir = path.join(app.getPath("userData"), "updates");

          // Очищаем старые обновления
          if (fs.existsSync(updateDir)) {
            fs.rmSync(updateDir, {recursive: true, force: true});
          }

          fs.mkdirSync(updateDir, {recursive: true});

          mainWindow?.webContents.send(
            "update-status",
            "Загрузка обновления...",
          );

          // Скачиваем и распаковываем
          const exePath = await downloadAndExtractUpdate(
            updateInfo.downloadUrl,
            updateDir,
          );

          log.info(`Launching installer: ${exePath}`);
          mainWindow?.webContents.send(
            "update-status",
            "Запуск установщика...",
          );

          if (process.platform === "win32") {
            // Запускаем найденный exe
            child_process
              .spawn(exePath, [], {
                detached: true,
                stdio: "ignore",
              })
              .unref();

            // Ждем немного и закрываем приложение
            setTimeout(() => {
              app.quit();
            }, 1000);
          }

          return {success: true, action: "updated"};
        } catch (error: any) {
          log.error("Update failed:", error);
          dialog.showErrorBox("Ошибка обновления", error.message);
          return {success: false, error: error.message};
        }
      }

      return {success: true, action: "postponed"};
    },
  );

  // Показать кнопку обновления - просто отправляем событие в renderer
  ipcMain.on("show-update-button", (event, updateInfo) => {
    log.info(
      `📦 Main: Showing update button for version ${updateInfo.version}`,
    );

    if (mainWindow && mainWindow.webContents) {
      // Отправляем событие в renderer, где уже есть логика показа кнопки
      mainWindow.webContents.send("server-update-available", {
        version: updateInfo.version,
        download_url: updateInfo.downloadUrl,
        release_notes: updateInfo.releaseNotes,
      });
    }
  });

  // Обработчик начала обновления
  ipcMain.on(
    "start-update",
    async (
      _event,
      updateInfo: {version: string; downloadUrl: string; releaseNotes?: string},
    ) => {
      log.info(`📦 Starting update to version ${updateInfo.version}`);

      // Показываем диалог обновления напрямую
      const result = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Доступно обновление",
        message: `Доступна новая версия ${updateInfo.version}`,
        detail:
          updateInfo.releaseNotes || "Рекомендуется установить обновление",
        buttons: ["Обновить сейчас", "Позже"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        // Запускаем обновление через renderer
        mainWindow?.webContents.send("start-download-update", updateInfo);
      }

      log.info(
        `📦 Update dialog result: ${result.response === 0 ? "accepted" : "postponed"}`,
      );
    },
  );

  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("download-update", async (event, updateInfo) => {
    try {
      // Если используется electron-updater
      if (autoUpdater) {
        autoUpdater.downloadUpdate();
        return {success: true};
      }

      // Или ручная загрузка
      const updateDir = path.join(app.getPath("userData"), "updates");

      // Очищаем старые обновления перед загрузкой новых
      if (fs.existsSync(updateDir)) {
        fs.rmSync(updateDir, {recursive: true, force: true});
      }

      fs.mkdirSync(updateDir, {recursive: true});

      await downloadUpdateFile(
        updateInfo.downloadUrl,
        updateDir,
        (progress) => {
          mainWindow?.webContents.send("update-download-progress", progress);
        },
      );

      return {success: true};
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {success: false, error: errorMessage};
    }
  });

  ipcMain.on("install-update", () => {
    if (autoUpdater) {
      autoUpdater.quitAndInstall();
    } else {
      // Ручная установка
      const updatePath = path.join(
        app.getPath("userData"),
        "updates",
        "installer.exe",
      );
      if (fs.existsSync(updatePath)) {
        child_process
          .spawn(updatePath, [], {
            detached: true,
            stdio: "ignore",
          })
          .unref();

        setTimeout(() => {
          app.quit();
        }, 1000);
      }
    }
  });

  // Функция для загрузки с прогрессом
  async function downloadUpdateFile(
    url: string,
    destDir: string,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const destinationPath = path.join(destDir, "update.zip");
      const file = fs.createWriteStream(destinationPath);

      https
        .get(url, (response) => {
          const totalSize = Number.parseInt(
            response.headers["content-length"] || "0",
            10,
          );
          let downloadedSize = 0;

          response.on("data", (chunk) => {
            downloadedSize += chunk.length;
            const progress =
              totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;
            onProgress(progress);
          });

          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });

          response.on("error", reject);
        })
        .on("error", reject);
    });
  }

  // Настройка автообновлений с electron-updater
  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("download-progress", (progressObject) => {
    mainWindow?.webContents.send(
      "update-download-progress",
      progressObject.percent,
    );
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
  if (process.platform === "win32") {
    app.setPath("userData", app.getPath("userData"));
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

autoUpdater.on("error", (error) => {
  log.error("Ошибка обновления:", error);
  mainWindow?.webContents.send("update_error", error.message);
});

ipcMain.on("restart_app", () => {
  autoUpdater.quitAndInstall();
});

ipcMain.on("force-update", (event) => {
  log.info(`Производим обновление`);
  if (!openAppStoreIfMac("6749675114")) {
    mainWindow?.webContents.send("force-update");
  }
});

process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});
