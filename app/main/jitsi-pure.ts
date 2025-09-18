// jitsi-pure.ts - Модуль для стандартного Jitsi без инъекций
import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import log from "electron-log";
import { ElectronSourcePicker } from "./electron-source-picker";

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

interface JitsiPureState {
  window: BrowserWindow | null;
  isSharing: boolean;
}

export class JitsiPureManager {
  private state: JitsiPureState = {
    window: null,
    isSharing: false
  };

  private bundlePath: string;
  private iconPath: string;
  private sourcePicker: ElectronSourcePicker;

  constructor(bundlePath: string, iconPath: string) {
    this.bundlePath = bundlePath;
    this.iconPath = iconPath;
    this.sourcePicker = new ElectronSourcePicker();
    
    this.registerHandlers();
    log.info("[JITSI-PURE] Manager initialized");
  }

  private registerHandlers(): void {
    // Создание окна
    ipcMain.handle("jitsi-pure:create-window", async (event, options: JitsiOptions) => {
      return this.createWindow(options);
    });

    // Закрытие окна
    ipcMain.handle("jitsi-pure:close", async () => {
      return this.closeWindow();
    });

    // Получение статуса
    ipcMain.handle("jitsi-pure:get-status", async () => {
      return {
        hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
        isSharing: this.state.isSharing
      };
    });

    // Запуск демонстрации экрана
    ipcMain.handle("jitsi-pure:start-screen-share", async () => {
      return this.startScreenShare();
    });

    // Остановка демонстрации экрана
    ipcMain.handle("jitsi-pure:stop-screen-share", async () => {
      return this.stopScreenShare();
    });
  }

  async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
    try {
      // Закрываем предыдущее окно если есть
      await this.closeWindow();
      await new Promise(resolve => setTimeout(resolve, 500));

      const server = options.serverUrl || 'https://meet.jit.si';
      const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
      const displayName = options.displayName || 'Guest';
      const topic = options.topic || '';
      const stream = options.stream || '';

      log.info(`[JITSI-PURE] Creating window: ${server}/${roomName}`);

      // Создаем окно
      this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Трансляция: ${stream} - ${topic}`,
        icon: this.iconPath,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          webSecurity: false,
          partition: `jitsi-${Date.now()}`,
          preload: path.join(this.bundlePath, "preload.js")
        },
        backgroundColor: '#000000',
        show: false,
        center: true
      });

      // Предотвращаем изменение заголовка
      this.state.window.on('page-title-updated', (event) => {
        event.preventDefault();
      });

      // Показываем индикатор загрузки
      await this.showLoadingScreen();
      this.state.window.show();

      // Формируем URL
      const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
      log.info(`[JITSI-PURE] Loading URL: ${conferenceUrl}`);

      // Обработчик завершения загрузки
      this.state.window.webContents.on('did-finish-load', async () => {
        log.info("[JITSI-PURE] Page loaded");
        await this.waitForJitsiReady();
        await this.hideLoadingScreen();
      });

      // Загружаем конференцию
      await this.state.window.loadURL(conferenceUrl);

      // Обработчик закрытия окна
      this.state.window.on('close', async (event) => {
        event.preventDefault();
        await this.leaveConference();
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (this.state.window && !this.state.window.isDestroyed()) {
          this.state.window.destroy();
        }
        this.state.window = null;
      });

      // Обработчик закрытия
      this.state.window.on('closed', () => {
        this.state.window = null;
      });

      // Слушаем консоль для отладки
      this.state.window.webContents.on('console-message', (event, level, message) => {
        if (message.includes('[Jitsi]')) {
          log.info(`Jitsi Console: ${message}`);
        }
      });

      return { success: true };

    } catch (error: any) {
      log.error(`[JITSI-PURE] Failed to create window: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private buildConferenceUrl(server: string, roomName: string, options: JitsiOptions): string {
    let url = `${server}/${roomName}`;

    // Query параметры
    const queryParams = new URLSearchParams();
    if (options.jwt) queryParams.append('jwt', options.jwt);
    
    if (queryParams.toString()) {
      url += '?' + queryParams.toString();
    }

    // Hash параметры для конфигурации
    const hashParams = new URLSearchParams();
    
    // Основные настройки
    hashParams.append('config.prejoinPageEnabled', 'false');
    hashParams.append('config.startWithAudioMuted', 'false');
    hashParams.append('config.startWithVideoMuted', 'true');
    
    // Настройки логирования
    hashParams.append('config.apiLogLevels', JSON.stringify(['error']));
    hashParams.append('config.logging.defaultLogLevel', 'error');
    
    // Настройки видео и аудио
    hashParams.append('config.disableSimulcast', 'false');
    hashParams.append('config.resolution', '720');
    
    // Настройки демонстрации экрана
    hashParams.append('config.desktopSharingFrameRate.min', '5');
    hashParams.append('config.desktopSharingFrameRate.max', '30');
    
    // Отключение функций интерфейса
    hashParams.append('config.hideConferenceSubject', 'true');
    hashParams.append('config.disableInviteFunctions', 'true');
    hashParams.append('config.disableRemoteMute', 'true');
    
    // Кнопки тулбара
    const toolbarButtons = [
      'camera',
      'desktop',
      'microphone',
      'settings',
      'fullscreen',
      'hangup'
    ];
    hashParams.append('interfaceConfig.TOOLBAR_BUTTONS', JSON.stringify(toolbarButtons));
    
    // Информация о пользователе
    if (options.displayName) {
      hashParams.append('userInfo.displayName', options.displayName);
    }
    if (options.email) {
      hashParams.append('userInfo.email', options.email);
    }
    
    // Источники для демонстрации
    hashParams.append('config.desktopSharingSources', JSON.stringify(['screen', 'window']));
    
    // Дополнительные настройки
    hashParams.append('config.enableWelcomePage', 'false');
    hashParams.append('config.enableClosePage', 'false');
    hashParams.append('config.p2p.enabled', 'false');
    
    if (hashParams.toString()) {
      url += '#' + hashParams.toString();
    }

    return url;
  }

  private async showLoadingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;
    
    const loadingHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
          .loading-container {
            text-align: center;
            animation: fadeIn 0.5s ease-in;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: pulse 2s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
          .loading-text {
            color: #ffffff;
            font-size: 18px;
            font-weight: 500;
            margin-bottom: 20px;
          }
          .spinner {
            width: 50px;
            height: 50px;
            margin: 0 auto;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="loading-container">
          <div class="logo">
            <svg viewBox="0 0 24 24" style="width: 50px; height: 50px; fill: white;">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
          </div>
          <div class="loading-text">Подключаемся к конференции</div>
          <div class="spinner"></div>
        </div>
      </body>
      </html>
    `;
    
    await this.state.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
  }

  private async hideLoadingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;
    
    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const fadeOverlay = document.createElement('div');
          fadeOverlay.style.cssText = \`
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #1a1a2e;
            z-index: 999999;
            transition: opacity 0.8s ease-out;
            pointer-events: none;
          \`;
          document.body.appendChild(fadeOverlay);
          
          setTimeout(() => {
            fadeOverlay.style.opacity = '0';
            setTimeout(() => {
              fadeOverlay.remove();
            }, 800);
          }, 200);
        })();
      `);
    } catch (error) {
      log.error("[JITSI-PURE] Error hiding loading screen:", error);
    }
  }

