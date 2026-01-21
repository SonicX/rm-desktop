// Jitsi-sdk-manager.ts - Модуль для работы с Jitsi через SDK
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-floating-promises, @typescript-eslint/naming-convention, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unused-vars, @typescript-eslint/member-ordering, eqeqeq, @typescript-eslint/no-unsafe-call, no-promise-executor-return, @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, no-await-in-loop, @typescript-eslint/no-unsafe-return, import/no-extraneous-dependencies, @typescript-eslint/parameter-properties, no-eq-null */
import {BrowserWindow, ipcMain} from "electron/main"; // eslint-disable-line no-restricted-imports
import * as path from "node:path";

import log from "electron-log/main";
import Store from "electron-store";

import {ElectronSourcePicker} from "./electron-source-picker.js";

// Интерфейсы
type JitsiOptions = {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
  topic?: string;
  stream?: string;
  enableScreenPicker?: boolean;
  selectedSourceId?: string;
};

type JitsiSDKState = {
  window: BrowserWindow | null;
  isConnected: boolean;
  conferenceUrl: string | null;
};

const store = new Store();

export class JitsiSDKManager {
  private readonly closureFunction: (roomName: string) => void;

  private readonly state: JitsiSDKState = {
    window: null,
    isConnected: false,
    conferenceUrl: null,
  };

  private readonly iconPath: string;
  private currentRoomName = "";
  private readonly sourcePicker: ElectronSourcePicker;

  constructor(iconPath: string, closure: (roomName: string) => void) {
    this.closureFunction = closure;
    this.iconPath = iconPath;
    this.sourcePicker = new ElectronSourcePicker();

    this.initializeSDK();
    this.registerHandlers();

    log.info("[JITSI-SDK] Manager created");
  }

  private setupJitsiIPC(): void {
    if (!this.state.window) return;

    this.state.window.webContents.on(
      "ipc-message",
      async (event, channel, ...arguments_) => {
        log.info(`[JITSI-SDK] IPC message from Jitsi: ${channel}`);

        if (channel === "show-screen-picker") {
          await this.handleScreenPickerRequest();
        }
      },
    );
  }

