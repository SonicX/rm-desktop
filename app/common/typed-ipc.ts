import type {DndSettings} from "./dnd-util.js";
import type {MenuProperties, ServerConfig} from "./types.js";
import type {JitsiOptions,  JitsiResult} from "../main/jitsi-manager";

export interface NativeSource {
    id: string | number;
    name?: string;
    type: string;
    appName?: string;
}

export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: { dataUrl: string };
}
export interface JitsiLogData {
  level: string;
  message: string;
}
export interface DesktopSourcesResponse {
  sources: DesktopSource[] | null;
  error: string | null;
  name: string | null;
}
export interface WalkieTalkieStatus {
  enabled: boolean;
  key: string;
}

export interface InvokeData {
  channel: string;
  args: unknown[];  // Tuple с rest для произвольных аргументов
  requestId: string;
}

export interface RemoteUpdateInfo {
    version: string;
    downloadUrl: string;
    releaseNotes?: string;
  }

export interface ZulipConnect {
  zulipFound: boolean;
  currentUserName: string;
  currentUserEmail: string;
  hasElectronBridge: boolean;
  hasIpcRenderer: boolean;
  totalWebContents: number;
  zulipUrl: string;
  error: string | null;
}

export type MainMessage = {
  "install-update": () => void;
  "reset-update-button": () => void;
  "preload-log": (message: string) => void;
  "clear-app-settings": () => void;
  "restart-app-test": () => void;
  "walkie-talkie-status": (data: { enabled: boolean; key: string }) => void;
  "configure-spell-checker": () => void;
  "fetch-user-agent": () => string;
  "focus-app": () => void;
  "focus-this-webview": () => void;
  "new-clipboard-key": () => {key: Uint8Array; sig: Uint8Array};
  "permission-callback": (permissionCallbackId: number, grant: boolean) => void;
  "quit-app": () => void; // Уже есть в MainMessage
  "realm-icon-changed": (serverURL: string, iconURL: string) => void;
  "realm-name-changed": (serverURL: string, realmName: string) => void;
  "reload-full-app": () => void;
  "save-last-tab": (index: number) => void;
  "switch-server-tab": (index: number) => void;
  "toggle-app": () => void;
  "toggle-badge-option": (newValue: boolean) => void;
  "toggle-menubar": (showMenubar: boolean) => void;
  "jitsi-log-event": (logData: JitsiLogData) => void;
  toggleAutoLauncher: (AutoLaunchValue: boolean) => void;
  "unread-count": (unreadCount: number) => void;
  "update-badge": (messageCount: number) => void;
  "update-menu": (properties: MenuProperties) => void;
  "update-taskbar-icon": (data: string, text: string) => void;
  "restart_app": () => void; // Для автообновления
  "jitsi-api-ready": (data: any) => void;
  "jitsi-conference-joined": () => void;
  "jitsi-conference-left": () => void;
  "electron-bridge-event": (data: any) => void;
  "ipc-invoke": (data: InvokeData) => void;
  "show-update-button": (updateInfo: RemoteUpdateInfo) => void;
  "start-update": (updateInfo: RemoteUpdateInfo) => void;
};

export type MainCall = {
  "get-app-version": () => string
  "handle-zulip-update": (updateInfo: RemoteUpdateInfo) => Promise<{ success: boolean; action?: string }>;
  "download-update": (updateInfo: RemoteUpdateInfo) => Promise<{ success: Boolean, action?: String  }>;
  "get-server-settings": (domain: string) => ServerConfig;
  "is-online": (url: string) => boolean;
  "poll-clipboard": (key: Uint8Array, sig: Uint8Array) => string | undefined;
  "save-server-icon": (iconURL: string) => string | null;
  'fetch-user-agent': () => Promise<string>;
  "get-desktop-sources": () => Promise<DesktopSource[]>;
  "jitsi-connect-with-zulip-config": (options: JitsiOptions) => Promise<JitsiResult>;
  "test-zulip-bridge": () => Promise<ZulipConnect>;
  "start-native-capture": (sourceId: string) => Promise<{ success: boolean; error?: string }>;
  "stop-native-capture": () => Promise<{ success: boolean; error?: string }>;
  "get-capture-status": () => void;
  "screen-capture-start": (options: { sourceId: string; width: number; height: number; frameRate: number; }) => Promise<{ success: boolean; error?: string; result: string }>;
  "screen-capture-stop": () => Promise<{ success: boolean; error?: string; }>;
  "screen-capture-test": () => Promise<{ success: boolean; error?: string; result: string }>;
  "create-jitsi-sdk-from-zulip": (data: JitsiOptions | {}) => Promise<{ success: boolean; error?: string; result: string }>;
};

export type RendererMessage = {
  back: () => void;
  "walkie-talkie-status": (status: WalkieTalkieStatus) => void;
  "desktop-sources-response": (response: DesktopSourcesResponse) => void;
  "trigger-open-desktop-picker": () => void;
  "requestDesktopSources": () => void;
  "forward-message": (channel: string) => void;
  "toggle-walkie-talkie": (isMuted: boolean ) => void;
  "copy-rm-url": () => void;
  destroytray: () => void;
  "enter-fullscreen": () => void;
  focus: () => void;
  "focus-webview-with-id": (webviewId: number) => void;
  forward: () => void;
  "hard-reload": () => void;
  "leave-fullscreen": () => void;
  "log-out": () => void;
  logout: () => void;
  "new-server": () => void;
  "open-about": () => void;
  "open-help": () => void;
  "open-network-settings": () => void;
  "open-org-tab": () => void;
  "open-settings": () => void;
  "permission-request": (
    options: {webContentsId: number | null; origin: string; permission: string},
    rendererCallbackId: number,
  ) => void;
  "play-ding-sound": () => void;
  "reload-current-viewer": () => void;
  "reload-proxy": (showAlert: boolean) => void;
  "reload-viewer": () => void;
  "render-taskbar-icon": (messageCount: number) => void;
  "set-active": () => void;
  "set-idle": () => void;
  "show-keyboard-shortcuts": () => void;
  "show-notification-settings": () => void;
  "switch-server-tab": (index: number) => void;
  "tab-devtools": () => void;
  "toggle-autohide-menubar": (
    autoHideMenubar: boolean,
    updateMenu: boolean,
  ) => void;
  "toggle-dnd": (state: boolean, newSettings: Partial<DndSettings>) => void;
  "toggle-sidebar": (show: boolean) => void;
  "toggle-silent": (state: boolean) => void;
  "toggle-tray": (state: boolean) => void;
  "toggletray": () => void;
  tray: (argument: number) => void;
  "update-realm-icon": (serverURL: string, iconURL: string) => void;
  "update-realm-name": (serverURL: string, realmName: string) => void;
  "webview-reload": () => void;
  zoomActualSize: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  "update_available": (version: string) => void;
  "update_progress": (percent: number) => void;
  "update_downloaded": () => void;
  "update_error": (message: string) => void;
  "quit-app": () => void;
  "create-native-stream-for-jitsi": () => void;
};