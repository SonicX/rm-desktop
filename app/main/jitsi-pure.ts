// Jitsi-pure.ts - Оптимизированный модуль для Jitsi
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/member-ordering, @typescript-eslint/no-floating-promises, @typescript-eslint/use-unknown-in-catch-callback-variable, @typescript-eslint/no-unused-vars, @typescript-eslint/parameter-properties, promise/param-names, no-promise-executor-return, @typescript-eslint/only-throw-error, no-await-in-loop */
import {BrowserWindow, desktopCapturer, ipcMain} from "electron/main"; // eslint-disable-line no-restricted-imports
import * as path from "node:path";

import log from "electron-log/main";

type JitsiOptions = {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
  topic?: string;
  stream?: string;
};

type JitsiPureState = {
  window: BrowserWindow | null;
  isSharing: boolean;
  conferenceUrl: string | null;
};

export class JitsiPureManager {
  private readonly state: JitsiPureState = {
    window: null,
    isSharing: false,
    conferenceUrl: null,
  };

  private readonly bundlePath: string;
  private readonly iconPath: string;
  private sessionCounter = 0;

  constructor(bundlePath: string, iconPath: string) {
    this.bundlePath = bundlePath;
    this.iconPath = iconPath;

    this.registerHandlers();

    // Регистрируем обработчик демонстрации экрана ОДИН РАЗ при создании менеджера
    if (!ipcMain.eventNames().includes("jitsi-screen-sharing-get-sources")) {
      ipcMain.handle("jitsi-screen-sharing-get-sources", async () => {
        const sources = await desktopCapturer.getSources({
          types: ["window", "screen"],
          thumbnailSize: {width: 300, height: 200},
        });

        return sources.map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL(),
        }));
      });
      log.info("[JITSI-SDK] Screen sharing handler registered in constructor");
    }

    log.info("[JITSI-SDK] Manager initialized with official SDK");
  }

  private registerHandlers(): void {
    // Создание окна
    ipcMain.handle(
      "jitsi-pure:create-window",
      async (event, options: JitsiOptions) => this.createWindow(options),
    );

    // Закрытие окна
    ipcMain.handle("jitsi-pure:close", async () => this.closeWindow());

    // Получение статуса
    ipcMain.handle("jitsi-pure:get-status", async () => ({
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isSharing: this.state.isSharing,
    }));
  }

  async createWindow(
    options: JitsiOptions,
  ): Promise<{success: boolean; error?: string}> {
    try {
      // Закрываем предыдущее окно если есть
      await this.closeWindow();
      // Убираем лишнюю задержку
      // await new Promise(resolve => setTimeout(resolve, 500));

      const server = options.serverUrl || "https://meet.jit.si";
      const roomName = options.roomName.replaceAll(/[^\w-]/g, "");
      const displayName = options.displayName || "Guest";
      const topic = options.topic || "";
      const stream = options.stream || "";

      log.info(`[JITSI-SDK] Creating window: ${server}/${roomName}`);

      // Уникальный partition для каждой сессии
      this.sessionCounter++;
      const uniquePartition = `persist:jitsi-session-${this.sessionCounter}-${Date.now()}`;

      // Создаем окно с настройками для SDK
      this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Трансляция: ${stream} - ${topic}`,
        icon: this.iconPath,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
          webSecurity: false,
          partition: uniquePartition,
        },
        backgroundColor: "#1a1a2e",
        show: false,
        center: true,
      });

      // Предотвращаем изменение заголовка
      this.state.window.on("page-title-updated", (event) => {
        event.preventDefault();
      });

      // Формируем URL с параметрами
      const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
      this.state.conferenceUrl = conferenceUrl;

      // Флаги состояния
      let isSuccessfullyLoaded = false;
      let hasError = false;
      let configInjected = false;

      // Блокируем новые окна
      this.state.window.webContents.setWindowOpenHandler(() => ({
        action: "deny",
      }));

      // Обработчик навигации
      this.state.window.webContents.on("will-navigate", (event, url) => {
        log.info(`[JITSI-SDK] Navigation attempt to: ${url}`);

        if (this.state.conferenceUrl && !url.includes(roomName)) {
          log.info("[JITSI-SDK] Leaving conference detected");
          event.preventDefault();
          this.closeWindow();
        }
      });

      // ОПТИМИЗАЦИЯ: Инъектируем конфигурацию только ОДИН РАЗ в dom-ready
      this.state.window.webContents.on("dom-ready", async () => {
        if (!configInjected) {
          configInjected = true;

          // Сначала инъектируем оверлей
          await this.injectLoadingOverlay();

          // Затем конфигурацию пользователя (если есть)
          if (options.displayName || options.email || options.avatarUrl) {
            await this.injectUserConfig(options);
          }

          // И обработчики конференции
          await this.injectConferenceHandlers();
        }
      });

      // Обработчик успешной загрузки
      this.state.window.webContents.on("did-finish-load", async () => {
        if (!this.state.window || this.state.window.isDestroyed()) return;

        const currentUrl = this.state.window.webContents.getURL();
        log.info(`[JITSI-SDK] Page loaded: ${currentUrl}`);

        isSuccessfullyLoaded = true;

        // ОПТИМИЗАЦИЯ: Убираем лишнюю задержку
        // await new Promise(resolve => setTimeout(resolve, 500));

        // Ждем готовности и скрываем загрузчик
        await this.waitForJitsiAndHideLoader();
      });

      // Обработчик ошибок
      this.state.window.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (!isMainFrame || isSuccessfullyLoaded) return;
          hasError = true;
          log.error(
            `[JITSI-SDK] Load failed: ${errorDescription} (${errorCode})`,
          );
        },
      );

      // Обработчик закрытия
      this.state.window.on("close", async (event) => {
        event.preventDefault();
        log.info("[JITSI-SDK] Window close requested");
        await this.closeWindow();
      });

      this.state.window.on("closed", () => {
        this.state.window = null;
        this.state.conferenceUrl = null;
      });

      // Консоль для отладки
      this.state.window.webContents.on(
        "console-message",
        (event, level, message) => {
          if (
            message.includes("[JITSI-SDK]") ||
            message.includes("CONFERENCE")
          ) {
            log.info(`Jitsi Console: ${message}`);
          }
        },
      );

      // Показываем окно
      this.state.window.show();

      log.info(`[JITSI-SDK] Loading URL: ${conferenceUrl}`);

      // Загружаем с таймаутом
      try {
        const loadPromise = this.state.window.loadURL(conferenceUrl);
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => {
            reject(new Error("Timeout loading conference"));
          }, 30_000),
        );

        await Promise.race([loadPromise, timeoutPromise]);

        // ОПТИМИЗАЦИЯ: Уменьшаем задержку
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (hasError && !isSuccessfullyLoaded) {
          throw new Error("Failed to load conference page");
        }

        if (!this.state.window || this.state.window.isDestroyed()) {
          throw new Error("Window was closed during loading");
        }

        log.info("[JITSI-SDK] Conference loaded successfully");
        return {success: true};
      } catch (loadError: any) {
        log.error(`[JITSI-SDK] Load error: ${loadError.message}`);
        throw loadError;
      }
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to create window: ${error.message}`);

      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.close();
        this.state.window = null;
      }

      return {success: false, error: error.message};
    }
  }

  // Новый метод для инъекции конфигурации пользователя
  private async injectUserConfig(options: JitsiOptions) {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          // Переопределяем config до того как Jitsi его прочитает
          if (!window.config) window.config = {};
          if (!window.interfaceConfig) window.interfaceConfig = {};
          
          // Устанавливаем данные пользователя
          ${
            options.displayName
              ? `
            window.config.displayName = '${options.displayName}';
            // Сохраняем для последующего использования
            window._jitsiUserDisplayName = '${options.displayName}';
          `
              : ""
          }
          ${
            options.email
              ? `
            window.config.email = '${options.email}';
            window._jitsiUserEmail = '${options.email}';
          `
              : ""
          }
          ${
            options.avatarUrl
              ? `
            window.config.avatarURL = '${options.avatarUrl}';
            window.interfaceConfig.DEFAULT_LOCAL_AVATAR_URL = '${options.avatarUrl}';
            window.config.gravatar = { disabled: true };
            window._jitsiUserAvatar = '${options.avatarUrl}';
          `
              : ""
          }
          
          // Отключаем prejoin чтобы не было двойного подключения
          window.config.prejoinPageEnabled = false;
          window.config.prejoinConfig = { enabled: false };
          
          // Дополнительные настройки для быстрого подключения
          window.config.enableWelcomePage = false;
          window.config.enableClosePage = false;
          window.config.disableInitialGUM = false;
          window.config.resolution = 720;
          
          console.log('[JITSI-SDK] User config injected before Jitsi init');
        })();
      `);

      log.info("[JITSI-SDK] User config injected");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject user config: ${error.message}`);
    }
  }

  private buildConferenceUrl(
    server: string,
    roomName: string,
    options: JitsiOptions,
  ): string {
    let url = `${server}/${roomName}`;

    // Query параметры (JWT)
    const queryParameters = new URLSearchParams();
    if (options.jwt) {
      queryParameters.append("jwt", options.jwt);
    }

    if (queryParameters.toString()) {
      url += "?" + queryParameters.toString();
    }

    // Hash параметры для конфигурации
    const hashParameters = new URLSearchParams();

    // Базовые настройки
    hashParameters.append("config.disableDeepLinking", "true");
    hashParameters.append("config.prejoinPageEnabled", "false");
    hashParameters.append("config.startWithAudioMuted", "false");
    hashParameters.append("config.startWithVideoMuted", "true");

    // UI настройки
    hashParameters.append("interfaceConfig.SHOW_JITSI_WATERMARK", "false");
    hashParameters.append("interfaceConfig.SHOW_WATERMARK_FOR_GUESTS", "false");

    // Кнопки тулбара
    const toolbarButtons = [
      "camera",
      "desktop",
      "microphone",
      "settings",
      "fullscreen",
      "hangup",
    ];
    hashParameters.append(
      "interfaceConfig.TOOLBAR_BUTTONS",
      JSON.stringify(toolbarButtons),
    );

    // Информация о пользователе через hash (дублирование для надежности)
    if (options.displayName) {
      hashParameters.append("userInfo.displayName", options.displayName);
    }

    if (options.email) {
      hashParameters.append("userInfo.email", options.email);
    }

    if (options.avatarUrl) {
      hashParameters.append("userInfo.avatarURL", options.avatarUrl);
    }

    if (hashParameters.toString()) {
      url += "#" + hashParameters.toString();
    }

    return url;
  }

  private async injectLoadingOverlay() {
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
              @keyframes electronSpin {
                to { transform: rotate(360deg); }
              }
              @keyframes electronPulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
              }
              @keyframes electronFadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
              }
            </style>
            <div style="text-align:center;animation:electronFadeIn 0.5s ease-in;">
              <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;animation:electronPulse 2s ease-in-out infinite;">
                <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>
              <div style="color:#ffffff;font-size:18px;font-weight:500;margin-bottom:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                Подключаемся к конференции
              </div>
              <div style="width:50px;height:50px;margin:0 auto;border:3px solid rgba(255,255,255,0.1);border-top-color:#667eea;border-radius:50%;animation:electronSpin 1s linear infinite;"></div>
            </div>
          \`;
          
          document.body.appendChild(overlay);
        })();
      `);

      log.info("[JITSI-SDK] Loading overlay injected");
    } catch (error: any) {
      log.error(
        `[JITSI-SDK] Failed to inject loading overlay: ${error.message}`,
      );
    }
  }

  private async waitForJitsiAndHideLoader() {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.waitForJitsiReady();

      // ОПТИМИЗАЦИЯ: Уменьшаем дополнительную задержку
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Плавно скрываем загрузчик
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

      // После скрытия загрузчика устанавливаем аватар если нужно
      if (this.state.window && !this.state.window.isDestroyed()) {
        await this.ensureUserSettings();
      }
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to hide loader: ${error.message}`);
    }
  }

  private async waitForJitsiReady(): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) return false;

    const maxAttempts = 20; // Уменьшаем количество попыток
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const isReady = await this.state.window.webContents.executeJavaScript(`
          (function() {
            // Проверяем готовность Jitsi API и конференции
            const hasApp = !!window.APP;
            const hasConference = hasApp && !!window.APP.conference;
            const hasStore = hasApp && !!window.APP.store;
            
            if (hasStore) {
              const state = window.APP.store.getState();
              const hasParticipants = state && state['features/base/participants'];
              const hasLocalParticipant = hasParticipants && hasParticipants.local;
              
              // Считаем готовым когда есть локальный участник
              return hasLocalParticipant;
            }
            
            return false;
          })();
        `);

        if (isReady) {
          log.info("[JITSI-SDK] Jitsi is ready");
          return true;
        }
      } catch {
        // Игнорируем ошибки
      }

      await new Promise((resolve) => setTimeout(resolve, 150)); // Проверяем чаще
      attempts++;
    }

    log.warn("[JITSI-SDK] Jitsi ready timeout");
    return false;
  }

  // Новый метод для установки пользовательских настроек после инициализации
  private async ensureUserSettings() {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          if (!window.APP || !window.APP.store) return;
          
          const state = window.APP.store.getState();
          const participants = state['features/base/participants'];
          
          if (participants && participants.local) {
            const localId = participants.local.id;
            
            // Устанавливаем аватар если он был задан
            if (window._jitsiUserAvatar) {
              const currentAvatar = participants.local.avatarURL;
              if (currentAvatar !== window._jitsiUserAvatar) {
                window.APP.store.dispatch({
                  type: 'SET_LOADABLE_AVATAR_URL',
                  participant: {
                    id: localId,
                    loadableAvatarUrl: window._jitsiUserAvatar
                  }
                });
                console.log('[JITSI-SDK] Avatar set for participant');
              }
            }
            
            // Устанавливаем имя если нужно
            if (window._jitsiUserDisplayName && participants.local.name !== window._jitsiUserDisplayName) {
              window.APP.store.dispatch({
                type: 'SET_DISPLAY_NAME',
                displayName: window._jitsiUserDisplayName,
                id: localId
              });
              console.log('[JITSI-SDK] Display name set');
            }
          }
        })();
      `);

      log.info("[JITSI-SDK] User settings ensured");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to ensure user settings: ${error.message}`);
    }
  }

  private async injectConferenceHandlers() {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          console.log('[JITSI-SDK] Setting up conference handlers...');
          
          // Функция для показа экрана закрытия
          function showClosingScreen() {
            const existingOverlay = document.getElementById('electron-closing-overlay');
            if (existingOverlay) return;
            
            const closingOverlay = document.createElement('div');
            closingOverlay.id = 'electron-closing-overlay';
            closingOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647;opacity:0;transition:opacity 0.3s ease-in;pointer-events:all;';
            
            closingOverlay.innerHTML = \`
              <style>
                @keyframes electronFadeIn {
                  from { opacity: 0; transform: scale(0.9); }
                  to { opacity: 1; transform: scale(1); }
                }
                @keyframes electronPulse {
                  0%, 100% { transform: scale(1); }
                  50% { transform: scale(1.05); }
                }
              </style>
              <div style="text-align:center;animation:electronFadeIn 0.5s ease-out;">
                <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;animation:electronPulse 2s ease-in-out infinite;">
                  <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                  </svg>
                </div>
                <div style="color:#ffffff;font-size:20px;font-weight:500;margin-bottom:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                  Завершение конференции
                </div>
                <div style="color:rgba(255,255,255,0.7);font-size:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                  Спасибо за участие
                </div>
              </div>
            \`;
            
            document.body.appendChild(closingOverlay);
            setTimeout(() => {
              closingOverlay.style.opacity = '1';
            }, 50);
            
            // Скрываем всё содержимое Jitsi немедленно
            const allElements = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
            allElements.forEach(el => {
              el.style.display = 'none';
            });
            
            // Блокируем навигацию
            window.addEventListener('beforeunload', function(e) {
              e.preventDefault();
              e.returnValue = '';
            });
          }
          
          // Глобальный флаг для предотвращения множественных закрытий
          window.electronClosing = false;
          
          // Перехватываем клики на кнопку выхода
          document.addEventListener('click', function(e) {
            const target = e.target;
            
            // Проверяем, является ли это кнопкой выхода
            if (target && (
              target.classList.contains('hangup-button') ||
              target.closest('[data-testid="toolbar-button-hangup"]') ||
              target.closest('[aria-label*="Leave"]') ||
              target.closest('[aria-label*="Hangup"]') ||
              target.closest('[aria-label*="Покинуть"]') ||
              target.closest('.toolbox-button-hangup')
            )) {
              console.log('[JITSI-SDK] Hangup button clicked, showing closing screen');
              
              if (!window.electronClosing) {
                window.electronClosing = true;
                
                // Показываем экран закрытия
                showClosingScreen();
                
                // Закрываем окно через задержку
                setTimeout(() => {
                  window.close();
                }, 2000);
              }
            }
          }, true);
          
          // Ждем готовности APP
          const checkInterval = setInterval(() => {
            if (window.APP && window.APP.store && window.APP.conference) {
              clearInterval(checkInterval);
              
              // Перехватываем функцию hangup
              const originalHangup = window.APP.conference.hangup;
              if (originalHangup) {
                window.APP.conference.hangup = function(...args) {
                  console.log('[JITSI-SDK] Hangup function called');
                  
                  if (!window.electronClosing) {
                    window.electronClosing = true;
                    
                    // Вызываем оригинальный hangup и ждем его завершения
                    const result = originalHangup.apply(this, args);
                    
                    // Ждем немного для завершения процесса выхода
                    setTimeout(() => {
                      showClosingScreen();
                      // Закрываем окно только после полного выхода
                      setTimeout(() => window.close(), 1500);
                    }, 1000);
                    
                    return result;
                  }
                  
                  return originalHangup.apply(this, args);
                };
              }
              
              console.log('[JITSI-SDK] Conference handlers installed');
            }
          }, 500);
          
          setTimeout(() => clearInterval(checkInterval), 15000);
        })();
      `);

      log.info("[JITSI-SDK] Conference handlers injected");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject handlers: ${error.message}`);
    }
  }

  async closeWindow(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.info("[JITSI-SDK] Window already closed");
      return;
    }

    log.info("[JITSI-SDK] Closing conference window");

    try {
      // Сохраняем ссылку на окно локально
      const windowToClose = this.state.window;

      // Сразу обнуляем state чтобы избежать повторных вызовов
      this.state.window = null;
      this.state.isSharing = false;
      this.state.conferenceUrl = null;

      // ВАЖНО: Сначала корректно выходим из конференции
      if (!windowToClose.isDestroyed()) {
        log.info("[JITSI-SDK] Leaving conference before closing...");

        // Выполняем корректный выход из конференции и ждем завершения
        await windowToClose.webContents
          .executeJavaScript(
            `
          (async function() {
            return new Promise((resolve) => {
              try {
                console.log('[JITSI-SDK] Starting conference leave process...');
                
                // Если есть APP и conference
                if (window.APP && window.APP.conference) {
                  // Слушаем событие выхода из конференции
                  if (window.APP.conference.room) {
                    window.APP.conference.room.on('conference.left', () => {
                      console.log('[JITSI-SDK] Conference left event fired');
                      setTimeout(resolve, 500);
                    });
                  }
                  
                  // Вызываем leave
                  if (window.APP.conference.leave) {
                    console.log('[JITSI-SDK] Calling conference.leave()');
                    window.APP.conference.leave();
                  } else if (window.APP.conference.hangup) {
                    console.log('[JITSI-SDK] Calling conference.hangup()');  
                    window.APP.conference.hangup();
                  }
                  
                  // Fallback таймаут если событие не сработало
                  setTimeout(resolve, 2000);
                } else {
                  console.log('[JITSI-SDK] No conference to leave');
                  resolve();
                }
              } catch (e) {
                console.error('[JITSI-SDK] Error leaving conference:', e);
                resolve();
              }
            });
          })();
        `,
          )
          .catch((error) => {
            log.error(
              `[JITSI-SDK] Error executing leave script: ${error.message}`,
            );
          });

        log.info("[JITSI-SDK] Conference leave completed");

        // Показываем экран закрытия ПОСЛЕ выхода
        await this.showClosingScreenForWindow(windowToClose);

        // Ждем еще немного
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Очищаем данные
        try {
          await windowToClose.webContents.executeJavaScript(`
            localStorage.clear();
            sessionStorage.clear();
          `);
        } catch {
          // Игнорируем ошибки очистки
        }

        // Очищаем сессию
        const {session} = windowToClose.webContents;
        await session.clearStorageData();
        await session.clearCache();

        // Уничтожаем окно
        windowToClose.removeAllListeners();
        windowToClose.webContents.removeAllListeners();
        windowToClose.destroy();
      }

      log.info("[JITSI-SDK] Window closed and state cleared");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error in closeWindow: ${error.message}`);
      // Пытаемся уничтожить окно если что-то пошло не так
      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.destroy();
      }

      this.state.window = null;
      this.state.isSharing = false;
      this.state.conferenceUrl = null;
    }
  }

  private async showClosingScreenForWindow(window: BrowserWindow) {
    if (!window || window.isDestroyed()) return;

    try {
      await window.webContents.executeJavaScript(`
        (function() {
          // Проверяем, не показан ли уже экран
          const existingOverlay = document.getElementById('electron-closing-overlay');
          if (existingOverlay) {
            existingOverlay.style.display = 'flex';
            existingOverlay.style.opacity = '1';
            return;
          }
          
          const closingOverlay = document.createElement('div');
          closingOverlay.id = 'electron-closing-overlay';
          closingOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647;opacity:0;transition:opacity 0.3s ease-in;pointer-events:all;';
          
          closingOverlay.innerHTML = \`
            <style>
              @keyframes electronFadeIn {
                from { opacity: 0; transform: scale(0.9); }
                to { opacity: 1; transform: scale(1); }
              }
              @keyframes electronPulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
              }
            </style>
            <div style="text-align:center;animation:electronFadeIn 0.5s ease-out;">
              <div style="width:80px;height:80px;margin:0 auto 30px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;display:flex;align-items:center;justify-content:center;animation:electronPulse 2s ease-in-out infinite;">
                <svg viewBox="0 0 24 24" style="width:50px;height:50px;fill:white;">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>
              <div style="color:#ffffff;font-size:20px;font-weight:500;margin-bottom:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                Завершение конференции
              </div>
              <div style="color:rgba(255,255,255,0.7);font-size:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                Спасибо за участие
              </div>
            </div>
          \`;
          
          document.body.appendChild(closingOverlay);
          
          // Плавное появление
          setTimeout(() => {
            closingOverlay.style.opacity = '1';
          }, 50);
          
          // ВАЖНО: Скрываем ВСЕ другие элементы сразу
          const allElements = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
          allElements.forEach(el => {
            el.style.display = 'none';
          });
          
          // Блокируем любую навигацию
          window.electronClosing = true;
          
          // Блокируем переходы на другие страницы
          window.addEventListener('beforeunload', function(e) {
            if (window.electronClosing) {
              e.preventDefault();
              e.returnValue = '';
            }
          });
          
          // Блокируем history API
          window.history.pushState = function() {};
          window.history.replaceState = function() {};
        })();
      `);

      log.info("[JITSI-SDK] Closing screen shown");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to show closing screen: ${error.message}`);
    }
  }

  async getStatus(): Promise<any> {
    return {
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isSharing: this.state.isSharing,
    };
  }
}

export default JitsiPureManager;
