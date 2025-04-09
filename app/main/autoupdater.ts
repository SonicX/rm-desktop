import {shell} from "electron/common";
import {app, dialog, session} from "electron/main";
import process from "node:process";

import log from "electron-log/main";
import {
  type UpdateDownloadedEvent,
  type UpdateInfo,
  autoUpdater,
} from "electron-updater";

import * as ConfigUtil from "../common/config-util.js";
import * as t from "../common/translation-util.js";

import {linuxUpdateNotification} from "./linuxupdater.js"; // Required only in case of linux

let quitting = false;

export function shouldQuitForUpdate(): boolean {
  return quitting;
}

export async function appUpdater(updateFromMenu = true): Promise<void> {
  // Don't initiate auto-updates in development
  if (!app.isPackaged) {
    return;
  }

  if (process.platform === "linux" && !process.env.APPIMAGE) {
    const ses = session.fromPartition("persist:webviewsession");
    await linuxUpdateNotification(ses);
    return;
  }

  let updateAvailable = false;

  // Log what's happening
  const updateLogger = log.create({logId: "updates"});
  updateLogger.transports.file.fileName = "updates.log";
  updateLogger.transports.file.level = "info";
  autoUpdater.logger = updateLogger;

  // Handle auto updates for beta/pre releases
  const isBetaUpdate = ConfigUtil.getConfigItem("betaUpdate", false);

  autoUpdater.allowPrerelease = isBetaUpdate;

  const eventsListenerRemove = [
    "update-available",
    "update-not-available",
  ] as const;
  autoUpdater.on("update-available", async (info: UpdateInfo) => {
    if (updateFromMenu) {
      updateAvailable = true;

      // This is to prevent removal of 'update-downloaded' and 'error' event listener.
      for (const event of eventsListenerRemove) {
        autoUpdater.removeAllListeners(event);
      }

      await dialog.showMessageBox({
        message: t.__(
          "Новая версия \"Связь РМ\" {{{version}}}.",
          {version: info.version},
        ),
        detail: t.__(
          "Обновление будет выполнено в фоне. Мы уведомим вас об завершении.",
        ),
      });
    }
  });

  autoUpdater.on("error", async (error: Error) => {
    if (updateFromMenu) {
      // Remove all autoUpdator listeners so that next time autoUpdator is manually called these
      // listeners don't trigger multiple times.
      autoUpdater.removeAllListeners();

      const messageText = updateAvailable
        ? t.__("Неудалось скачать обновления.")
        : t.__("Неудалось проверить обновления.");
      const link = "https://rusmanul.com/";
      const {response} = await dialog.showMessageBox({
        type: "error",
        buttons: [t.__("Установить вручную"), t.__("Закрыть")],
        message: messageText,
        detail: t.__(
          "Ошибка: {{{error}}}\n\nПоследняя версия \"Связь РМ\" доступна:\n{{{link}}}\nТекущая версия: {{{version}}}",
          {error: error.message, link, version: app.getVersion()},
        ),
      });
      if (response === 0) {
        await shell.openExternal(link);
      }
    }
  });

  // Ask the user if update is available
  autoUpdater.on("update-downloaded", async (event: UpdateDownloadedEvent) => {
    // Ask user to update the app
    const {response} = await dialog.showMessageBox({
      type: "question",
      buttons: [t.__("Установить и перезагрузить"), t.__("Установить позже")],
      defaultId: 0,
      message: t.__("Новое обновление {{{version}}} было скачено.", {
        version: event.version,
      }),
      detail: t.__(
        "Оно будет установлен при следующем перезапуске приложения.",
      ),
    });
    if (response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  // Init for updates
  await autoUpdater.checkForUpdates();
}
