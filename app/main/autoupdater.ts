import { shell } from "electron/common";
import { app, dialog, session } from "electron/main";
import process from "node:process";

import log from "electron-log/main";
import {
  UpdateCheckResult,
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