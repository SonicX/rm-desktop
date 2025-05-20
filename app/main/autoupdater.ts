import { shell } from "electron/common";
import { app, dialog, session } from "electron/main";
import process from "node:process";

import log from "electron-log/main";
import {
  type UpdateDownloadedEvent,
  type UpdateInfo,
  autoUpdater,
} from "electron-updater";

import * as ConfigUtil from "../common/config-util.js";
import * as t from "../common/translation-util.js";

import { linuxUpdateNotification } from "./linuxupdater.js";

let quitting = false;

export function shouldQuitForUpdate(): boolean {
  return quitting;
}

export async function appUpdater(updateFromMenu = true): Promise<void> {
  if (!app.isPackaged) {
    return;
  }

  if (process.platform === "linux" && !process.env.APPIMAGE) {
    const ses = session.fromPartition("persist:webviewsession");
    await linuxUpdateNotification(ses);
    return;
  }

  let updateAvailable = false;

  const updateLogger = log.create({ logId: "updates" });
  updateLogger.transports.file.fileName = "updates.log";
  updateLogger.transports.file.level = "info";
  autoUpdater.logger = updateLogger;

  const isBetaUpdate = ConfigUtil.getConfigItem("betaUpdate", false);
  autoUpdater.allowPrerelease = isBetaUpdate;

  const eventsListenerRemove = ["update-available"] as const;
  autoUpdater.on("update-available", async (info: UpdateInfo) => {
    if (updateFromMenu) {
      updateAvailable = true;

      for (const event of eventsListenerRemove) {
        autoUpdater.removeAllListeners(event);
      }
      
      var index = await dialog.showMessageBox({
                  message: t.__("Новая версия \"Связь РМ\" {{{version}}}.", {
                    version: info.version,
                  }),
                  buttons: ["Закрыть", "Подробнее"],
                  type: "info",
                  detail: t.__(
                    "Обновление будет выполнено в фоне. Мы уведомим вас об завершении.\n" +
                    "Обновили:\n" +
                    "- Расширенные возможности захвата экрана\n" +
                    "- Режим рации: связь без ограничений\n" +
                    "- Улучшения на основе ваших отзывов\n" +
                    "- Гибкая настройка звука"
                  )
                });
          if (index.response == 1) {
            require("electron").shell.openExternal("https://rusmanul.com/new_update_20_05_2025")
          }
    }
  });

  autoUpdater.on("error", async (error: Error) => {
    if (updateFromMenu) {
      autoUpdater.removeAllListeners();

      const messageText = updateAvailable
        ? t.__("Неудалось скачать обновления.")
        : t.__("Неудалось проверить обновления.");
      const link = "https://rusmanul.com/";
      // Исправление: Работаем с Promise<number>, так как это соответствует текущим типам
      const {response} = await dialog.showMessageBox({
        type: "error",
        buttons: [t.__("Установить вручную"), t.__("Закрыть")],
        message: messageText,
        detail: t.__(
          "Ошибка: {{{error}}}\n\nПоследняя версия \"Связь РМ\" доступна:\n{{{link}}}\nТекущая версия: {{{version}}}",
          { error: error.message, link, version: app.getVersion() },
        ),
      });
      if (response === 0) {
        await shell.openExternal(link);
      }
    }
  });

  autoUpdater.on("update-downloaded", async (event: UpdateDownloadedEvent) => {
    // Исправление: Аналогично для update-downloaded
    const {response} = await dialog.showMessageBox({
      type: "question",
      buttons: [t.__("Установить и перезагрузить"), t.__("Установить позже")],
      defaultId: 0,
      message: t.__("Новое обновление {{{version}}} было скачено.", {
        version: event.version,
      }),
      detail: t.__("Оно будет установлен при следующем перезапуске приложения."),
    });
    if (response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  await autoUpdater.checkForUpdates();
}