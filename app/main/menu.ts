/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function */
import {shell} from "electron/common";
import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  app,
} from "electron/main";
import process from "node:process";

import AdmZip from "adm-zip";

import * as ConfigUtil from "../common/config-util.js";
import * as DNDUtil from "../common/dnd-util.js";
import * as t from "../common/translation-util.js";
import type {RendererMessage} from "../common/typed-ipc.js";
import type {MenuProperties, TabData} from "../common/types.js";

import {send} from "./typed-ipc-main.js";

const appName = app.name;

function getHistorySubmenu(enableMenu: boolean): MenuItemConstructorOptions[] {
  return [
    {
      label: t.__("Back"),
      accelerator: process.platform === "darwin" ? "Command+Left" : "Alt+Left",
      enabled: enableMenu,
      click(_item, focusedWindow) {
        if (focusedWindow) {
          sendAction("back");
        }
      },
    },
    {
      label: t.__("Forward"),
      accelerator:
        process.platform === "darwin" ? "Command+Right" : "Alt+Right",
      enabled: enableMenu,
      click(_item, focusedWindow) {
        if (focusedWindow) {
          sendAction("forward");
        }
      },
    },
  ];
}

function getHelpSubmenu(): MenuItemConstructorOptions[] {
  return [
    {
      label: `${appName + " Desktop"} v${app.getVersion()}`,
      enabled: false,
    },
    {
      label: t.__("About RM"),
      click(_item, focusedWindow) {
        if (focusedWindow) {
          sendAction("open-about");
        }
      },
    },
  ];
}

function getDarwinTpl(
  properties: MenuProperties,
): MenuItemConstructorOptions[] {
  const {tabs, activeTabIndex, enableMenu = false} = properties;

  return [
    {
      label: app.name,
      submenu: [
        {
          label: t.__("Toggle Do Not Disturb"),
          accelerator: "Cmd+Shift+M",
          click() {
            const dndUtil = DNDUtil.toggle();
            sendAction("toggle-dnd", dndUtil.dnd, dndUtil.newSettings);
          },
        },
        {
          label: t.__("Desktop Settings"),
          accelerator: "Cmd+,",
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("open-settings");
            }
          },
        },
        {
          label: t.__("Keyboard Shortcuts"),
          accelerator: "Cmd+Shift+K",
          enabled: enableMenu,
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("show-keyboard-shortcuts");
            }
          },
        },
        {
          type: "separator",
        },
        {
          label: t.__("Copy RM URL"),
          accelerator: "Cmd+Shift+C",
          enabled: enableMenu,
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("copy-rm-url");
            }
          },
        },
        {
          type: "separator",
        },
        {
          label: t.__("Services"),
          role: "services",
          submenu: [],
        },
        {
          type: "separator",
        },
        {
          label: t.__("Hide"),
          role: "hide",
        },
        {
          label: t.__("Hide Others"),
          role: "hideOthers",
        },
        {
          label: t.__("Unhide"),
          role: "unhide",
        },
        {
          type: "separator",
        },
        {
          label: t.__("Minimize"),
          role: "minimize",
        },
        {
          label: t.__("Close"),
          role: "close",
        },
        {
          label: t.__("Quit"),
          role: "quit",
        },
      ],
    },
    {
      label: t.__("Edit"),
      submenu: [
        {
          label: t.__("Undo"),
          role: "undo",
        },
        {
          label: t.__("Redo"),
          role: "redo",
        },
        {
          type: "separator",
        },
        {
          label: t.__("Cut"),
          role: "cut",
        },
        {
          label: t.__("Copy"),
          role: "copy",
        },
        {
          label: t.__("Paste"),
          role: "paste",
        },
        {
          label: t.__("Paste and Match Style"),
          role: "pasteAndMatchStyle",
        },
        {
          label: t.__("Select All"),
          role: "selectAll",
        },
      ],
    },
  ];
}

function getOtherTpl(properties: MenuProperties): MenuItemConstructorOptions[] {
  const {tabs, activeTabIndex, enableMenu = false} = properties;
  return [
    {
      label: t.__("File"),
      submenu: [
        {
          type: "separator",
        },
        {
          label: t.__("Toggle Do Not Disturb"),
          accelerator: "Ctrl+Shift+M",
          click() {
            const dndUtil = DNDUtil.toggle();
            sendAction("toggle-dnd", dndUtil.dnd, dndUtil.newSettings);
          },
        },
        {
          label: t.__("Desktop Settings"),
          accelerator: "Ctrl+,",
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("open-settings");
            }
          },
        },
        {
          label: t.__("Keyboard Shortcuts"),
          accelerator: "Ctrl+Shift+K",
          enabled: enableMenu,
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("show-keyboard-shortcuts");
            }
          },
        },
        {
          type: "separator",
        },
        {
          label: t.__("Copy RM URL"),
          accelerator: "Ctrl+Shift+C",
          enabled: enableMenu,
          click(_item, focusedWindow) {
            if (focusedWindow) {
              sendAction("copy-rm-url");
            }
          },
        },
        {
          type: "separator",
        },
        {
          label: t.__("Minimize"),
          role: "minimize",
        },
        {
          label: t.__("Close"),
          role: "close",
        },
        {
          label: t.__("Quit"),
          role: "quit",
          accelerator: "Ctrl+Q",
        },
      ],
    },
    {
      label: t.__("Edit"),
      submenu: [
        {
          label: t.__("Undo"),
          role: "undo",
        },
        {
          label: t.__("Redo"),
          role: "redo",
        },
        {
          type: "separator",
        },
        {
          label: t.__("Cut"),
          role: "cut",
        },
        {
          label: t.__("Copy"),
          role: "copy",
        },
        {
          label: t.__("Paste"),
          role: "paste",
        },
        {
          label: t.__("Paste and Match Style"),
          role: "pasteAndMatchStyle",
        },
        {
          type: "separator",
        },
        {
          label: t.__("Select All"),
          role: "selectAll",
        },
      ],
    },
  ];
}

function sendAction<Channel extends keyof RendererMessage>(
  channel: Channel,
  ...arguments_: Parameters<RendererMessage[Channel]>
): void {
  const win = BrowserWindow.getAllWindows()[0];

  if (process.platform === "darwin") {
    win.restore();
  }

  send(win.webContents, channel, ...arguments_);
}

function getNextServer(tabs: TabData[], activeTabIndex: number): number {
  do {
    activeTabIndex = (activeTabIndex + 1) % tabs.length;
  } while (tabs[activeTabIndex]?.role !== "server");

  return activeTabIndex;
}

function getPreviousServer(tabs: TabData[], activeTabIndex: number): number {
  do {
    activeTabIndex = (activeTabIndex - 1 + tabs.length) % tabs.length;
  } while (tabs[activeTabIndex]?.role !== "server");

  return activeTabIndex;
}

export function setMenu(properties: MenuProperties): void {}