  private async waitForJitsiReady(): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) return false;
    
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      try {
        const isReady = await this.state.window.webContents.executeJavaScript(`
          (function() {
            const checks = {
              hasJitsiMeetJS: typeof JitsiMeetJS !== 'undefined',
              hasAPP: typeof APP !== 'undefined',
              hasConference: !!(window.APP && window.APP.conference),
              domReady: document.readyState === 'complete',
              hasToolbar: !!document.querySelector('.toolbox-content-items')
            };
            
            const isReady = checks.hasJitsiMeetJS && 
                          checks.hasAPP && 
                          checks.hasConference &&
                          checks.domReady &&
                          checks.hasToolbar;
            
            return isReady;
          })();
        `);
        
        if (isReady) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          log.info("[JITSI-PURE] Jitsi is ready");
          return true;
        }
      } catch (error) {
        // Игнорируем ошибки во время загрузки
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    log.warn("[JITSI-PURE] Jitsi initialization timeout");
    return false;
  }

  private async leaveConference(): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      return false;
    }
    
    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (async function() {
          console.log('[Jitsi] Leaving conference...');
          
          if (window.APP && window.APP.conference) {
            if (window.APP.conference.hangup) {
              window.APP.conference.hangup(true);
              await new Promise(resolve => setTimeout(resolve, 1000));
              return true;
            }
            
            if (window.APP.conference._room && window.APP.conference._room.leave) {
              await window.APP.conference._room.leave();
              return true;
            }
          }
          
          return false;
        })();
      `);
      
      return result;
      
    } catch (error: any) {
      log.error(`[JITSI-PURE] Error leaving conference: ${error.message}`);
      return false;
    }
  }

  async startScreenShare(): Promise<{ success: boolean; error?: string }> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      return { success: false, error: "No window" };
    }
    
    try {
      // Получаем источники
      const sources = await this.sourcePicker.getSources();
      
      // Показываем диалог выбора
      const selectedSource = await this.sourcePicker.showPicker(sources);
      
      if (!selectedSource) {
        return { success: false, error: "User cancelled" };
      }
      
      // Запускаем демонстрацию экрана
      const result = await this.state.window.webContents.executeJavaScript(`
        (async function() {
          try {
            if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
              await window.APP.conference.toggleScreenSharing();
              return { success: true };
            }
            return { success: false, error: 'Jitsi API not ready' };
          } catch (error) {
            return { success: false, error: error.message };
          }
        })();
      `);
      
      if (result.success) {
        this.state.isSharing = true;
        log.info("[JITSI-PURE] Screen sharing started");
      }
      
      return result;
      
    } catch (error: any) {
      log.error(`[JITSI-PURE] Error starting screen share: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async stopScreenShare(): Promise<{ success: boolean; error?: string }> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      return { success: false, error: "No window" };
    }
    
    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (async function() {
          try {
            if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
              await window.APP.conference.toggleScreenSharing();
              return { success: true };
            }
            return { success: false, error: 'Jitsi API not ready' };
          } catch (error) {
            return { success: false, error: error.message };
          }
        })();
      `);
      
      if (result.success) {
        this.state.isSharing = false;
        log.info("[JITSI-PURE] Screen sharing stopped");
      }
      
      return result;
      
    } catch (error: any) {
      log.error(`[JITSI-PURE] Error stopping screen share: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async closeWindow(): Promise<void> {
    if (!this.state.window) {
      return;
    }
    
    try {
      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.removeAllListeners();
        this.state.window.close();
      }
    } catch (error: any) {
      log.error(`[JITSI-PURE] Error closing window: ${error.message}`);
    } finally {
      this.state.window = null;
      this.state.isSharing = false;
    }
  }

  async getStatus(): Promise<any> {
    return {
      hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
      isSharing: this.state.isSharing
    };
  }
}

export default JitsiPureManager;