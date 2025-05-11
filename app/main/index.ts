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

// Настройка логирования
log.transports.file.level = "info";
autoUpdater.logger = log;

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

const mainUrl = new URL("app/renderer/main.html", bundleUrl).href;

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

  win.webContents.on('did-create-webview', (event: Electron.Event, webview: WebContents) => {
    log.info(`Main: Создан WebView с ID: ${webview.id}, URL: ${webview.getURL()}`);
    webview.on('console-message', (_event: Electron.Event, level: number, message: string, line: number, sourceId: string) => {
        log.info(`WebView Console [${level}]: ${message} (line: ${line}, source: ${sourceId})`);
        console.log(`WebView Console [${level}]: ${message} (line: ${line}, source: ${sourceId})`);
    });
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

    if (currentHotkey) {
      globalShortcut.unregister(currentHotkey);
      log.info(`Main: Удалена старая горячая клавиша: ${currentHotkey}`);
    }

    // Преобразуем ключ в строчную букву
    const key = rawKey.toLowerCase();
    log.info(`Main: Преобразован ключ из ${rawKey} в ${key}`);

    const validAccelerators = /^[a-z0-9]+$/;
    const validCombo = /^((Ctrl|Alt|Shift|Command|Meta)\+)+[a-z0-9]+$/;
    if (!validAccelerators.test(key) && !validCombo.test(key)) {
        log.error(`Main: Некорректный формат горячей клавиши: ${key}`);
        return;
    }

    log.info(`Main: Установка горячей клавиши микрофона: ${key}`);
    currentHotkey = key;
    globalShortcut.register(key, () => {
        log.info(`Main: Нажата горячая клавиша: ${key}`);
        if (!mainWindow) {
            log.warn("Main: mainWindow отсутствует");
            return;
        }
        const allWebContents = webContents.getAllWebContents();
        log.info(`Main: Найдено WebContents: ${allWebContents.length}`);
        const activeWebContents = allWebContents.find(content => {
            const url = content.getURL();
            log.info(`Main: Проверка WebContents URL: ${url}, ID: ${content.id}`);
            return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
        });

        if (!activeWebContents) {
            log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru");
            log.info(`Main: Список всех WebContents URL: ${allWebContents.map(c => c.getURL()).join(", ")}`);
            return;
        }

        log.info(`Main: Выбран WebContents ID: ${activeWebContents.id}, URL: ${activeWebContents.getURL()}`);
        originalMuteState = activeWebContents.isAudioMuted();
        const newMuteState = !originalMuteState;
        activeWebContents.setAudioMuted(newMuteState);
        log.info(`Main: Микрофон переключен в состояние: ${newMuteState}`);
        activeWebContents.send("toggle-walkie-talkie", newMuteState);
        log.info(`Main: Отправлено событие toggle-walkie-talkie с isMuted: ${newMuteState}`);
    });

    if (globalShortcut.isRegistered(key)) {
        log.info(`Main: Горячая клавиша ${key} успешно зарегистрирована`);
    } else {
        log.error(`Main: Не удалось зарегистрировать горячую клавишу ${key}`);
    }

    // Регистрация отпускания клавиши
    globalShortcut.register(key, () => {
        log.info(`Main: Отпущена горячая клавиша: ${key}`);
        if (originalMuteState !== null && mainWindow) {
            const allWebContents = webContents.getAllWebContents();
            const activeWebContents = allWebContents.find(content => {
                const url = content.getURL();
                log.info(`Main: Проверка WebContents URL (отпускание): ${url}, ID: ${content.id}`);
                return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
            });

            if (!activeWebContents) {
                log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru (отпускание)");
                return;
            }

            activeWebContents.setAudioMuted(originalMuteState);
            log.info(`Main: Микрофон восстановлен в состояние: ${originalMuteState}`);
            activeWebContents.send("toggle-walkie-talkie", originalMuteState);
            log.info(`Main: Отправлено событие toggle-walkie-talkie с isMuted: ${originalMuteState}`);
            originalMuteState = null;
        } else {
            log.info(`Main: Пропущено восстановление микрофона, originalMuteState: ${originalMuteState}`);
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
    globalShortcut.unregister(currentHotkey);
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