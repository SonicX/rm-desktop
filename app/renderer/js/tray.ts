import * as ConfigUtil from "../../common/config-util.js";
import type { ServerManagerView } from "./main.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";



export function initializeTray(serverManagerView: ServerManagerView) {
  // Функция toggle теперь отправляет IPC
  function toggleTray(): void {
    const state = !ConfigUtil.getConfigItem("trayIcon", true);
    serverManagerView.preferenceView?.handleToggleTray(state);
  }

  ipcRenderer.on("toggletray", toggleTray);
}