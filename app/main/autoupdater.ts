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

export async function appUpdater() {
  try {
    log.info("Checking for updates...");
    await autoUpdater.checkForUpdates();
    log.info("Update check completed successfully");
  } catch (error) {
    log.error("Error checking for updates:", error);
    throw error; // Перебрасываем ошибку для обработки в вызывающем коде
  }
}
