import * as ConfigUtil from "../../common/config-util.js";

import {ipcRenderer} from "./typed-ipc-renderer.js";

export function initializeTray() {
  // Функция toggle - напрямую меняем настройку и отправляем IPC
  function toggleTray(): void {
    const newState = !ConfigUtil.getConfigItem("trayIcon", true);
    ConfigUtil.setConfigItem("trayIcon", newState);
    ipcRenderer.send("toggle-tray", newState);
  }

  ipcRenderer.on("toggletray", toggleTray);
}
