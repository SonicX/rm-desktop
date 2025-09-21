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
  private sessionCounter: number = 0; // Счетчик для уникальных сессий
  private isCreatingWindow: boolean = false; // Флаг для предотвращения множественного создания окон
  private currentRoomName: string | null = null; // Текущая комната

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
      const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
      
      // Проверяем, не создается ли уже окно для этой же комнаты
      if (this.isCreatingWindow && this.currentRoomName === roomName) {
        log.info(`[JITSI-SDK] Already creating window for room: ${roomName}, ignoring duplicate request`);
        return { success: true }; // Возвращаем успех чтобы не показывать ошибку
      }
      
      // Проверяем, не открыто ли уже окно для этой же комнаты
      if (this.state.window && !this.state.window.isDestroyed() && this.currentRoomName === roomName) {
        log.info(`[JITSI-SDK] Window already exists for room: ${roomName}, focusing existing window`);
        this.state.window.focus();
        return { success: true };
      }
      
      // Устанавливаем флаг что начинаем создание окна
      this.isCreatingWindow = true;
      this.currentRoomName = roomName;
      
      // Закрываем предыдущее окно если это другая комната
      if (this.state.window && !this.state.window.isDestroyed() && this.currentRoomName !== roomName) {
        log.info(`[JITSI-SDK] Closing previous window for different room`);
        await this.closeWindow();
        // Ждем пока окно закроется
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Сбрасываем флаг закрытия
      this.isClosing = false;

      const server = options.serverUrl || 'https://meet.jit.si';
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
      
      // Сбрасываем флаг создания окна
      this.isCreatingWindow = false;
      
      return { success: true };

    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to create window: ${error.message}`);
      
      // Сбрасываем флаги при ошибке
      this.isCreatingWindow = false;
      this.currentRoomName = null;
      
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
    let blockAllNavigation = false; // Флаг для блокировки всей навигации после начала закрытия

    // Обработчик закрытия
    this.state.window.on('close', async (event) => {
      if (closeHandled || this.isClosing) {
        return;
      }
      
      event.preventDefault();
      closeHandled = true;
      blockAllNavigation = true; // Начинаем блокировать навигацию
      
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
      
      // Если начался процесс закрытия - блокируем ЛЮБУЮ навигацию
      if (blockAllNavigation) {
        log.info("[JITSI-SDK] Blocking ALL navigation - closing in progress");
        event.preventDefault();
        return;
      }
      
      // Если это попытка перейти на главную страницу (без roomName) - блокируем и начинаем закрытие
      if (this.state.conferenceUrl && !url.includes('464604561496819')) {
        log.info("[JITSI-SDK] Blocking navigation to different page");
        event.preventDefault();
        blockAllNavigation = true; // Блокируем дальнейшую навигацию
        
        // Показываем постоянный экран закрытия
        this.showPermanentClosingScreen();
        
        // Закрываем окно через 2 секунды
        if (!this.isClosing) {
          setTimeout(() => {
            this.closeWindow();
          }, 2000);
        }
      }
    });

    // Блокируем навигацию через did-start-navigation тоже
    this.state.window.webContents.on('did-start-navigation', (event, url) => {
      if (blockAllNavigation) {
        log.info("[JITSI-SDK] Blocking navigation in did-start-navigation");
        // Показываем оверлей еще раз если нужно
        this.showPermanentClosingScreen();
      }
    });

    // DOM готов
    this.state.window.webContents.on('dom-ready', () => {
      log.info('[JITSI-SDK] DOM ready');
      // Инжектируем скрипты после загрузки DOM
      if (!this.isClosing && !blockAllNavigation) {
        this.injectLoadingOverlay();
      } else if (blockAllNavigation) {
        // Если идет закрытие - показываем экран закрытия
        this.showPermanentClosingScreen();
      }
    });

    // Страница загружена
    this.state.window.webContents.on('did-finish-load', () => {
      log.info('[JITSI-SDK] Page loaded');
      // Скрываем загрузчик когда страница загрузилась
      if (!this.isClosing && !blockAllNavigation) {
        setTimeout(() => {
          this.hideLoadingOverlay();
        }, 1000);
      } else if (blockAllNavigation) {
        // Если идет закрытие - показываем экран закрытия
        this.showPermanentClosingScreen();
      }
    });

    // Логирование консоли
    this.state.window.webContents.on('console-message', (event, level, message) => {
      if (message.includes('[JITSI]') || message.includes('conference')) {
        log.info(`Jitsi Console: ${message}`);
      }
    });
  }

  // Новый метод для показа постоянного экрана закрытия
  private async showPermanentClosingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;
    
    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          // Если уже есть постоянный оверлей - не создаем новый
          if (document.getElementById('electron-permanent-closing')) return;
          
          // Удаляем все содержимое body
          document.body.innerHTML = '';
          
          // Создаем новый оверлей как единственный элемент
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
          
          // Блокируем любые попытки изменить страницу
          const blockAll = function(e) {
            e.stopImmediatePropagation();
            e.preventDefault();
            return false;
          };
          
          // Блокируем все события
          window.addEventListener('beforeunload', blockAll, true);
          window.addEventListener('unload', blockAll, true);
          document.addEventListener('DOMContentLoaded', blockAll, true);
          
          // Перезаписываем методы навигации
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
      
      log.info('[JITSI-SDK] Permanent closing screen shown');
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to show permanent closing screen: ${error.message}`);
    }
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
          
          // Функция для показа экрана закрытия
          function showClosingAndExit() {
            if (isClosing) return;
            isClosing = true;
            
            console.log('[JITSI] Initiating conference close');
            
            // Создаем оверлей закрытия с максимальным z-index
            const overlay = document.createElement('div');
            overlay.id = 'electron-closing-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e 0%,#0f0f1e 100%);display:flex;justify-content:center;align-items:center;z-index:2147483647 !important;pointer-events:all;';
            
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
            
            // ВАЖНО: Защищаем оверлей от удаления
            // Перехватываем попытки удаления или скрытия оверлея
            const observer = new MutationObserver(function(mutations) {
              mutations.forEach(function(mutation) {
                // Если оверлей был удален - восстанавливаем его
                if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
                  for (let node of mutation.removedNodes) {
                    if (node.id === 'electron-closing-overlay') {
                      console.log('[JITSI] Overlay was removed, restoring...');
                      document.body.appendChild(node);
                      return;
                    }
                  }
                }
                // Если оверлей был скрыт - показываем его снова
                const overlayCheck = document.getElementById('electron-closing-overlay');
                if (overlayCheck && (overlayCheck.style.display === 'none' || overlayCheck.style.visibility === 'hidden')) {
                  overlayCheck.style.display = 'flex';
                  overlayCheck.style.visibility = 'visible';
                }
              });
            });
            
            // Наблюдаем за изменениями в body
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['style', 'class']
            });
            
            // Периодическая проверка видимости оверлея
            const protectInterval = setInterval(() => {
              const overlay = document.getElementById('electron-closing-overlay');
              if (overlay) {
                overlay.style.zIndex = '2147483647';
                overlay.style.display = 'flex';
                overlay.style.visibility = 'visible';
                overlay.style.position = 'fixed';
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
              }
            }, 100);
            
            // Скрываем все остальное содержимое
            const allElements = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
            allElements.forEach(el => { 
              if (el.id !== 'electron-closing-overlay') {
                el.style.display = 'none !important'; 
              }
            });
            
            // Вызываем оригинальный hangup для корректного выхода
            setTimeout(() => {
              if (window.APP && window.APP.conference) {
                if (window.APP.conference._originalHangup) {
                  console.log('[JITSI] Calling original hangup for proper leave');
                  try {
                    window.APP.conference._originalHangup();
                  } catch(e) {
                    console.error('[JITSI] Error calling original hangup:', e);
                  }
                } else if (window.APP.conference._originalLeave) {
                  console.log('[JITSI] Calling original leave for proper leave');
                  try {
                    window.APP.conference._originalLeave();
                  } catch(e) {
                    console.error('[JITSI] Error calling original leave:', e);
                  }
                }
              }
            }, 100);
            
            // Блокируем навигацию
            window.addEventListener('beforeunload', function(e) {
              // Держим оверлей видимым
              const overlay = document.getElementById('electron-closing-overlay');
              if (overlay) {
                overlay.style.display = 'flex';
                overlay.style.zIndex = '2147483647';
              }
            });
            
            // Закрываем окно через 2 секунды
            setTimeout(() => {
              // Очищаем интервал защиты перед закрытием
              clearInterval(protectInterval);
              observer.disconnect();
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
              
              // Сохраняем оригинальные методы
              if (window.APP.conference.hangup && !window.APP.conference._originalHangup) {
                window.APP.conference._originalHangup = window.APP.conference.hangup;
                
                // Перехватываем метод hangup
                window.APP.conference.hangup = function(...args) {
                  console.log('[JITSI] Hangup intercepted');
                  showClosingAndExit();
                  // Не блокируем вызов, он будет вызван в showClosingAndExit
                  return Promise.resolve();
                };
              }
              
              if (window.APP.conference.leave && !window.APP.conference._originalLeave) {
                window.APP.conference._originalLeave = window.APP.conference.leave;
                
                // Перехватываем метод leave
                window.APP.conference.leave = function(...args) {
                  console.log('[JITSI] Leave intercepted');
                  showClosingAndExit();
                  // Не блокируем вызов, он будет вызван в showClosingAndExit
                  return Promise.resolve();
                };
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
      this.isCreatingWindow = false; // Сбрасываем флаг создания при закрытии
      this.currentRoomName = null; // Сбрасываем текущую комнату
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
      this.currentRoomName = null; // Сбрасываем текущую комнату

      // НЕ вызываем hangup здесь - он уже был вызван в UI
      // Просто закрываем окно без дополнительных действий
      
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
      this.currentRoomName = null;
    } finally {
      this.isClosing = false;
      this.isCreatingWindow = false; // Сбрасываем флаг создания при закрытии
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