// jitsi-sdk-manager.ts - Модуль для работы с Jitsi через SDK
import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import log from "electron-log";

// Интерфейсы
interface JitsiOptions {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
  topic?: string;
  stream?: string;
}

interface JitsiSDKState {
  window: BrowserWindow | null;
  isConnected: boolean;
  conferenceUrl: string | null;
}

export class JitsiSDKManager {
  private state: JitsiSDKState = {
    window: null,
    isConnected: false,
    conferenceUrl: null
  };

  private iconPath: string;
  private isClosing: boolean = false;

  constructor(iconPath: string) {
    this.iconPath = iconPath;
    
    // Инициализируем SDK при создании менеджера
    this.initializeSDK();
    
    // Регистрируем обработчики
    this.registerHandlers();
    
    log.info("[JITSI-SDK] Manager created");
  }

  private initializeSDK(): void {
    try {
      // Загружаем модуль SDK
      const jitsiSDK = require('@jitsi/electron-sdk');
      
      // Инициализируем вспомогательные функции SDK
      // Они нужны для работы screen sharing и других функций
      if (jitsiSDK.setupScreenSharingMain) {
        // Оборачиваем в try-catch так как может требовать окна
        try {
          jitsiSDK.setupScreenSharingMain();
          log.info("[JITSI-SDK] Screen sharing initialized");
        } catch (e) {
          // Это нормально - будет инициализировано когда создастся окно
        }
      }
      
      if (jitsiSDK.setupAlwaysOnTopMain) {
        jitsiSDK.setupAlwaysOnTopMain();
        log.info("[JITSI-SDK] Always on top initialized");
      }
      
      if (jitsiSDK.setupPowerMonitorMain) {
        jitsiSDK.setupPowerMonitorMain();
        log.info("[JITSI-SDK] Power monitor initialized");
      }
      
      log.info("[JITSI-SDK] SDK helper functions initialized");
      
    } catch (error: any) {
      log.warn(`[JITSI-SDK] SDK not available or failed to initialize: ${error.message}`);
      // Продолжаем работу - будем использовать обычное окно
    }
  }

  private registerHandlers(): void {
    // Создание окна
    ipcMain.handle("jitsi-sdk:create-window", async (event, options: JitsiOptions) => {
      return this.createWindow(options);
    });

    // Закрытие окна
    ipcMain.handle("jitsi-sdk:close", async () => {
      return this.closeWindow();
    });

    // Получение статуса
    ipcMain.handle("jitsi-sdk:get-status", async () => {
      return {
        hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
        isConnected: this.state.isConnected
      };
    });
  }

  async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
    try {
      // Закрываем предыдущее окно если есть
      if (this.state.window && !this.state.window.isDestroyed()) {
        await this.closeWindow();
        // Ждем пока окно закроется
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Сбрасываем флаг закрытия
      this.isClosing = false;

      const server = options.serverUrl || 'https://meet.jit.si';
      const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
      const displayName = options.displayName || 'Guest';
      const topic = options.topic || '';
      const stream = options.stream || '';

      log.info(`[JITSI-SDK] Creating window for room: ${roomName}`);

      // Создаем обычное окно BrowserWindow
      // SDK будет работать внутри него
      this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Трансляция: ${stream} - ${topic}`,
        icon: this.iconPath,
        center: true,
        show: false,
        backgroundColor: '#1a1a2e',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false, // Важно для работы SDK
          sandbox: false,
          webSecurity: false,
          // Добавляем preload если есть SDK preload скрипт
          preload: this.getSDKPreloadPath()
        }
      });

      // Настраиваем обработчики окна
      this.setupWindowHandlers();

      // Формируем URL с конфигурацией
      const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
      this.state.conferenceUrl = conferenceUrl;

      // Показываем окно
      this.state.window.show();

      log.info(`[JITSI-SDK] Loading conference URL: ${conferenceUrl}`);

      // Загружаем конференцию
      await this.state.window.loadURL(conferenceUrl);

      // Ждем готовности
      await this.waitForConference();

      // Инжектируем обработчики после загрузки
      await this.injectConferenceHandlers();

      log.info("[JITSI-SDK] Conference window created successfully");
      this.state.isConnected = true;
      
      return { success: true };

    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to create window: ${error.message}`);
      
      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.close();
        this.state.window = null;
      }
      
