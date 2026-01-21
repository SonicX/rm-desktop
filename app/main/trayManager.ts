// TrayManager.ts
/* eslint-disable unicorn/filename-case, import/no-duplicates, @typescript-eslint/no-unused-vars */

import type {NativeImage} from "electron/common";
import {nativeImage} from "electron/common"; // Исправленный импорт для nativeImage и NativeImage
import {Menu, Tray, app, ipcMain} from "electron/main"; // eslint-disable-line no-restricted-imports
import path from "node:path";
import process from "node:process";

import log from "electron-log/main";

import * as ConfigUtil from "../common/config-util.js"; // Адаптируйте путь
import {publicPath} from "../common/paths.js"; // Адаптируйте путь

let tray: Tray | null = null;
let unread = 0;

const appIcon = path.join(publicPath, "resources/tray/tray");

const iconPath = (): string => {
  if (process.platform === "linux") {
    return appIcon + "linux.png";
  }

  return (
    appIcon + (process.platform === "win32" ? "win.ico" : "macOSTemplate.png")
  );
};

const winUnreadTrayIconPath = (): string => appIcon + "unread.ico";

const trayIconSize = (): number => {
  switch (process.platform) {
    case "darwin": {
      return 20;
    }

    case "win32": {
      return 100;
    }

    case "linux": {
      return 100;
    }

    default: {
      return 80;
    }
  }
};

const config = {
  pixelRatio: 1, // В main нет devicePixelRatio, используем 1
  unreadCount: 0,
  showUnreadCount: true,
  unreadColor: "#000000",
  readColor: "#000000",
  unreadBackgroundColor: "#B9FEEA",
  readBackgroundColor: "#B9FEEA",
  size: trayIconSize(),
  thick: process.platform === "win32",
};

const unreadNativeImage = function (argument: number): NativeImage {
  if (process.platform === "win32") {
    return nativeImage.createFromPath(winUnreadTrayIconPath());
  }

  const iconFile = "tray-unread.png";
  return nativeImage.createFromPath(
    path.join(publicPath, `resources/tray/${iconFile}`),
  );
};

const createTray = function (mainWindow: Electron.BrowserWindow): void {
  log.info("Tray created with icon: " + iconPath());
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Связь РМ",
      click() {
        mainWindow.show();
      },
    },
    {type: "separator"},
    {
      label: "Закрыть",
      click() {
        log.info("Tray: Закрытие приложения");
        app.quit();
      },
    },
  ]);
  tray = new Tray(iconPath());
  tray.setContextMenu(contextMenu);
  if (process.platform === "linux" || process.platform === "win32") {
    tray.on("click", () => {
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        mainWindow.show();
      } else {
        mainWindow.hide();
      }
    });
  }

  log.info("Tray: Создан");
};

export function initializeTrayManager(mainWindow: Electron.BrowserWindow) {
  // Инициализация tray, если включено
  if (ConfigUtil.getConfigItem("trayIcon", true)) {
    createTray(mainWindow);
  }

  // IPC-обработчики
  ipcMain.on("update-badge", (event, count: number) => {
    if (!tray) return;
    unread = count;
    if (process.platform === "linux" || process.platform === "win32") {
      if (count === 0) {
        tray.setImage(iconPath());
        tray.setToolTip("Нет сообщений");
      } else {
        const image = unreadNativeImage(count);
        tray.setImage(image);
        tray.setToolTip(`Сообщения ${count}`);
      }
    }

    log.info(`Tray: Обновлён badge на ${count}`);
  });

  ipcMain.on("toggletray", (event, state: boolean) => {
    if (state && !tray) {
      createTray(mainWindow);
      ConfigUtil.setConfigItem("trayIcon", true);
    } else if (!state && tray) {
      tray.destroy();
      tray = null;
      ConfigUtil.setConfigItem("trayIcon", false);
    }

    // Отправляем событие в рендерер для обновления UI (например, preferences)
    mainWindow.webContents.send("tray-toggled", state);
    log.info(`Tray: Переключён на ${state}`);
  });

  ipcMain.on("destroytray", () => {
    if (tray) {
      tray.destroy();
      tray = null;
      log.info("Tray: Уничтожен");
    }
  });
}