  private async handleScreenPickerRequest(): Promise<void> {
    log.info("[JITSI-SDK] Handling screen picker request from Jitsi");

    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] No window available for picker");
      return;
    }

    try {
      const sources = await this.sourcePicker.getSources();
      log.info(`[JITSI-SDK] Got ${sources.length} sources for picker`);

      if (sources.length === 0) {
        log.warn("[JITSI-SDK] No sources available");

        await this.state.window.webContents.executeJavaScript(`
          window.pickerCancelled = true;
        `);
        return;
      }

      const selectedSource = await this.sourcePicker.showPicker(sources);

      if (selectedSource) {
        log.info(
          `[JITSI-SDK] User selected: ${selectedSource.name} (${selectedSource.id})`,
        );

        await this.state.window.webContents.executeJavaScript(`
          (function() {
            window.selectedSourceId = '${selectedSource.id}';
            console.log('[JITSI] Source selected:', window.selectedSourceId);
          })();
        `);
      } else {
        log.info("[JITSI-SDK] User cancelled screen selection");

        await this.state.window.webContents.executeJavaScript(`
          window.pickerCancelled = true;
        `);
      }
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error in screen picker: ${error.message}`);

      await this.state.window.webContents.executeJavaScript(`
        window.pickerCancelled = true;
      `);
    }
  }

  private initializeSDK(): void {
    try {
      const jitsiSDK = require("@jitsi/electron-sdk");

      if (jitsiSDK.setupAlwaysOnTopMain) {
        try {
          jitsiSDK.setupAlwaysOnTopMain();
          log.info("[JITSI-SDK] Always on top initialized");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup always on top: ${error.message}`,
          );
        }
      }

      if (jitsiSDK.setupPowerMonitorMain) {
        try {
          jitsiSDK.setupPowerMonitorMain();
          log.info("[JITSI-SDK] Power monitor initialized");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup power monitor: ${error.message}`,
          );
        }
      }

      log.info("[JITSI-SDK] SDK helper functions initialized");
    } catch (error: any) {
      log.warn(
        `[JITSI-SDK] SDK not available or failed to initialize: ${error.message}`,
      );
    }
  }

  private initializeSDKScreenSharing(): void {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      const jitsiSDK = require("@jitsi/electron-sdk");

      if (jitsiSDK.setupScreenSharingMain) {
        try {
          jitsiSDK.setupScreenSharingMain(this.state.window.webContents, {});
          log.info("[JITSI-SDK] Screen sharing initialized with window");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup screen sharing: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      log.warn(
        `[JITSI-SDK] Failed to initialize screen sharing: ${error.message}`,
      );
    }
  }

  private async injectAudioMuteIndicatorButton(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const BUTTON_ID = 'electron-audio-mute-indicator-btn';
          if (document.getElementById(BUTTON_ID)) return;

          const btn = document.createElement('button');
          btn.id = BUTTON_ID;
          btn.style.cssText = \`
            position: fixed;
            bottom: 16px;
            left: 20px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: white;
            border: 2px solid #000;
            font-size: 20px;
            color: black;
            cursor: pointer;
            z-index: 2147483646;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
            transition: all 0.2s ease;
          \`;

          function updateIcon(isMuted) {
            btn.textContent = isMuted ? '🔕' : '🔔';
          }

          // Получаем текущее состояние звука из Electron (через флаг)
          function getCurrentMutedState() {
            return window.electronAudioMuted ?? false;
          }

          updateIcon(getCurrentMutedState());

          btn.onclick = () => {
            const newMuted = !getCurrentMutedState();
            window.electronRequestAudioMute = newMuted;
            updateIcon(newMuted);
          };

          document.body.appendChild(btn);
          console.log('[ELECTRON-BTN] Audio mute indicator button injected');
        })();
      `);

      log.info("[JITSI-SDK] Audio mute indicator button injected");
    } catch (error: any) {
      log.error(
        `[JITSI-SDK] Failed to inject audio mute indicator button: ${error.message}`,
      );
    }
  }

  private startAudioMuteButtonPolling(): void {
    if (!this.state.window) return;

    const poll = async () => {
      if (!this.state.window || this.state.window.isDestroyed()) return;

      try {
        const muted = await this.state.window.webContents.executeJavaScript(`
          (window.electronRequestAudioMute !== undefined) ? window.electronRequestAudioMute : null
        `);

        if (typeof muted === "boolean") {
          await this.setLocalAudioMuted(muted);
          await this.state.window.webContents.executeJavaScript(`
            window.electronRequestAudioMute = undefined;
          `);
        }
      } catch {
        // Игнор
      }

      setTimeout(poll, 300);
    };

    poll();
  }

  private registerHandlers(): void {
    ipcMain.handle(
      "jitsi-sdk:create-window",
      async (event, options: JitsiOptions) => this.createWindow(options),
    );

    ipcMain.handle("focus_stream", (event, token: string) => {
      this.state.window?.show();
      this.state.window?.focus();
      this.state.window?.setAlwaysOnTop(true);
      this.state.window?.setAlwaysOnTop(false);
    });

    ipcMain.handle("jitsi-sdk:close", async () => this.closeWindow());

    ipcMain.handle("jitsi-sdk:get-status", async () => ({
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isConnected: this.state.isConnected,
    }));
  }

  async createWindow(
    options: JitsiOptions,
  ): Promise<{success: boolean; error?: string}> {
    try {
      const roomName = options.roomName.replaceAll(/[^\w-]/g, "");

      if (this.currentRoomName === roomName) {
        log.info(
          `[JITSI-SDK] Window already exists for room: ${roomName}, focusing existing window`,
        );
        this.state.window?.focus();
        return {success: false};
      }

      if (this.currentRoomName != "" && this.currentRoomName != roomName) {
        log.info(`[JITSI-SDK] Closing previous window for different room`);
        await this.closeWindow();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      this.currentRoomName = roomName;

      if (options.enableScreenPicker) {
        log.info(`[JITSI-SDK] Screen picker enabled, getting sources....`);

        try {
          const sources = await this.sourcePicker.getSources();
          log.info(
            `[JITSI-SDK] Got ${sources.length} sources for screen picker`,
          );

          if (sources.length === 0) {
            log.warn(`[JITSI-SDK] No sources available for screen sharing`);
          } else {
            for (const [i, s] of sources.slice(0, 3).entries()) {
              log.info(
                `[JITSI-SDK] Source ${i}: ${s.name} (${s.id}, type: ${s.type})`,
              );
            }

            log.info(`[JITSI-SDK] Opening picker dialog...`);
            const selectedSource = await this.sourcePicker.showPicker(sources);

            if (selectedSource) {
              log.info(
                `[JITSI-SDK] User selected source: ${selectedSource.name} (${selectedSource.id})`,
              );
              options.selectedSourceId = selectedSource.id;
            } else {
              log.info(
                `[JITSI-SDK] User cancelled screen selection or dialog closed`,
              );
            }
          }
        } catch (error: any) {
          log.error(`[JITSI-SDK] Error in screen picker: ${error.message}`);
        }
      }

      const server = options.serverUrl || "https://meet.jit.si";
      const displayName = options.displayName || "Guest";
      const topic = options.topic || "";
      const stream = options.stream || "";

      log.info(`[JITSI-SDK] Creating window for room: ${roomName}`);

      this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Трансляция: ${stream} - ${topic}`,
        icon: this.iconPath,
        center: true,
        show: false,
        backgroundColor: "#1a1a2e",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
          webSecurity: false,
          preload: this.getSDKPreloadPath(),
        },
      });

      this.setupWindowHandlers();
      this.initializeSDKScreenSharing();
      this.setupJitsiIPC();

      const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
      this.state.conferenceUrl = conferenceUrl;

      this.state.window.show();

      log.info(`[JITSI-SDK] Loading conference URL: ${conferenceUrl}`);

      await this.state.window.loadURL(conferenceUrl);
      await this.waitForConference();
      await this.injectConferenceHandlers();
      await this.injectAudioMuteIndicatorButton();
      this.startAudioMuteButtonPolling();

      log.info("[JITSI-SDK] Conference window created successfully");
      this.state.isConnected = true;

      return {success: true};
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to create window: ${error.message}`);

      this.currentRoomName = "";

      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.close();
        this.state.window = null;
      }

      return {success: false, error: error.message};
    }
  }

  async setLocalAudioMuted(muted: boolean): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot set audio muted - no window");
      return false;
    }

    try {
      this.state.window.webContents.setAudioMuted(muted);

      await this.state.window.webContents.executeJavaScript(`
      (function() {
        window.electronAudioMuted = ${muted};
        const btn = document.getElementById('electron-audio-mute-indicator-btn');
        if (btn) {
          btn.textContent = ${muted ? "'🔕'" : "'🔔'"};
        }
        console.log('[ELECTRON-AUDIO] Audio output ${muted ? "muted" : "unmuted"} via setLocalAudioMuted');
      })();
    `);

      log.info(`[JITSI-SDK] Audio output ${muted ? "muted" : "unmuted"}`);
      return true;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to mute audio: ${error.message}`);
      return false;
    }
  }

  async setLocalMicMuted(muted: boolean): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot set local audio input muted - no window");
      return false;
    }

    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (function(targetMuted) {
          try {
            if (window.APP?.conference?.toggleAudioMuted && typeof window.APP.conference.toggleAudioMuted === 'function') {
              const isCurrentlyMuted = window.APP.conference.isLocalAudioMuted?.();
              if (isCurrentlyMuted !== targetMuted) {
                console.log('[JITSI] Using toggleAudioMuted to ' + (targetMuted ? 'mute' : 'unmute'));
                window.APP.conference.toggleAudioMuted();
              }
              return true;
            }

            console.error('[JITSI] No method found to mute/unmute microphone');
            return false;
          } catch (e) {
            console.error('[JITSI] Error in set mic muted:', e);
            return false;
          }
        })(${muted});
      `);

      log.info(
        `[JITSI-SDK] Microphone ${muted ? "muted" : "unmuted"}: ${result}`,
      );
      return result;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to set microphone muted: ${error.message}`);
      return false;
    }
  }

  private getSDKPreloadPath(): string | undefined {
    try {
      const sdkPath = require.resolve("@jitsi/electron-sdk");
      const preloadPath = path.join(path.dirname(sdkPath), "preload.js");

      const fs = require("node:fs");
      if (fs.existsSync(preloadPath)) {
        log.info(`[JITSI-SDK] Found SDK preload at: ${preloadPath}`);
        return preloadPath;
      }
    } catch {
      // SDK preload не найден
    }

    return undefined;
  }

  private setupWindowHandlers(): void {
    if (!this.state.window) return;

    let closeHandled = false;

    // ВАЖНО: Обработчик close для корректного выхода из конференции
    this.state.window.on("close", async (event) => {
      if (closeHandled) {
        return;
      }

      closeHandled = true;

      event.preventDefault();

      log.info("[JITSI-SDK] Window close requested - performing cleanup");

      // Выполняем корректный выход из конференции
      await this.performConferenceCleanup();

      // Показываем экран закрытия
      await this.showClosingScreen();

      // Закрываем окно через небольшую задержку
      setTimeout(() => {
        this.closeWindow();
      }, 2000);
    });

    this.state.window.on("closed", () => {
      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;
    });

    this.state.window.on("page-title-updated", (event) => {
      event.preventDefault();
    });

    this.state.window.webContents.on(
      "page-title-updated",
      async (event, title) => {
        if (title === "__SHOW_CUSTOM_PICKER__") {
          event.preventDefault();
          log.info(`[JITSI-SDK] Custom picker requested via title change`);
          await this.handleScreenPickerRequest();
        }
      },
    );

    // Блокируем навигацию на главную страницу после выхода
    this.state.window.webContents.on("will-navigate", (event, url) => {
      log.info(`[JITSI-SDK] Navigation attempt to: ${url}`);

      // Если это попытка перейти на главную страницу после выхода - блокируем
      if (
        this.state.conferenceUrl &&
        !url.includes(this.currentRoomName || "")
      ) {
        log.info("[JITSI-SDK] Blocking navigation to different page");
        event.preventDefault();

        // Выполняем cleanup если еще не выполнен
        this.performConferenceCleanup();
        this.showPermanentClosingScreen();

        setTimeout(() => {
          this.closeWindow();
        }, 2000);
      }
    });

    this.state.window.webContents.on("dom-ready", () => {
      log.info("[JITSI-SDK] DOM ready");
      this.injectLoadingOverlay();
    });

    this.state.window.webContents.on("did-finish-load", () => {
      log.info("[JITSI-SDK] Page loaded");

      const micHotkey = store.get("currentMicHotkey", "");
      if (micHotkey != null && micHotkey != "") {
        this.setLocalMicMuted(true);
      }

      setTimeout(() => {
        this.hideLoadingOverlay();
      }, 1000);
    });

    this.state.window.webContents.on(
      "console-message",
      (event, level, message) => {
        if (message.includes("[JITSI]") || message.includes("conference")) {
          log.info(`Jitsi Console: ${message}`);
        }
      },
    );
  }

  // Новый метод для корректного выхода из конференции
  private async performConferenceCleanup(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      log.info("[JITSI-SDK] Performing conference cleanup");

      await this.state.window.webContents.executeJavaScript(`
        (async function() {
          console.log('[JITSI] Starting conference cleanup');
          
          try {
            // Попытка 1: Через API конференции
            if (window.APP && window.APP.conference) {
              console.log('[JITSI] Found APP.conference, attempting cleanup');
              
              // Отключаем все медиа-треки
              if (window.APP.conference.getLocalTracks) {
                const localTracks = window.APP.conference.getLocalTracks();
                console.log('[JITSI] Stopping ' + localTracks.length + ' local tracks');
                for (const track of localTracks) {
                  try {
                    await track.dispose();
                  } catch(e) {
                    console.error('[JITSI] Error disposing track:', e);
                  }
                }
              }
              
              // Выходим из конференции
              if (window.APP.conference.room) {
                console.log('[JITSI] Leaving room');
                try {
                  await window.APP.conference.room.leave();
                } catch(e) {
                  console.error('[JITSI] Error leaving room:', e);
                }
              }
              
              // Вызываем hangup
              if (window.APP.conference.hangup) {
                console.log('[JITSI] Calling hangup');
                try {
                  await window.APP.conference.hangup();
                } catch(e) {
                  console.error('[JITSI] Error in hangup:', e);
                }
              }
            }
            
            // Попытка 2: Через JitsiMeetExternalAPI если доступен
            if (window.JitsiMeetExternalAPI && window.api) {
              console.log('[JITSI] Found JitsiMeetExternalAPI, disposing');
              try {
                window.api.dispose();
              } catch(e) {
                console.error('[JITSI] Error disposing API:', e);
              }
            }
            
            // Попытка 3: Через глобальный объект JitsiConference
            if (window.JitsiConference) {
              console.log('[JITSI] Found JitsiConference, attempting leave');
              try {
                if (window.JitsiConference.leave) {
                  await window.JitsiConference.leave();
                }
              } catch(e) {
                console.error('[JITSI] Error leaving via JitsiConference:', e);
              }
            }
            
            // Останавливаем все медиа-потоки
            if (navigator.mediaDevices) {
              const streams = await navigator.mediaDevices.enumerateDevices();
              console.log('[JITSI] Stopping all media streams');
              
              // Получаем все активные потоки через getUserMedia
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: false });
                stream.getTracks().forEach(track => {
                  track.stop();
                });
              } catch(e) {
                // Игнорируем ошибки
              }
            }
            
            console.log('[JITSI] Cleanup completed');
            
          } catch(error) {
            console.error('[JITSI] Error during cleanup:', error);
          }
          
          return true;
        })();
      `);

      // Даем время на завершение cleanup
      await new Promise((resolve) => setTimeout(resolve, 500));

      log.info("[JITSI-SDK] Conference cleanup completed");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to perform cleanup: ${error.message}`);
    }
  }

  private async showPermanentClosingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('electron-permanent-closing')) return;
          
          document.body.innerHTML = '';
          
          const overlay = document.createElement('div');
          overlay.id = 'electron-permanent-closing';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647;';
          
          overlay.innerHTML = \`
            <div style="text-align:center;">
              <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;">
                <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>
              <div style="color:#ffffff;font-size:20px;font-weight:500;margin-bottom:15px;">Завершение конференции</div>
              <div style="color:rgba(255,255,255,0.7);font-size:16px;">Спасибо за участие</div>
            </div>
          \`;
          
          document.body.appendChild(overlay);
          
          const blockAll = function(e) {
            e.stopImmediatePropagation();
            e.preventDefault();
            return false;
          };
          
          window.addEventListener('beforeunload', blockAll, true);
          window.addEventListener('unload', blockAll, true);
          document.addEventListener('DOMContentLoaded', blockAll, true);
          
          window.location.href = '#';
          window.location.replace = function() {};
          window.location.assign = function() {};
          window.location.reload = function() {};
          history.pushState = function() {};
          history.replaceState = function() {};
          history.back = function() {};
          history.forward = function() {};
          history.go = function() {};
        })();
      `);

      log.info("[JITSI-SDK] Permanent closing screen shown");
    } catch (error: any) {
      log.error(
        `[JITSI-SDK] Failed to show permanent closing screen: ${error.message}`,
      );
    }
  }

  private buildConferenceUrl(
    server: string,
    roomName: string,
    options: JitsiOptions,
  ): string {
    let url = `${server}/${roomName}`;

    const queryParameters = new URLSearchParams();
    if (options.jwt) {
      queryParameters.append("jwt", options.jwt);
    }

    if (queryParameters.toString()) {
      url += "?" + queryParameters.toString();
    }

    const hashParameters = new URLSearchParams();

    hashParameters.append("config.disableDeepLinking", "true");
    hashParameters.append("config.prejoinPageEnabled", "false");
    hashParameters.append("config.startWithAudioMuted", "false");
    hashParameters.append("config.startWithVideoMuted", "true");
    hashParameters.append("config.enableWelcomePage", "false");
    hashParameters.append("config.enableClosePage", "false");

    hashParameters.append("config.resolution", "720");
    hashParameters.append("config.disableInitialGUM", "false");
    hashParameters.append("config.enableLayerSuspension", "true");

    hashParameters.append("config.p2p.enabled", "true");
    hashParameters.append("config.p2p.preferH264", "true");

    hashParameters.append("interfaceConfig.SHOW_JITSI_WATERMARK", "false");
    hashParameters.append("interfaceConfig.SHOW_WATERMARK_FOR_GUESTS", "false");
    hashParameters.append("interfaceConfig.SHOW_BRAND_WATERMARK", "false");
    hashParameters.append("interfaceConfig.HIDE_INVITE_MORE_HEADER", "true");
    hashParameters.append("interfaceConfig.MOBILE_APP_PROMO", "false");

    hashParameters.append("interfaceConfig.SHOW_MEETING_NAME", "false");
    hashParameters.append(
      "interfaceConfig.DISPLAY_WELCOME_PAGE_CONTENT",
      "false",
    );
    hashParameters.append(
      "interfaceConfig.APP_NAME",
      options.topic || "Конференция",
    );
    hashParameters.append(
      "interfaceConfig.NATIVE_APP_NAME",
      options.topic || "Конференция",
    );

    hashParameters.append("config.requireDisplayName", "false");
    hashParameters.append("config.hideConferenceSubject", "true");
    hashParameters.append("config.hideConferenceTimer", "false");
    hashParameters.append("config.hideDominantSpeakerBadge", "false");

    // Отключаем отображение темы
    hashParameters.append("interfaceConfig.SHOW_CONFERENCE_SUBJECT", "false");
    hashParameters.append("interfaceConfig.HIDE_CONFERENCE_SUBJECT", "true");

    // Пустая тема вместо названия комнаты
    hashParameters.append("config.subject", " "); // Пробел вместо пустой строки

    const toolbarButtons = [
      "camera",
      "desktop",
      "microphone",
      "participants",
      "settings",
      "fullscreen",
      "hangup",
    ];
    hashParameters.append(
      "interfaceConfig.TOOLBAR_BUTTONS",
      JSON.stringify(toolbarButtons),
    );

    if (options.displayName) {
      hashParameters.append("userInfo.displayName", options.displayName);
    }

    if (options.email) {
      hashParameters.append("userInfo.email", options.email);
    }

    if (options.topic) {
      hashParameters.append("config.subject", options.topic);
    }

    if (options.avatarUrl) {
      hashParameters.append("userInfo.avatarURL", options.avatarUrl);
      hashParameters.append("config.gravatar.disabled", "true");
    }

    if (hashParameters.toString()) {
      url += "#" + hashParameters.toString();
    }

    return url;
  }

  private async waitForConference(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    const maxAttempts = 30;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const isReady = await this.state.window.webContents.executeJavaScript(`
          (function() {
            if (window.APP && window.APP.conference) {
              return true;
            }
            if (window.JitsiMeetJS) {
              return true;
            }
            return document.readyState === 'complete';
          })();
        `);

        if (isReady) {
          log.info("[JITSI-SDK] Conference ready");
          return;
        }
      } catch {
        // Игнорируем ошибки
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    log.warn("[JITSI-SDK] Conference ready timeout - proceeding anyway");
  }

  private async injectLoadingOverlay(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('electron-loading-overlay')) return;
          
          const overlay = document.createElement('div');
          overlay.id = 'electron-loading-overlay';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:999999;';
          
          overlay.innerHTML = \`
            <style>
              @keyframes spin { to { transform: rotate(360deg); } }
              @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
            </style>
            <div style="text-align:center;">
              <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;animation:pulse 2s ease-in-out infinite;">
                <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>
              <div style="color:#ffffff;font-size:18px;font-weight:500;margin-bottom:20px;">Подключаемся к конференции</div>
              <div style="width:50px;height:50px;margin:0 auto;border:3px solid rgba(255,255,255,0.1);border-top-color:#667eea;border-radius:50%;animation:spin 1s linear infinite;"></div>
            </div>
          \`;
          
          document.body.appendChild(overlay);
        })();
      `);

      log.info("[JITSI-SDK] Loading overlay shown");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to show loading overlay: ${error.message}`);
    }
  }

  private async hideLoadingOverlay(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const overlay = document.getElementById('electron-loading-overlay');
          if (overlay) {
            overlay.style.transition = 'opacity 0.3s ease-out';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 300);
          }
        })();
      `);

      log.info("[JITSI-SDK] Loading overlay hidden");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to hide overlay: ${error.message}`);
    }
  }

  private async showClosingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('electron-closing-overlay');
          if (existing) return;
          
          const overlay = document.createElement('div');
          overlay.id = 'electron-closing-overlay';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647;opacity:0;transition:opacity 0.3s;';
          
          overlay.innerHTML = \`
            <div style="text-align:center;">
              <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;">
                <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>
              <div style="color:#ffffff;font-size:20px;font-weight:500;margin-bottom:15px;">Завершение конференции</div>
              <div style="color:rgba(255,255,255,0.7);font-size:16px;">Спасибо за участие</div>
            </div>
          \`;
          
          document.body.appendChild(overlay);
          setTimeout(() => { overlay.style.opacity = '1'; }, 50);
          
          const others = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
          others.forEach(el => { el.style.display = 'none'; });
        })();
      `);

      log.info("[JITSI-SDK] Closing screen shown");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to show closing screen: ${error.message}`);
    }
  }

  private async injectConferenceHandlers(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          console.log('[JITSI] Setting up conference handlers...');
          
          // Перехват screen picker для Jitsi
          const waitForScreenObtainer = setInterval(() => {
            if (window.JitsiMeetScreenObtainer) {
              clearInterval(waitForScreenObtainer);
              
              console.log('[JITSI] Found JitsiMeetScreenObtainer, overriding openDesktopPicker');
              
              window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, onSourceChoose) {
                console.log('[JITSI] openDesktopPicker intercepted, showing custom picker');
                
                const originalTitle = document.title;
                document.title = '__SHOW_CUSTOM_PICKER__';
                
                window.desktopPickerCallback = onSourceChoose;
                
                setTimeout(() => {
                  document.title = originalTitle;
                }, 100);
                
                const checkForSelection = setInterval(() => {
                  if (window.selectedSourceId) {
                    clearInterval(checkForSelection);
                    
                    const sourceId = window.selectedSourceId;
                    window.selectedSourceId = null;
                    
                    console.log('[JITSI] Source selected:', sourceId);
                    
                    if (window.desktopPickerCallback) {
                      window.desktopPickerCallback(sourceId, 'desktop');
                      window.desktopPickerCallback = null;
                    }
                  }
                  
                  if (window.pickerCancelled) {
                    clearInterval(checkForSelection);
                    window.pickerCancelled = false;
                    
                    console.log('[JITSI] Picker cancelled');
                    
                    if (window.desktopPickerCallback) {
                      window.desktopPickerCallback(null);
                      window.desktopPickerCallback = null;
                    }
                  }
                }, 100);
                
                setTimeout(() => {
                  clearInterval(checkForSelection);
                  if (window.desktopPickerCallback) {
                    window.desktopPickerCallback(null);
                    window.desktopPickerCallback = null;
                  }
                }, 30000);
              };
              
              window.JitsiMeetScreenObtainer.isSupported = function() {
                return true;
              };
            }
          }, 100);
          
          setTimeout(() => clearInterval(waitForScreenObtainer), 5000);
          
          // Перехват кнопки выхода для корректного cleanup
          let isClosing = false;
          
          function showClosingAndExit() {
            if (isClosing) return;
            isClosing = true;
            
            console.log('[JITSI] Initiating conference close');
            
            // Сигнализируем Electron о необходимости cleanup
            window.close();
          }
          
          // Перехватываем клики на кнопку выхода
          document.addEventListener('click', function(e) {
            const target = e.target;
            if (target && (
              target.classList.contains('hangup-button') ||
              target.closest('[data-testid="toolbar-button-hangup"]') ||
              target.closest('[aria-label*="Leave"]') ||
              target.closest('[aria-label*="Hangup"]') ||
              target.closest('[aria-label*="Покинуть"]') ||
              target.closest('[aria-label*="Завершить"]') ||
              target.closest('.toolbox-button-hangup')
            )) {
              console.log('[JITSI] Hangup button clicked');
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              
              showClosingAndExit();
              return false;
            }
          }, true);
          
          console.log('[JITSI] Conference handlers installed');
        })();
      `);

      log.info("[JITSI-SDK] Conference handlers injected");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject handlers: ${error.message}`);
    }
  }

  async closeWindow(): Promise<void> {
    if (this.currentRoomName != "") {
      this.closureFunction(this.currentRoomName);
      this.currentRoomName = "";
    }

    if (!this.state.window || this.state.window.isDestroyed()) {
      log.info("[JITSI-SDK] Window already closed");
      return;
    }

    log.info("[JITSI-SDK] Closing conference window");

    try {
      // Выполняем cleanup перед закрытием
      await this.performConferenceCleanup();

      const windowToClose = this.state.window;

      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;

      windowToClose.webContents?.removeAllListeners();
      windowToClose.removeAllListeners();
      windowToClose.destroy();

      log.info("[JITSI-SDK] Window closed successfully");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error closing window: ${error.message}`);

      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.destroy();
      }

      this.state.window = null;
      this.state.isConnected = false;
      this.currentRoomName = "";
    }
  }

  async getStatus(): Promise<any> {
    return {
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isConnected: this.state.isConnected,
      conferenceUrl: this.state.conferenceUrl,
    };
  }

  async startScreenShare(sourceId?: string): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot start screen share - no window");
      return false;
    }

    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (function() {
          try {
            const desktopButton = document.querySelector('[aria-label*="desktop"], [aria-label*="screen"], [data-testid*="desktop"], .toolbox-button-desktop');
            if (desktopButton) {
              desktopButton.click();
              console.log('[JITSI-SDK] Screen share button clicked');
              return true;
            }
            
            if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
              window.APP.conference.toggleScreenSharing();
              console.log('[JITSI-SDK] Screen sharing toggled via API');
              return true;
            }
            
            return false;
          } catch (error) {
            console.error('[JITSI-SDK] Error starting screen share:', error);
            return false;
          }
        })();
      `);

      log.info(`[JITSI-SDK] Screen share start result: ${result}`);
      return result;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to start screen share: ${error.message}`);
      return false;
    }
  }
}

export default JitsiSDKManager;