      return { success: false, error: error.message };
    }
  }

  private getSDKPreloadPath(): string | undefined {
    try {
      // Пытаемся найти preload скрипт от SDK
      const sdkPath = require.resolve('@jitsi/electron-sdk');
      const preloadPath = path.join(path.dirname(sdkPath), 'preload.js');
      
      const fs = require('fs');
      if (fs.existsSync(preloadPath)) {
        log.info(`[JITSI-SDK] Found SDK preload at: ${preloadPath}`);
        return preloadPath;
      }
    } catch (e) {
      // SDK preload не найден
    }
    return undefined;
  }

  private setupWindowHandlers(): void {
    if (!this.state.window) return;

    // Флаг для предотвращения множественных закрытий
    let closeHandled = false;

    // Обработчик закрытия
    this.state.window.on('close', async (event) => {
      if (closeHandled || this.isClosing) {
        return;
      }
      
      event.preventDefault();
      closeHandled = true;
      
      log.info("[JITSI-SDK] Window close requested");
      
      // Показываем экран закрытия
      await this.showClosingScreen();
      
      // Закрываем окно через небольшую задержку
      setTimeout(() => {
        this.closeWindow();
      }, 2000);
    });

    this.state.window.on('closed', () => {
      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;
    });

    // Предотвращаем изменение заголовка
    this.state.window.on('page-title-updated', (event) => {
      event.preventDefault();
    });

    // Блокируем навигацию на главную страницу Jitsi после выхода
    this.state.window.webContents.on('will-navigate', (event, url) => {
      log.info(`[JITSI-SDK] Navigation attempt to: ${url}`);
      
      // Если это не наша конференция - блокируем навигацию
      if (this.state.conferenceUrl && !url.includes(this.state.conferenceUrl.split('#')[0])) {
        log.info("[JITSI-SDK] Blocking navigation to different page");
        event.preventDefault();
        
        // Показываем экран закрытия и закрываем окно
        this.showClosingScreen().then(() => {
          setTimeout(() => {
            this.closeWindow();
          }, 2000);
        });
      }
    });

    // DOM готов
    this.state.window.webContents.on('dom-ready', () => {
      log.info('[JITSI-SDK] DOM ready');
      // Инжектируем скрипты после загрузки DOM
      this.injectLoadingOverlay();
    });

    // Страница загружена
    this.state.window.webContents.on('did-finish-load', () => {
      log.info('[JITSI-SDK] Page loaded');
      // Скрываем загрузчик когда страница загрузилась
      setTimeout(() => {
        this.hideLoadingOverlay();
      }, 1000);
    });

    // Логирование консоли
    this.state.window.webContents.on('console-message', (event, level, message) => {
      if (message.includes('[JITSI]') || message.includes('conference')) {
        log.info(`Jitsi Console: ${message}`);
      }
    });
  }

  private buildConferenceUrl(server: string, roomName: string, options: JitsiOptions): string {
    let url = `${server}/${roomName}`;

    // Query параметры
    const queryParams = new URLSearchParams();
    if (options.jwt) {
      queryParams.append('jwt', options.jwt);
    }
    
    if (queryParams.toString()) {
      url += '?' + queryParams.toString();
    }

    // Hash параметры для конфигурации
    const hashParams = new URLSearchParams();

    // Основные настройки
    hashParams.append('config.disableDeepLinking', 'true');
    hashParams.append('config.prejoinPageEnabled', 'false');
    hashParams.append('config.startWithAudioMuted', 'false');
    hashParams.append('config.startWithVideoMuted', 'true');
    hashParams.append('config.enableWelcomePage', 'false');
    hashParams.append('config.enableClosePage', 'false');
    
    // Качество и производительность
    hashParams.append('config.resolution', '720');
    hashParams.append('config.disableInitialGUM', 'false');
    hashParams.append('config.enableLayerSuspension', 'true');
    
    // P2P настройки
    hashParams.append('config.p2p.enabled', 'true');
    hashParams.append('config.p2p.preferH264', 'true');
    
    // UI настройки
    hashParams.append('interfaceConfig.SHOW_JITSI_WATERMARK', 'false');
    hashParams.append('interfaceConfig.SHOW_WATERMARK_FOR_GUESTS', 'false');
    hashParams.append('interfaceConfig.SHOW_BRAND_WATERMARK', 'false');
    hashParams.append('interfaceConfig.HIDE_INVITE_MORE_HEADER', 'true');
    hashParams.append('interfaceConfig.MOBILE_APP_PROMO', 'false');
    
    // Кнопки тулбара
    const toolbarButtons = ['camera', 'desktop', 'microphone', 'participants', 'chat', 'settings', 'fullscreen', 'hangup'];
    hashParams.append('interfaceConfig.TOOLBAR_BUTTONS', JSON.stringify(toolbarButtons));
    
    // Информация о пользователе
    if (options.displayName) {
      hashParams.append('userInfo.displayName', options.displayName);
    }
    if (options.email) {
      hashParams.append('userInfo.email', options.email);
    }
    if (options.avatarUrl) {
      hashParams.append('userInfo.avatarURL', options.avatarUrl);
      hashParams.append('config.gravatar.disabled', 'true');
    }
    
    if (hashParams.toString()) {
      url += '#' + hashParams.toString();
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
            // Проверяем готовность Jitsi
            if (window.APP && window.APP.conference) {
              return true;
            }
            if (window.JitsiMeetJS) {
              return true;
            }
            // Проверяем что страница загружена
            return document.readyState === 'complete';
          })();
        `);

        if (isReady) {
          log.info('[JITSI-SDK] Conference ready');
          return;
        }
      } catch (error) {
        // Игнорируем ошибки
      }

      await new Promise(resolve => setTimeout(resolve, 200));
      attempts++;
    }

    log.warn('[JITSI-SDK] Conference ready timeout - proceeding anyway');
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
      
      log.info('[JITSI-SDK] Loading overlay shown');
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
      
      log.info('[JITSI-SDK] Loading overlay hidden');
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
          
          // Скрываем остальной контент
          const others = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
          others.forEach(el => { el.style.display = 'none'; });
        })();
      `);
      
      log.info('[JITSI-SDK] Closing screen shown');
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
          
          let isClosing = false;
          
          // Функция для немедленного показа экрана закрытия и блокировки навигации
          function showClosingAndExit() {
            if (isClosing) return;
            isClosing = true;
            
            console.log('[JITSI] Initiating conference close');
            
            // Создаем оверлей закрытия
            const overlay = document.createElement('div');
            overlay.id = 'electron-closing-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647;';
            
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
            
            // Скрываем все остальное содержимое
            const allElements = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
            allElements.forEach(el => { 
              el.style.display = 'none'; 
            });
            
            // Блокируем навигацию
            window.addEventListener('beforeunload', function(e) {
              e.preventDefault();
              e.returnValue = '';
            });
            
            // Закрываем окно через 2 секунды
            setTimeout(() => {
              window.close();
            }, 2000);
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
          
          // Дополнительный перехват через интервал для поиска APP.conference
          const checkInterval = setInterval(() => {
            if (window.APP && window.APP.conference) {
              clearInterval(checkInterval);
              
              // Перехватываем метод hangup
              const originalHangup = window.APP.conference.hangup;
              if (originalHangup && !originalHangup._intercepted) {
                window.APP.conference.hangup = function(...args) {
                  console.log('[JITSI] Hangup intercepted');
                  showClosingAndExit();
                  // НЕ вызываем оригинальный hangup чтобы предотвратить переход на главную
                  return Promise.resolve();
                };
                window.APP.conference.hangup._intercepted = true;
              }
              
              // Перехватываем метод leave
              const originalLeave = window.APP.conference.leave;
              if (originalLeave && !originalLeave._intercepted) {
                window.APP.conference.leave = function(...args) {
                  console.log('[JITSI] Leave intercepted');
                  showClosingAndExit();
                  // НЕ вызываем оригинальный leave
                  return Promise.resolve();
                };
                window.APP.conference.leave._intercepted = true;
              }
              
              console.log('[JITSI] Conference methods intercepted');
            }
          }, 100);
          
          // Останавливаем проверку через 10 секунд
          setTimeout(() => clearInterval(checkInterval), 10000);
          
          console.log('[JITSI] Handlers installed');
        })();
      `);
      
      log.info('[JITSI-SDK] Conference handlers injected');
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject handlers: ${error.message}`);
    }
  }

  async closeWindow(): Promise<void> {
    if (this.isClosing) {
      log.info('[JITSI-SDK] Already closing window');
      return;
    }

    if (!this.state.window || this.state.window.isDestroyed()) {
      log.info('[JITSI-SDK] Window already closed');
      this.isClosing = false;
      return;
    }

    this.isClosing = true;
    log.info('[JITSI-SDK] Closing conference window');

    try {
      const windowToClose = this.state.window;
      
      // Сбрасываем состояние сразу
      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;

      // Пытаемся корректно выйти из конференции
      try {
        await windowToClose.webContents.executeJavaScript(`
          (function() {
            if (window.APP && window.APP.conference) {
              if (window.APP.conference.leave) {
                window.APP.conference.leave();
              } else if (window.APP.conference.hangup) {
                window.APP.conference.hangup();
              }
            }
          })();
        `);
        
        // Небольшая задержка для завершения
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (e) {
        // Игнорируем ошибки выхода
      }

      // Закрываем окно
      windowToClose.removeAllListeners();
      windowToClose.webContents.removeAllListeners();
      windowToClose.destroy();

      log.info('[JITSI-SDK] Window closed successfully');
      
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error closing window: ${error.message}`);
      
      // Форсированное закрытие
      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.destroy();
      }
      
      this.state.window = null;
      this.state.isConnected = false;
    } finally {
      this.isClosing = false;
    }
  }

  async getStatus(): Promise<any> {
    return {
      hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
      isConnected: this.state.isConnected,
      conferenceUrl: this.state.conferenceUrl
    };
  }
}

export default JitsiSDKManager;