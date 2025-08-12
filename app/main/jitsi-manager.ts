// jitsi-manager.ts - Модуль для управления Jitsi окнами
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";

interface JitsiOptions {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
}

interface JitsiState {
  window: BrowserWindow | null;
  isStreamActive: boolean;
  streamId: string | null;
  lastSelectedSourceId?: string;
  videoFrameCount?: number; 
  audioFrameCount?: number;
  qualityPreset?: string;
}

export class JitsiManager {
  private state: JitsiState = {
    window: null,
    isStreamActive: false,
    streamId: null
  };

  private nativeCapture: NativeCaptureManager;
  private bundlePath: string;
  private iconPath: string;

  constructor(nativeCapture: NativeCaptureManager, bundlePath: string, iconPath: string) {
    this.nativeCapture = nativeCapture;
    this.bundlePath = bundlePath;
    this.iconPath = iconPath;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Основной обработчик для создания окна
    ipcMain.handle("jitsi:create-window", async (event, options: JitsiOptions) => {
      return this.createWindow(options);
    });

    // Создание и инъекция native stream
    ipcMain.handle("jitsi:inject-native-stream", async () => {
      return this.injectNativeStream();
    });

    // Закрытие окна
    ipcMain.handle("jitsi:close", async () => {
      return this.closeWindow();
    });

    // Получение статуса
    ipcMain.handle("jitsi:get-status", async () => {
      return {
        hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
        isStreamActive: this.state.isStreamActive,
        streamId: this.state.streamId
      };
    });

    ipcMain.handle("jitsi:save-selected-source", async (event, sourceId: string) => {
        this.state.lastSelectedSourceId = sourceId;
        log.info(`Saved selected source: ${sourceId}`);
        return { success: true };
    });
  }

  async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
    try {
        // Закрываем предыдущее окно если есть
        await this.closeWindow();

        const server = options.serverUrl || 'https://jitsi-connectrm.ru';
        const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
        const displayName = options.displayName || 'Guest';

        log.info(`Creating Jitsi window: ${server}/${roomName}`);

        // Создаем окно
        this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Конференция: ${roomName}`,
        icon: this.iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: false,
            partition: `jitsi-${Date.now()}`,
            preload: path.join(this.bundlePath, "preload.js")
        },
        show: true,
        center: true
        });

        // Формируем URL
        const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
        
        log.info(`Loading conference URL: ${conferenceUrl}`);
        
        // ВАЖНО: Ждем полной загрузки страницы
        await this.state.window.loadURL(conferenceUrl);
        
        // Ждем загрузки Jitsi и инжектируем обработчики несколько раз
        // Первая попытка через 3 секунды
        setTimeout(() => {
        log.info("First injection attempt (3s)...");
        this.injectHandlers();
        }, 3000);
        
        // Вторая попытка через 5 секунд (если первая не сработала)
        setTimeout(() => {
        log.info("Second injection attempt (5s)...");
        this.injectHandlers();
        }, 5000);
        
        // Третья попытка через 8 секунд (для медленного интернета)
        setTimeout(() => {
        log.info("Third injection attempt (8s)...");
        this.injectHandlers();
        }, 8000);

        // Обработчик закрытия
        this.state.window.on('closed', () => {
        this.cleanup();
        });

        // Слушаем консоль для отладки
        this.state.window.webContents.on('console-message', (event, level, message) => {
        if (message.includes('[JitsiDebug]') || 
            message.includes('[JitsiManager]') || 
            message.includes('[NativeStream]') ||
            message.includes('[SourcePicker]')) {
            log.info(`Jitsi Console: ${message}`);
        }
        });

        return { success: true };

    } catch (error: any) {
        log.error(`Failed to create Jitsi window: ${error.message}`);
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
    hashParams.append('config.prejoinPageEnabled', 'false');
    hashParams.append('config.startWithAudioMuted', 'false');
    hashParams.append('config.startWithVideoMuted', 'true');
    
    if (options.displayName) hashParams.append('userInfo.displayName', options.displayName);
    if (options.email) hashParams.append('userInfo.email', options.email);
    if (options.avatarUrl) hashParams.append('userInfo.avatar', options.avatarUrl);
    
    if (hashParams.toString()) {
      url += '#' + hashParams.toString();
    }

    return url;
  }

  private async injectHandlers(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
        // Сначала проверяем, готов ли Jitsi
        const isReady = await this.state.window.webContents.executeJavaScript(`
            (function() {
                const ready = !!(window.JitsiMeetJS && window.APP && window.APP.conference);
                console.log('[JitsiDebug] Checking readiness:', {
                    hasJitsiMeetJS: !!window.JitsiMeetJS,
                    hasAPP: !!window.APP,
                    hasConference: !!(window.APP && window.APP.conference),
                    ready: ready
                });
                return ready;
            })();
        `);

        if (!isReady) {
            log.warn("Jitsi not ready yet, skipping injection");
            return;
        }

        log.info("Jitsi is ready, injecting handlers...");

        // Проверяем, не инжектировали ли уже
        const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
            !!(window.jitsiHandlersInjected)
        `);

        if (alreadyInjected) {
            log.info("Handlers already injected, skipping");
            return;
        }

        await this.state.window.webContents.executeJavaScript(`
            (function() {
                // Помечаем, что инжекция выполнена
                if (window.jitsiHandlersInjected) {
                    console.log('[JitsiNative] Handlers already injected');
                    return;
                }
                window.jitsiHandlersInjected = true;
                
                console.log('[JitsiNative] Starting complete injection...');
                
                // === ОТЛАДОЧНЫЙ ИНДИКАТОР ===
                if (!document.getElementById('stream-debug-indicator')) {
                    const debugIndicator = document.createElement('div');
                    debugIndicator.id = 'stream-debug-indicator';
                    debugIndicator.style.cssText = \`
                        position: fixed;
                        top: 10px;
                        left: 10px;
                        background: rgba(0, 0, 0, 0.8);
                        color: white;
                        padding: 10px 15px;
                        border-radius: 8px;
                        z-index: 100000;
                        font-family: monospace;
                        font-size: 12px;
                        min-width: 200px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                    \`;
                    debugIndicator.innerHTML = \`
                        <div style="font-weight: bold; margin-bottom: 5px;">🎯 Native Stream Debug</div>
                        <div>Type: <span id="source-type" style="color: #ffa726;">Not set</span></div>
                        <div>Native Active: <span id="native-status" style="color: #ef5350;">No</span></div>
                        <div>Stream ID: <span id="stream-id" style="font-size: 10px;">None</span></div>
                    \`;
                    document.body.appendChild(debugIndicator);
                }
                
                // Функция обновления индикатора
                function updateDebugIndicator() {
                    const typeEl = document.getElementById('source-type');
                    const statusEl = document.getElementById('native-status');
                    const idEl = document.getElementById('stream-id');
                    const indicator = document.getElementById('stream-debug-indicator');
                    
                    if (window.jitsiNativeMediaStream && window.isNativeActive) {
                        if (typeEl) typeEl.textContent = 'NATIVE';
                        if (statusEl) {
                            statusEl.textContent = 'Active';
                            statusEl.style.color = '#66bb6a';
                        }
                        if (idEl) idEl.textContent = window.jitsiNativeMediaStream.id.substring(0, 8) + '...';
                        if (indicator) {
                            indicator.style.background = 'linear-gradient(135deg, rgba(76, 175, 80, 0.95), rgba(102, 187, 106, 0.95))';
                        }
                    } else {
                        if (typeEl) typeEl.textContent = 'None';
                        if (statusEl) {
                            statusEl.textContent = 'No';
                            statusEl.style.color = '#ef5350';
                        }
                        if (idEl) idEl.textContent = 'None';
                        if (indicator) {
                            indicator.style.background = 'rgba(0, 0, 0, 0.8)';
                        }
                    }
                }
                
                setInterval(updateDebugIndicator, 500);
                
                // === СОХРАНЯЕМ ОРИГИНАЛЬНЫЕ ФУНКЦИИ ===
                const originalFunctions = {
                    openDesktopPicker: null,
                    obtainDesktopStream: null,
                    createLocalTracks: null,
                    getDisplayMedia: null,
                    getUserMedia: null
                };
                
                // === КРИТИЧЕСКИЙ ПЕРЕХВАТ: JitsiMeetJS.createLocalTracks ===
                if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                    console.log('[JitsiNative] Saving original createLocalTracks');
                    originalFunctions.createLocalTracks = window.JitsiMeetJS.createLocalTracks;
                    
                    window.JitsiMeetJS.createLocalTracks = async function(options) {
                        console.log('[JitsiNative] createLocalTracks intercepted, options:', options);
                        
                        // Проверяем, запрашивается ли desktop
                        if (options && options.devices && options.devices.includes('desktop')) {
                            console.log('[JitsiNative] Desktop track requested');
                            
                            // Проверяем наличие native stream
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] 🎯 Native stream available, injecting it...');
                                
                                try {
                                    // КРИТИЧЕСКИЙ ТРЮК: Временно подменяем getUserMedia и getDisplayMedia
                                    const tempGetUserMedia = navigator.mediaDevices.getUserMedia;
                                    const tempGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                                    
                                    // Подменяем getUserMedia
                                    navigator.mediaDevices.getUserMedia = async function(constraints) {
                                        console.log('[JitsiNative] getUserMedia intercepted in createLocalTracks');
                                        if (constraints && constraints.video && 
                                            constraints.video.mandatory && 
                                            constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                            console.log('[JitsiNative] Returning native stream for desktop getUserMedia');
                                            return window.jitsiNativeMediaStream;
                                        }
                                        return tempGetUserMedia.call(this, constraints);
                                    };
                                    
                                    // Подменяем getDisplayMedia
                                    navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                                        console.log('[JitsiNative] getDisplayMedia intercepted in createLocalTracks');
                                        console.log('[JitsiNative] 🎯 RETURNING NATIVE STREAM!');
                                        return window.jitsiNativeMediaStream;
                                    };
                                    
                                    // Вызываем оригинальную функцию с подмененными методами
                                    console.log('[JitsiNative] Calling original createLocalTracks...');
                                    const tracks = await originalFunctions.createLocalTracks.call(this, options);
                                    
                                    // Восстанавливаем оригинальные методы
                                    navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                    navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                    
                                    if (tracks && tracks.length > 0) {
                                        console.log('[JitsiNative] ✅ JitsiLocalTrack created successfully with native stream');
                                        
                                        // Добавляем обработчик остановки
                                        const originalDispose = tracks[0].dispose;
                                        tracks[0].dispose = function() {
                                            console.log('[JitsiNative] Track dispose called');
                                            window.isNativeActive = false;
                                            updateDebugIndicator();
                                            if (originalDispose) {
                                                return originalDispose.call(this);
                                            }
                                        };
                                    }
                                    
                                    return tracks;
                                    
                                } catch (e) {
                                    console.error('[JitsiNative] Error in createLocalTracks:', e);
                                    // Восстанавливаем методы в случае ошибки
                                    navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                    navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                    throw e;
                                }
                            }
                        }
                        
                        // Для других типов треков вызываем оригинальную функцию
                        return originalFunctions.createLocalTracks.call(this, options);
                    };
                    
                    console.log('[JitsiNative] ✅ createLocalTracks intercepted');
                }
                
                // === ПЕРЕХВАТ JitsiMeetScreenObtainer (для диалога выбора) ===
                if (window.JitsiMeetScreenObtainer) {
                    console.log('[JitsiNative] Setting up JitsiMeetScreenObtainer interceptors');
                    
                    // openDesktopPicker - для выбора источника
                    if (window.JitsiMeetScreenObtainer.openDesktopPicker) {
                        originalFunctions.openDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                        
                        window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                            console.log('[JitsiNative] openDesktopPicker intercepted');
                            
                            // Если есть native stream, сразу возвращаем его
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] Native stream active, auto-selecting');
                                setTimeout(() => {
                                    const sourceId = 'native:stream:' + Date.now();
                                    callback(sourceId, { audio: true, screenShareAudio: true });
                                }, 100);
                                return;
                            }
                            
                            // Иначе вызываем оригинальный метод (или показываем диалог выбора)
                            return originalFunctions.openDesktopPicker.call(this, options, callback);
                        };
                    }
                    
                    // obtainDesktopStream - для получения stream по sourceId
                    if (window.JitsiMeetScreenObtainer.obtainDesktopStream) {
                        originalFunctions.obtainDesktopStream = window.JitsiMeetScreenObtainer.obtainDesktopStream;
                        
                        window.JitsiMeetScreenObtainer.obtainDesktopStream = function(sourceId, callback, errorCallback) {
                            console.log('[JitsiNative] obtainDesktopStream intercepted, sourceId:', sourceId);
                            
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] Returning native stream from obtainDesktopStream');
                                setTimeout(() => {
                                    callback(window.jitsiNativeMediaStream);
                                }, 100);
                                return;
                            }
                            
                            return originalFunctions.obtainDesktopStream.call(this, sourceId, callback, errorCallback);
                        };
                    }
                    
                    console.log('[JitsiNative] ✅ JitsiMeetScreenObtainer intercepted');
                }
                
                // === ПОСТОЯННЫЕ ПЕРЕХВАТЫ (на всякий случай) ===
                if (!window.originalGetDisplayMedia) {
                    originalFunctions.getDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                    
                    navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                        console.log('[JitsiNative] Global getDisplayMedia intercepted');
                        
                        if (window.jitsiNativeMediaStream && window.isNativeActive) {
                            console.log('[JitsiNative] 🎯 Returning native stream from global getDisplayMedia');
                            return window.jitsiNativeMediaStream;
                        }
                        
                        return originalFunctions.getDisplayMedia.call(this, constraints);
                    };
                }
                
                if (!window.originalGetUserMedia) {
                    originalFunctions.getUserMedia = navigator.mediaDevices.getUserMedia;
                    
                    navigator.mediaDevices.getUserMedia = async function(constraints) {
                        if (constraints && constraints.video && 
                            constraints.video.mandatory && 
                            constraints.video.mandatory.chromeMediaSource === 'desktop') {
                            console.log('[JitsiNative] Global getUserMedia for desktop intercepted');
                            
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] 🎯 Returning native stream from global getUserMedia');
                                return window.jitsiNativeMediaStream;
                            }
                        }
                        
                        return originalFunctions.getUserMedia.call(this, constraints);
                    };
                }
                
                // === ФУНКЦИЯ ОЧИСТКИ ===
                window.cleanupNativeStream = function() {
                    console.log('[JitsiNative] Cleaning up...');
                    
                    // Останавливаем stream
                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => track.stop());
                    }
                    
                    // Восстанавливаем оригинальные функции
                    if (originalFunctions.createLocalTracks && window.JitsiMeetJS) {
                        window.JitsiMeetJS.createLocalTracks = originalFunctions.createLocalTracks;
                    }
                    if (originalFunctions.openDesktopPicker && window.JitsiMeetScreenObtainer) {
                        window.JitsiMeetScreenObtainer.openDesktopPicker = originalFunctions.openDesktopPicker;
                    }
                    if (originalFunctions.obtainDesktopStream && window.JitsiMeetScreenObtainer) {
                        window.JitsiMeetScreenObtainer.obtainDesktopStream = originalFunctions.obtainDesktopStream;
                    }
                    if (originalFunctions.getDisplayMedia) {
                        navigator.mediaDevices.getDisplayMedia = originalFunctions.getDisplayMedia;
                    }
                    if (originalFunctions.getUserMedia) {
                        navigator.mediaDevices.getUserMedia = originalFunctions.getUserMedia;
                    }
                    
                    window.isNativeActive = false;
                    window.jitsiNativeMediaStream = null;
                    
                    updateDebugIndicator();
                    console.log('[JitsiNative] Cleanup complete');
                };
                
                console.log('[JitsiNative] ✅ Complete injection finished!');
                console.log('[JitsiNative] Key intercepts:');
                console.log('  - JitsiMeetJS.createLocalTracks: ' + (!!originalFunctions.createLocalTracks));
                console.log('  - JitsiMeetScreenObtainer.openDesktopPicker: ' + (!!originalFunctions.openDesktopPicker));
                console.log('  - navigator.mediaDevices.getDisplayMedia: ' + (!!originalFunctions.getDisplayMedia));
                
                return true;
            })();
        `);

        // Инжектируем перехватчик выбора источников (теперь он будет работать вместе с основным кодом)
        await this.state.window.webContents.executeJavaScript(`
            ${this.getScreenShareInterceptorCode()}
        `);

        // Добавляем кнопку native stream
        await this.state.window.webContents.executeJavaScript(`
            ${this.getNativeStreamButtonCode()}
        `);

        log.info("✅ Handlers injected successfully");

    } catch (error: any) {
        log.error(`Failed to inject handlers: ${error.message}`);
    }
  }

  private getNativeStreamButtonCode(): string {
    return `
      (function() {
        const button = document.createElement('button');
        button.id = 'native-stream-button';
        button.textContent = '🎯 Start Native Stream';
        button.style.cssText = \`
          position: fixed;
          top: 80px;
          right: 20px;
          z-index: 100000;
          padding: 10px 20px;
          background: linear-gradient(135deg, #4CAF50, #66BB6A);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3);
        \`;
        
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = '⏳ Starting...';
          
          try {
            const result = await window.ipcRenderer.invoke('jitsi:inject-native-stream');
            
            if (result.success) {
              button.textContent = '✅ Native Stream Active';
              button.style.background = 'linear-gradient(135deg, #66BB6A, #4CAF50)';
            } else {
              button.textContent = '❌ Failed';
              button.style.background = '#f44336';
              console.error('Failed to start native stream:', result.error);
            }
          } catch (error) {
            button.textContent = '❌ Error';
            button.style.background = '#f44336';
            console.error('Error:', error);
          }
        };
        
        document.body.appendChild(button);
      })();
    `;
  }

  // Вспомогательный метод для показа системного диалога
  private async showSystemPicker(): Promise<{ success: boolean; sourceId?: string }> {
    try {
        // Используем Electron's desktopCapturer как fallback
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 300, height: 200 }
        });
        
        if (sources.length === 0) {
            return { success: false };
        }
        
        // Для простоты берем первый экран
        const screen = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        
        log.info(`System picker: selected ${screen.id}`);
        return { success: true, sourceId: screen.id };
        
    } catch (error: any) {
        log.error(`System picker error: ${error.message}`);
        return { success: false };
    }
  }

  async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No active Jitsi window" };
        }

        try {
            log.info("Creating and injecting native stream into Jitsi...");
        
            const sourceId = this.state.lastSelectedSourceId || 'screen:2077748985:0';
            log.info(`Starting capture for source: ${sourceId}`);
            
            // Выбираем качество для захвата
            const qualityPreset = 'ULTRALOW'; // ULTRALOW, LOW, MEDIUM, HIGH, ULTRAHIGH, PRESENTATION, SCREENSHARE
            await this.nativeCapture.useQualityPreset(qualityPreset);
            
            log.info(`Using quality preset: ${qualityPreset}`);
            
            // Сохраняем пресет в state
            this.state.qualityPreset = qualityPreset;

            const capturePromise = this.nativeCapture.startCapture(sourceId);
            const timeoutPromise = new Promise<{ success: boolean; error: string }>((resolve) => {
                setTimeout(() => {
                    resolve({ success: false, error: 'Capture start timeout after 5 seconds' });
                }, 5000);
            });
            
            // Race между запуском и таймаутом
            const captureResult = await Promise.race([capturePromise, timeoutPromise]);
            
            if (!captureResult.success) {
                log.error(`Failed to start capture: ${captureResult.error}`);
                
                // Если не удалось с выбранным источником, пробуем с диалогом
                if (captureResult.error.includes('timeout') || captureResult.error.includes('setCaptureSource')) {
                    log.info("Trying alternative: showing system picker...");
                    
                    // Показываем встроенный диалог выбора
                    const pickerResult = await this.showSystemPicker();
                    if (!pickerResult.success) {
                        return { success: false, error: 'User cancelled or picker failed' };
                    }
                    
                    // Пробуем еще раз с выбранным источником
                    const retryResult = await this.nativeCapture.startCapture(pickerResult.sourceId!);
                    if (!retryResult.success) {
                        return { success: false, error: retryResult.error };
                    }
                } else {
                    return { success: false, error: captureResult.error };
                }
            }
            
            log.info("Native capture started successfully");
            
            // Теперь создаем MediaStream в Jitsi и подключаем callbacks
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[NativeStream] Creating native stream with capture...');
                    
                    if (window.jitsiNativeMediaStream instanceof MediaStream && window.isNativeActive) {
                        console.log('[NativeStream] MediaStream already exists');
                        return { 
                            success: true, 
                            streamId: window.jitsiNativeMediaStream.id,
                            message: 'Stream already active'
                        };
                    }
                    
                    try {
                        // === СОЗДАЕМ CANVAS ДЛЯ ВИДЕО ===
                        const canvas = document.createElement('canvas');
                        canvas.width = 1920;
                        canvas.height = 1080;
                        canvas.style.display = 'none';
                        canvas.id = 'native-stream-canvas';
                        document.body.appendChild(canvas);
                        
                        const ctx = canvas.getContext('2d', {
                            alpha: false,
                            desynchronized: true,
                            willReadFrequently: false
                        });
                        
                        if (!ctx) {
                            throw new Error('Failed to get canvas context');
                        }
                        
                        // === СОЗДАЕМ AUDIO CONTEXT С ПРАВИЛЬНОЙ ЧАСТОТОЙ ===
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)({
                            sampleRate: 48000,  // ВАЖНО: Должно совпадать с источником
                            latencyHint: 'interactive'
                        });
                        
                        // КРИТИЧНО: Используем правильный размер буфера
                        // 960 сэмплов при 48kHz = 20ms (совпадает с частотой кадров от Swift)
                        const SAMPLES_PER_FRAME = 960;
                        const bufferSize = 2048; // Ближайшая степень 2 к 960
                        
                        // Создаем ScriptProcessor с правильным размером
                        const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 0, 2);
                        
                        // Кольцевой буфер для точной синхронизации
                        class RingBuffer {
                            constructor(size) {
                                this.buffer = new Float32Array(size);
                                this.writeIndex = 0;
                                this.readIndex = 0;
                                this.availableSamples = 0;
                                this.size = size;
                            }
                            
                            write(data) {
                                for (let i = 0; i < data.length; i++) {
                                    this.buffer[this.writeIndex] = data[i];
                                    this.writeIndex = (this.writeIndex + 1) % this.size;
                                    this.availableSamples = Math.min(this.availableSamples + 1, this.size);
                                }
                            }
                            
                            read(output) {
                                const samplesToRead = Math.min(output.length, this.availableSamples);
                                
                                for (let i = 0; i < samplesToRead; i++) {
                                    output[i] = this.buffer[this.readIndex];
                                    this.readIndex = (this.readIndex + 1) % this.size;
                                }
                                
                                // Заполняем остаток тишиной
                                for (let i = samplesToRead; i < output.length; i++) {
                                    output[i] = 0;
                                }
                                
                                this.availableSamples = Math.max(0, this.availableSamples - samplesToRead);
                                return samplesToRead;
                            }
                            
                            getAvailable() {
                                return this.availableSamples;
                            }
                            
                            reset() {
                                this.writeIndex = 0;
                                this.readIndex = 0;
                                this.availableSamples = 0;
                                this.buffer.fill(0);
                            }
                        }
                        
                        // Создаем кольцевые буферы для каждого канала
                        const leftRingBuffer = new RingBuffer(48000); // 1 секунда буфер
                        const rightRingBuffer = new RingBuffer(48000);
                        
                        // Переменные для синхронизации
                        let lastAudioTime = 0;
                        let audioStartTime = 0;
                        let framesProcessed = 0;
                        
                        // Обработчик ScriptProcessor
                        scriptProcessor.onaudioprocess = (event) => {
                            if (!window.isNativeActive) {
                                event.outputBuffer.getChannelData(0).fill(0);
                                event.outputBuffer.getChannelData(1).fill(0);
                                return;
                            }
                            
                            const outputL = event.outputBuffer.getChannelData(0);
                            const outputR = event.outputBuffer.getChannelData(1);
                            
                            // Читаем из кольцевых буферов
                            const samplesRead = leftRingBuffer.read(outputL);
                            rightRingBuffer.read(outputR);
                            
                            // Отладка синхронизации каждые 100 фреймов
                            framesProcessed++;
                            if (framesProcessed % 100 === 0) {
                                const bufferLatency = leftRingBuffer.getAvailable() / 48000 * 1000; // в мс
                                if (bufferLatency > 100) {
                                    console.log('[Audio] Warning: Buffer latency:', bufferLatency.toFixed(0), 'ms');
                                    // Если накопилось слишком много - пропускаем часть
                                    if (bufferLatency > 200) {
                                        const samplesToSkip = Math.floor((bufferLatency - 50) * 48);
                                        leftRingBuffer.readIndex = (leftRingBuffer.readIndex + samplesToSkip) % leftRingBuffer.size;
                                        rightRingBuffer.readIndex = (rightRingBuffer.readIndex + samplesToSkip) % rightRingBuffer.size;
                                        leftRingBuffer.availableSamples = Math.max(0, leftRingBuffer.availableSamples - samplesToSkip);
                                        rightRingBuffer.availableSamples = Math.max(0, rightRingBuffer.availableSamples - samplesToSkip);
                                        console.log('[Audio] Skipped', samplesToSkip, 'samples to reduce latency');
                                    }
                                }
                            }
                        };
                        
                        // Создаем destination
                        const destination = audioContext.createMediaStreamDestination();
                        scriptProcessor.connect(destination);
                        
                        // === СОЗДАЕМ STREAM ===
                        const stream = canvas.captureStream(30);
                        
                        // Добавляем аудио трек
                        if (destination.stream.getAudioTracks().length > 0) {
                            stream.addTrack(destination.stream.getAudioTracks()[0]);
                            console.log('[NativeStream] Audio track added');
                        }
                        
                        console.log('[NativeStream] Stream created with', stream.getTracks().length, 'tracks');
                        
                        // === СОХРАНЯЕМ ===
                        window.jitsiNativeMediaStream = stream;
                        window.nativeCanvas = canvas;
                        window.nativeCtx = ctx;
                        window.nativeAudioContext = audioContext;
                        window.leftRingBuffer = leftRingBuffer;
                        window.rightRingBuffer = rightRingBuffer;
                        window.isNativeActive = true;
                        window.frameCounter = 0;
                        window.audioCounter = 0;
                        window.audioDropped = 0;
                        
                        // === ФУНКЦИЯ ОБНОВЛЕНИЯ ВИДЕО (без изменений) ===
                        window.updateNativeVideo = function(frameData) {
                            if (!window.isNativeActive || !ctx) return;
                            
                            window.frameCounter = (window.frameCounter || 0) + 1;
                            
                            try {
                                if (frameData && frameData.data && frameData.width && frameData.height) {
                                    if (canvas.width !== frameData.width || canvas.height !== frameData.height) {
                                        canvas.width = frameData.width;
                                        canvas.height = frameData.height;
                                    }
                                    
                                    const imageData = new ImageData(
                                        new Uint8ClampedArray(frameData.data),
                                        frameData.width,
                                        frameData.height
                                    );
                                    
                                    ctx.putImageData(imageData, 0, 0);
                                }
                            } catch (error) {
                                console.error('[NativeStream] Error updating video:', error);
                            }
                        };
                        
                        // === ФУНКЦИЯ ДОБАВЛЕНИЯ АУДИО С СИНХРОНИЗАЦИЕЙ ===
                        window.addNativeSystemAudio = function(audioData) {
                            if (!window.isNativeActive || !audioData) return;
                            
                            window.audioCounter = (window.audioCounter || 0) + 1;
                            
                            if (audioData.left && audioData.right) {
                                const currentTime = performance.now();
                                
                                // Инициализация времени
                                if (!window.audioStartTime) {
                                    window.audioStartTime = currentTime;
                                    window.lastAudioTime = currentTime;
                                    console.log('[NativeStream] Audio sync started');
                                }
                                
                                // Записываем напрямую в кольцевые буферы без дополнительной обработки
                                // Данные уже обработаны на стороне Electron
                                window.leftRingBuffer.write(audioData.left);
                                window.rightRingBuffer.write(audioData.right);
                                
                                window.lastAudioTime = currentTime;
                                
                                // Логирование
                                if (window.audioCounter === 1) {
                                    console.log('[NativeStream] ✅ First audio frame added');
                                    const maxL = Math.max(...audioData.left.slice(0, 100));
                                    const maxR = Math.max(...audioData.right.slice(0, 100));
                                    console.log('[NativeStream] Input levels:', maxL.toFixed(4), maxR.toFixed(4));
                                }
                                
                                if (window.audioCounter % 100 === 0) {
                                    const bufferMs = window.leftRingBuffer.getAvailable() / 48;
                                    console.log('[Audio] Frames:', window.audioCounter, 'Buffer:', bufferMs.toFixed(0), 'ms');
                                }
                            }
                        };
                        
                        console.log('[NativeStream] Ring buffer audio system initialized');
                        
                        // Запускаем audio context
                        if (audioContext.state === 'suspended') {
                            await audioContext.resume();
                            console.log('[NativeStream] Audio context resumed');
                        }
                        
                        return { 
                            success: true, 
                            streamId: stream.id,
                            message: 'Native MediaStream created with synchronized audio'
                        };
                        
                    } catch (error) {
                        console.error('[NativeStream] Error:', error);
                        return { 
                            success: false, 
                            error: error.message 
                        };
                    }
                })();
            `);
            
            if (!result.success) {
                // Останавливаем capture если stream не создался
                await this.nativeCapture.stopCapture();
                return result;
            }
            
            this.nativeCapture.setFrameCallbacks(
                // Video callback - упрощенная версия без лишних преобразований
                (videoData: any) => {
                    if (!this.state.window || this.state.window.isDestroyed()) return;
                    
                    try {
                        if (!videoData || !videoData.data) return;
                        
                        this.state.videoFrameCount = (this.state.videoFrameCount || 0) + 1;
                        
                        const width = videoData.width || 1920;
                        const height = videoData.height || 1080;
                        
                        // Получаем пиксели
                        let pixelArray: Uint8Array;
                        if (videoData.data.byteLength !== undefined) {
                            pixelArray = new Uint8Array(videoData.data);
                        } else if (Buffer.isBuffer(videoData.data)) {
                            pixelArray = new Uint8Array(videoData.data);
                        } else {
                            return;
                        }
                        
                        // ВАЖНО: НЕ меняем порядок байтов здесь!
                        // Swift уже отдает в правильном формате BGRA
                        
                        // Передаем в Jitsi через base64
                        const base64Data = Buffer.from(pixelArray).toString('base64');
                        
                        const jsCode = `
                            (function() {
                                if (!window.updateNativeVideo || !window.isNativeActive) return;
                                
                                try {
                                    // Декодируем base64
                                    const binaryString = atob('${base64Data}');
                                    const len = binaryString.length;
                                    const bytes = new Uint8Array(len);
                                    
                                    for (let i = 0; i < len; i++) {
                                        bytes[i] = binaryString.charCodeAt(i);
                                    }
                                    
                                    // Конвертируем BGRA в RGBA для canvas
                                    const rgbaData = new Uint8ClampedArray(len);
                                    for (let i = 0; i < len; i += 4) {
                                        rgbaData[i] = bytes[i + 2];     // R (from B position)
                                        rgbaData[i + 1] = bytes[i + 1]; // G
                                        rgbaData[i + 2] = bytes[i];     // B (from R position)
                                        rgbaData[i + 3] = bytes[i + 3]; // A
                                    }
                                    
                                    window.updateNativeVideo({
                                        data: rgbaData,
                                        width: ${width},
                                        height: ${height}
                                    });
                                    
                                } catch (e) {
                                    console.error('[NativeStream] Video error:', e);
                                }
                            })();
                        `;
                        
                        this.state.window.webContents.executeJavaScript(jsCode).catch(() => {});
                        
                        if (this.state.videoFrameCount === 1) {
                            log.info("✅ First video frame sent");
                        }
                        
                    } catch (error: any) {
                        log.error(`Error in video callback: ${error.message}`);
                    }
                },
                
                // Audio callback - исправленная обработка PCM данных
                (audioData: any) => {
                    if (!this.state.window || this.state.window.isDestroyed()) return;
                    
                    try {
                        if (!audioData || !audioData.data || audioData.source !== 'system') {
                            return;
                        }
                        
                        this.state.audioFrameCount = (this.state.audioFrameCount || 0) + 1;
                        
                        const arrayBuffer = audioData.data;
                        const samples = audioData.numSamples || 960;
                        const channels = audioData.channels || 2;
                        
                        // КРИТИЧНО: Swift отправляет данные в особом формате
                        // Format 1819304813 = kAudioFormatLinearPCM
                        // Но данные могут быть в нестандартном порядке
                        
                        if (this.state.audioFrameCount === 1) {
                            log.info("Analyzing Swift audio data structure:");
                            log.info("- Buffer size:", arrayBuffer.byteLength, "bytes");
                            log.info("- Samples:", samples);
                            log.info("- Channels:", channels);
                            log.info("- Expected size for Float32:", samples * channels * 4);
                            log.info("- Expected size for Int16:", samples * channels * 2);
                            
                            // Анализируем структуру данных
                            const view = new DataView(arrayBuffer);
                            const uint8Array = new Uint8Array(arrayBuffer);
                            
                            // Проверяем паттерны в данных
                            let nonZeroBytes = 0;
                            for (let i = 0; i < Math.min(100, uint8Array.length); i++) {
                                if (uint8Array[i] !== 0) nonZeroBytes++;
                            }
                            log.info("Non-zero bytes in first 100:", nonZeroBytes);
                            
                            // Проверяем разные интерпретации
                            for (let offset = 0; offset < 32 && offset < arrayBuffer.byteLength - 4; offset += 4) {
                                const asFloat32LE = view.getFloat32(offset, true);
                                const asFloat32BE = view.getFloat32(offset, false);
                                const asInt32LE = view.getInt32(offset, true);
                                
                                if (Math.abs(asFloat32LE) > 0.00001 && Math.abs(asFloat32LE) < 1.0) {
                                    log.info(`Offset ${offset}: Float32LE = ${asFloat32LE}`);
                                }
                            }
                        }
                        
                        // ВАЖНО: Попробуем другой подход к декодированию
                        // Swift может отправлять данные как Int16 или как специальный формат
                        
                        let leftChannel: Float32Array;
                        let rightChannel: Float32Array;
                        
                        // Проверяем размер - если 7680 байт для 960 сэмплов стерео
                        // То это 7680 / (960 * 2) = 4 байта на сэмпл = Float32
                        
                        if (arrayBuffer.byteLength === samples * channels * 4) {
                            // Float32 формат, но возможно не в стандартном порядке
                            const dataView = new DataView(arrayBuffer);
                            leftChannel = new Float32Array(samples);
                            rightChannel = new Float32Array(samples);
                            
                            // Пробуем правильный деинтерливинг для Swift/CoreAudio
                            // CoreAudio может использовать non-interleaved (планарный) формат
                            
                            // Вариант 1: Планарный формат (все левые сэмплы, затем все правые)
                            const halfSize = arrayBuffer.byteLength / 2;
                            let hasValidData = false;
                            
                            // Пробуем планарный формат
                            for (let i = 0; i < samples; i++) {
                                leftChannel[i] = dataView.getFloat32(i * 4, true);
                                rightChannel[i] = dataView.getFloat32(halfSize + i * 4, true);
                                
                                if (Math.abs(leftChannel[i]) > 0.00001 || Math.abs(rightChannel[i]) > 0.00001) {
                                    hasValidData = true;
                                }
                            }
                            
                            if (!hasValidData) {
                                // Вариант 2: Интерливд формат (L0, R0, L1, R1, ...)
                                for (let i = 0; i < samples; i++) {
                                    leftChannel[i] = dataView.getFloat32(i * 8, true);      // i*8 = i*2*4
                                    rightChannel[i] = dataView.getFloat32(i * 8 + 4, true); // следующие 4 байта
                                    
                                    if (Math.abs(leftChannel[i]) > 0.00001 || Math.abs(rightChannel[i]) > 0.00001) {
                                        hasValidData = true;
                                    }
                                }
                            }
                            
                            // Если все еще тишина, возможно данные в другом endianness
                            if (!hasValidData) {
                                for (let i = 0; i < samples; i++) {
                                    leftChannel[i] = dataView.getFloat32(i * 8, false);      // big-endian
                                    rightChannel[i] = dataView.getFloat32(i * 8 + 4, false);
                                }
                            }
                            
                        } else if (arrayBuffer.byteLength === samples * channels * 2) {
                            // Int16 формат
                            const dataView = new DataView(arrayBuffer);
                            leftChannel = new Float32Array(samples);
                            rightChannel = new Float32Array(samples);
                            
                            for (let i = 0; i < samples; i++) {
                                leftChannel[i] = dataView.getInt16(i * 4, true) / 32768.0;
                                rightChannel[i] = dataView.getInt16(i * 4 + 2, true) / 32768.0;
                            }
                        } else {
                            log.error(`Unexpected buffer size: ${arrayBuffer.byteLength}`);
                            return;
                        }
                        
                        // Анализ данных
                        let maxLeft = 0, maxRight = 0;
                        let validSamples = 0;
                        
                        for (let i = 0; i < samples; i++) {
                            const absL = Math.abs(leftChannel[i]);
                            const absR = Math.abs(rightChannel[i]);
                            
                            maxLeft = Math.max(maxLeft, absL);
                            maxRight = Math.max(maxRight, absR);
                            
                            if (absL > 0.00001 || absR > 0.00001) {
                                validSamples++;
                            }
                        }
                        
                        const hasAudio = validSamples > 0;
                        
                        if (this.state.audioFrameCount === 1 || this.state.audioFrameCount % 50 === 0) {
                            log.info(`Audio: Frame ${this.state.audioFrameCount}, ` +
                                    `Max L=${maxLeft.toFixed(4)} R=${maxRight.toFixed(4)}, ` +
                                    `Valid samples: ${validSamples}/${samples}`);
                            
                            if (this.state.audioFrameCount === 1 && hasAudio) {
                                // Логируем первые не-нулевые сэмплы
                                for (let i = 0; i < Math.min(10, samples); i++) {
                                    if (Math.abs(leftChannel[i]) > 0.00001) {
                                        log.info(`First non-zero at index ${i}: L=${leftChannel[i]}, R=${rightChannel[i]}`);
                                        break;
                                    }
                                }
                            }
                        }
                        
                        // Обработка только если есть звук
                        const processedLeft = new Float32Array(samples);
                        const processedRight = new Float32Array(samples);
                        
                        if (hasAudio) {
                            // Минимальная обработка - только нормализация уровня
                            const targetPeak = 0.7;
                            const currentPeak = Math.max(maxLeft, maxRight);
                            const gain = currentPeak > 0.001 ? Math.min(targetPeak / currentPeak, 3.0) : 1.0;
                            
                            for (let i = 0; i < samples; i++) {
                                processedLeft[i] = Math.max(-1, Math.min(1, leftChannel[i] * gain));
                                processedRight[i] = Math.max(-1, Math.min(1, rightChannel[i] * gain));
                            }
                            
                            if (this.state.audioFrameCount === 1) {
                                log.info(`Audio gain applied: ${gain.toFixed(2)}x`);
                            }
                        } else {
                            processedLeft.set(leftChannel);
                            processedRight.set(rightChannel);
                        }
                        
                        // Передаем в Jitsi с правильной частотой
                        const jsCode = `
                            (function() {
                                if (!window.isNativeActive || !window.leftRingBuffer || !window.rightRingBuffer) return;
                                
                                try {
                                    const samples = ${samples};
                                    const leftData = [${Array.from(processedLeft).join(',')}];
                                    const rightData = [${Array.from(processedRight).join(',')}];
                                    
                                    const leftFloat = new Float32Array(leftData);
                                    const rightFloat = new Float32Array(rightData);
                                    
                                    // ВАЖНО: Проверяем частоту дискретизации
                                    if (window.nativeAudioContext.sampleRate !== 48000) {
                                        console.warn('[Audio] Sample rate mismatch:', window.nativeAudioContext.sampleRate);
                                    }
                                    
                                    // Записываем в кольцевой буфер
                                    window.leftRingBuffer.write(leftFloat);
                                    window.rightRingBuffer.write(rightFloat);
                                    
                                    // Отладка первого фрейма с данными
                                    if (!window.firstAudioLogged && Math.max(...leftData) > 0.001) {
                                        console.log('[Audio] First audio data received');
                                        console.log('[Audio] Max levels:', Math.max(...leftData).toFixed(4), Math.max(...rightData).toFixed(4));
                                        console.log('[Audio] Sample rate:', window.nativeAudioContext.sampleRate);
                                        window.firstAudioLogged = true;
                                    }
                                    
                                    window.audioCounter = (window.audioCounter || 0) + 1;
                                    if (window.audioCounter % 100 === 0) {
                                        const bufferMs = window.leftRingBuffer.getAvailable() / 48;
                                        console.log('[Audio] Frames:', window.audioCounter, 'Buffer:', bufferMs.toFixed(0), 'ms');
                                    }
                                    
                                } catch (e) {
                                    console.error('[Audio] Error:', e);
                                }
                            })();
                        `;
                        
                        this.state.window.webContents.executeJavaScript(jsCode).catch(() => {});
                        
                    } catch (error: any) {
                        log.error(`Error in audio callback: ${error.message}`);
                    }
                }
            );

            log.info(`Native capture callbacks configured to pass through Swift quality settings`);

            // Добавляем счетчики в state
            if (!this.state.videoFrameCount) this.state.videoFrameCount = 0;
            if (!this.state.audioFrameCount) this.state.audioFrameCount = 0;

            log.info("Native capture callbacks connected with correct data processing");
            
            log.info(`✅ Native stream created with ID: ${result.streamId}`);
            log.info("Native capture callbacks connected");
            
            this.state.isStreamActive = true;
            this.state.streamId = result.streamId;
            
            return result;
            
        } catch (error: any) {
            log.error(`Exception in injectNativeStream: ${error.message}`);
            log.error(`Stack: ${error.stack}`);
            
            // Cleanup
            try {
                await this.nativeCapture.stopCapture();
            } catch (cleanupError) {
                log.error(`Cleanup error: ${cleanupError}`);
            }
            
            return { success: false, error: error.message };
        }
  }

  async handleSourceSelection(sourceId: string): void {
    this.state.lastSelectedSourceId = sourceId;
    log.info(`Saved selected source: ${sourceId}`);
  }

  async sendSourcesToWindow(sources: any[]): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) {
        log.warn("No Jitsi window to send sources to");
        return;
    }

    try {
        await this.state.window.webContents.executeJavaScript(`
            (function() {
                console.log('🔍 Received ${sources.length} sources in Jitsi');
                
                // Сохраняем источники глобально
                window._availableSources = ${JSON.stringify(sources)};
                
                // Если есть ожидающий колбэк для выбора источников
                if (window._pendingSourcesCallback) {
                    console.log('Found pending sources callback, showing picker...');
                    
                    // Показываем диалог выбора
                    showSourcePicker(window._availableSources, (selectedId) => {
                        console.log('User selected source:', selectedId);
                        
                        const selectedSource = window._availableSources.find(s => s.id === selectedId);
                        window._lastSelectedSourceIsNative = selectedSource?.isNative || false;
                        
                        if (window._pendingSourcesCallback) {
                            window._pendingSourcesCallback(selectedId, {
                                audio: true,
                                screenShareAudio: true
                            });
                            window._pendingSourcesCallback = null;
                        }
                    });
                }
                
                // Функция показа диалога выбора источников
                function showSourcePicker(sources, callback) {
                    // Удаляем предыдущий диалог если есть
                    const existing = document.getElementById('source-picker-overlay');
                    if (existing) existing.remove();
                    
                    const overlay = document.createElement('div');
                    overlay.id = 'source-picker-overlay';
                    overlay.style.cssText = \`
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0, 0, 0, 0.85);
                        z-index: 10000;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        backdrop-filter: blur(5px);
                    \`;
                    
                    const dialog = document.createElement('div');
                    dialog.style.cssText = \`
                        background: white;
                        border-radius: 16px;
                        padding: 32px;
                        max-width: 90%;
                        max-height: 80%;
                        overflow: auto;
                        min-width: 700px;
                        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                    \`;
                    
                    let htmlContent = \`
                        <h2 style="margin-top: 0; color: #333; font-size: 24px;">
                            Выберите экран или окно для демонстрации
                        </h2>
                        <div style="
                            display: grid; 
                            grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); 
                            gap: 20px; 
                            margin: 24px 0;
                        ">
                    \`;
                    
                    sources.forEach((source, index) => {
                        const isNative = source.isNative || false;
                        const borderColor = isNative ? '#4CAF50' : '#2196F3';
                        
                        htmlContent += \`
                            <div class="source-item" data-source-id="\${source.id}" style="
                                border: 3px solid #e0e0e0;
                                border-radius: 12px;
                                padding: 16px;
                                cursor: pointer;
                                text-align: center;
                                background: white;
                                position: relative;
                                transition: all 0.3s;
                            " onmouseover="this.style.borderColor='\${borderColor}'; this.style.transform='scale(1.05)';" 
                            onmouseout="this.style.borderColor='#e0e0e0'; this.style.transform='scale(1)';">
                                \${isNative ? \`
                                    <div style="
                                        position: absolute;
                                        top: 10px;
                                        right: 10px;
                                        background: #4CAF50;
                                        color: white;
                                        padding: 4px 8px;
                                        border-radius: 6px;
                                        font-size: 12px;
                                        font-weight: bold;
                                    ">NATIVE</div>
                                \` : ''}
                                <img src="\${source.thumbnail?.dataUrl || ''}" style="
                                    width: 100%; 
                                    height: 160px; 
                                    object-fit: contain; 
                                    margin-bottom: 12px;
                                    border-radius: 8px;
                                    background: #f5f5f5;
                                ">
                                <div style="
                                    font-size: 14px; 
                                    color: #666; 
                                    word-wrap: break-word;
                                    font-weight: 500;
                                ">\${source.name || 'Unknown'}</div>
                            </div>
                        \`;
                    });
                    
                    htmlContent += \`
                        </div>
                        <div style="text-align: center; margin-top: 24px;">
                            <button id="cancel-picker-btn" style="
                                background: #f44336;
                                color: white;
                                border: none;
                                padding: 12px 32px;
                                border-radius: 8px;
                                cursor: pointer;
                                font-size: 16px;
                                font-weight: 500;
                            ">Отмена</button>
                        </div>
                    \`;
                    
                    dialog.innerHTML = htmlContent;
                    overlay.appendChild(dialog);
                    document.body.appendChild(overlay);
                    
                    // Обработчики кликов
                    overlay.onclick = function(e) {
                        e.stopPropagation();
                        
                        const sourceItem = e.target.closest('.source-item');
                        if (sourceItem) {
                            const sourceId = sourceItem.dataset.sourceId;
                            overlay.remove();
                            callback(sourceId);
                            return;
                        }
                        
                        if (e.target.id === 'cancel-picker-btn' || e.target === overlay) {
                            overlay.remove();
                            return;
                        }
                    };
                    
                    // Escape для закрытия
                    const handleEscape = function(e) {
                        if (e.key === 'Escape') {
                            overlay.remove();
                            document.removeEventListener('keydown', handleEscape);
                        }
                    };
                    document.addEventListener('keydown', handleEscape);
                }
                
                return { success: true, count: ${sources.length} };
            })();
        `);
        
        log.info(`Sent ${sources.length} sources to Jitsi window`);
        
    } catch (error: any) {
        log.error(`Failed to send sources to Jitsi: ${error.message}`);
    }
  }

  async getStatus(): Promise<any> {
    return {
        hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
        isStreamActive: this.state.isStreamActive,
        streamId: this.state.streamId
    };
  }

  async triggerScreenShare(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;
    
    try {
        await this.state.window.webContents.executeJavaScript(`
        (async function() {
            console.log('[Trigger] Attempting to start screen share...');
            
            // Проверяем что native stream готов
            if (!window.jitsiNativeMediaStream || !window.isNativeActive) {
            console.error('[Trigger] Native stream not ready');
            return { success: false, error: 'Native stream not ready' };
            }
            
            // Способ 1: APP.conference.toggleScreenSharing
            if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
            console.log('[Trigger] Using APP.conference.toggleScreenSharing');
            try {
                await window.APP.conference.toggleScreenSharing();
                return { success: true, method: 'APP.conference' };
            } catch (e) {
                console.error('[Trigger] APP.conference method failed:', e);
            }
            }
            
            // Способ 2: Создание desktop трека
            if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
            console.log('[Trigger] Using JitsiMeetJS.createLocalTracks');
            try {
                const tracks = await window.JitsiMeetJS.createLocalTracks({ 
                devices: ['desktop'],
                desktopSharingSourceDevice: 'screen'
                });
                console.log('[Trigger] Created tracks:', tracks.length);
                return { success: true, method: 'JitsiMeetJS', tracks: tracks.length };
            } catch (e) {
                console.error('[Trigger] JitsiMeetJS method failed:', e);
            }
            }
            
            // Способ 3: Программный клик
            console.log('[Trigger] Trying button click...');
            const selectors = [
            '[aria-label*="screen" i]',
            '[aria-label*="share" i]', 
            '[aria-label*="desktop" i]',
            '[data-testid*="screen" i]',
            'button[title*="Share" i]',
            '.toolbox-button[aria-label*="screen" i]'
            ];
            
            for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button) {
                console.log('[Trigger] Found button with selector:', selector);
                
                // Проверяем состояние кнопки
                const isActive = button.classList.contains('toggled') || 
                            button.classList.contains('active') ||
                            button.getAttribute('aria-pressed') === 'true';
                
                if (!isActive) {
                console.log('[Trigger] Clicking share button');
                button.click();
                
                // Дополнительно эмулируем события
                const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                });
                button.dispatchEvent(clickEvent);
                
                return { success: true, method: 'button click', selector };
                } else {
                console.log('[Trigger] Button already active');
                return { success: false, error: 'Already sharing' };
                }
            }
            }
            
            console.error('[Trigger] No method worked');
            return { success: false, error: 'No method available' };
        })();
        `);
        
        log.info("Screen share trigger attempted");
        
    } catch (error: any) {
        log.error(`Failed to trigger screen share: ${error.message}`);
    }
  }

  private getScreenShareInterceptorCode(): string {
    return `
        (function() {
        console.log('[JitsiManager] Installing screen share interceptor...');
        
        let isIntercepted = false;
        let pendingSourcesCallback = null;
        
        // Ждем загрузки Jitsi API
        function waitForJitsiAPI() {
            return new Promise((resolve) => {
            let attempts = 0;
            const checkInterval = setInterval(() => {
                attempts++;
                
                // Проверяем наличие JitsiMeetScreenObtainer
                if (window.JitsiMeetScreenObtainer && 
                    typeof window.JitsiMeetScreenObtainer.openDesktopPicker === 'function') {
                clearInterval(checkInterval);
                console.log('[JitsiManager] JitsiMeetScreenObtainer found after', attempts, 'attempts');
                resolve(true);
                } else if (attempts > 100) { // Увеличиваем количество попыток
                clearInterval(checkInterval);
                console.error('[JitsiManager] JitsiMeetScreenObtainer not found');
                resolve(false);
                }
            }, 100);
            });
        }
        
        waitForJitsiAPI().then(ready => {
            if (!ready) {
            console.error('[JitsiManager] Failed to find Jitsi API');
            return;
            }
            
            // Сохраняем оригинальный метод
            const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
            console.log('[JitsiManager] Original openDesktopPicker saved');
            
            // Перехватываем openDesktopPicker
            window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
            console.log('[JitsiManager] ✅ Desktop picker INTERCEPTED!', options);
            
            if (isIntercepted) {
                console.log('[JitsiManager] Already processing, skipping...');
                return;
            }
            
            isIntercepted = true;
            pendingSourcesCallback = callback;
            
            // Запрашиваем источники через IPC
            if (window.ipcRenderer) {
                console.log('[JitsiManager] Requesting sources via IPC...');
                
                window.ipcRenderer.invoke('get-desktop-sources').then(sources => {
                console.log('[JitsiManager] Got', sources.length, 'sources from main process');
                isIntercepted = false;
                
                if (sources && sources.length > 0) {
                    // Показываем диалог выбора источника
                    showSourcePicker(sources, (selectedId) => {
                    console.log('[JitsiManager] User selected source:', selectedId);
                    
                    const selectedSource = sources.find(s => s.id === selectedId);
                    
                    // Проверяем, это native источник?
                    if (selectedSource && selectedSource.isNative) {
                        console.log('[JitsiManager] 🎯 NATIVE source selected, starting native stream...');
                        
                        // Запускаем native stream
                        startNativeStreamForSource(selectedId, callback);
                    } else {
                        console.log('[JitsiManager] Standard source selected');
                        // Для обычных источников используем стандартный механизм
                        if (callback) {
                        callback(selectedId, { audio: true });
                        }
                    }
                    });
                } else {
                    console.error('[JitsiManager] No sources received');
                    isIntercepted = false;
                    // Fallback на оригинальный метод
                    originalOpenDesktopPicker.call(this, options, callback);
                }
                }).catch(error => {
                console.error('[JitsiManager] Error getting sources:', error);
                isIntercepted = false;
                originalOpenDesktopPicker.call(this, options, callback);
                });
            } else {
                console.error('[JitsiManager] ipcRenderer not available');
                isIntercepted = false;
                originalOpenDesktopPicker.call(this, options, callback);
            }
            };
            
            console.log('[JitsiManager] ✅ Screen share interceptor installed successfully');
        });
        
        // Функция для запуска native stream
        async function startNativeStreamForSource(sourceId, callback) {
            console.log('[JitsiManager] Starting native stream for source:', sourceId);
            
            try {
                // ВАЖНО: Передаем sourceId в main процесс для сохранения
                await window.ipcRenderer.invoke('jitsi:save-selected-source', sourceId);
                
                // Создаем native stream с захватом
                const result = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                
                if (result.success) {
                    console.log('[JitsiManager] Native stream created successfully');
                    
                    // Вызываем callback чтобы закрыть диалог
                    if (callback) {
                        callback(sourceId, { audio: true, screenShareAudio: true });
                    }
                    
                    // Ждем и запускаем демонстрацию
                    setTimeout(async () => {
                        console.log('[JitsiManager] Starting screen share...');
                        
                        // Метод 1: Redux dispatch
                        if (window.APP && window.APP.store) {
                            try {
                                const state = window.APP.store.getState();
                                const isSharing = state['features/base/tracks']?.some(
                                    track => track.videoType === 'desktop' && track.local
                                );
                                
                                if (!isSharing) {
                                    window.APP.store.dispatch({
                                        type: 'TOGGLE_SCREENSHARING'
                                    });
                                    console.log('[JitsiManager] Dispatched TOGGLE_SCREENSHARING');
                                }
                            } catch (e) {
                                console.error('[JitsiManager] Redux dispatch failed:', e);
                            }
                        }
                        
                        // Метод 2: Прямой вызов createLocalTracks
                        else if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                            try {
                                console.log('[JitsiManager] Creating desktop track...');
                                const tracks = await window.JitsiMeetJS.createLocalTracks({ 
                                    devices: ['desktop']
                                });
                                console.log('[JitsiManager] Desktop track created');
                            } catch (e) {
                                console.error('[JitsiManager] createLocalTracks failed:', e);
                            }
                        }
                    }, 1500);
                    
                } else {
                    console.error('[JitsiManager] Failed to create native stream:', result.error);
                    if (callback) {
                        callback(sourceId, { audio: true });
                    }
                }
            } catch (error) {
                console.error('[JitsiManager] Error:', error);
                if (callback) {
                    callback(sourceId, { audio: true });
                }
            }
        }

        
        
        // Функция показа диалога выбора источника
        function showSourcePicker(sources, callback) {
            console.log('[SourcePicker] Showing picker with', sources.length, 'sources');
            
            // Удаляем предыдущий диалог если есть
            const existing = document.getElementById('source-picker-overlay');
            if (existing) existing.remove();
            
            const overlay = document.createElement('div');
            overlay.id = 'source-picker-overlay';
            overlay.style.cssText = \`
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(5px);
            \`;
            
            const dialog = document.createElement('div');
            dialog.style.cssText = \`
            background: white;
            border-radius: 16px;
            padding: 32px;
            max-width: 90%;
            max-height: 80%;
            overflow: auto;
            min-width: 700px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            \`;
            
            let htmlContent = \`
            <h2 style="margin-top: 0; color: #333; font-size: 24px;">
                Выберите экран или окно для демонстрации
            </h2>
            <div style="
                display: grid; 
                grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); 
                gap: 20px; 
                margin: 24px 0;
            ">
            \`;
            
            sources.forEach((source, index) => {
            const isNative = source.isNative || false;
            const borderColor = isNative ? '#4CAF50' : '#2196F3';
            
            htmlContent += \`
                <div class="source-item" data-source-id="\${source.id}" style="
                border: 3px solid #e0e0e0;
                border-radius: 12px;
                padding: 16px;
                cursor: pointer;
                text-align: center;
                background: white;
                position: relative;
                transition: all 0.3s;
                " onmouseover="this.style.borderColor='\${borderColor}'; this.style.transform='scale(1.05)';" 
                onmouseout="this.style.borderColor='#e0e0e0'; this.style.transform='scale(1)';">
                \${isNative ? \`
                    <div style="
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    background: #4CAF50;
                    color: white;
                    padding: 4px 8px;
                    border-radius: 6px;
                    font-size: 12px;
                    font-weight: bold;
                    ">NATIVE</div>
                \` : ''}
                <img src="\${source.thumbnail?.dataUrl || ''}" style="
                    width: 100%; 
                    height: 160px; 
                    object-fit: contain; 
                    margin-bottom: 12px;
                    border-radius: 8px;
                    background: #f5f5f5;
                ">
                <div style="
                    font-size: 14px; 
                    color: #666; 
                    word-wrap: break-word;
                    font-weight: 500;
                ">\${source.name || 'Unknown'}</div>
                </div>
            \`;
            });
            
            htmlContent += \`
            </div>
            <div style="text-align: center; margin-top: 24px;">
                <button id="cancel-picker-btn" style="
                background: #f44336;
                color: white;
                border: none;
                padding: 12px 32px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 500;
                ">Отмена</button>
            </div>
            \`;
            
            dialog.innerHTML = htmlContent;
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            
            // Обработчики кликов
            overlay.onclick = function(e) {
            e.stopPropagation();
            
            const sourceItem = e.target.closest('.source-item');
            if (sourceItem) {
                const sourceId = sourceItem.dataset.sourceId;
                overlay.remove();
                callback(sourceId);
                return;
            }
            
            if (e.target.id === 'cancel-picker-btn' || e.target === overlay) {
                overlay.remove();
                return;
            }
            };
            
            // Escape для закрытия
            const handleEscape = function(e) {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', handleEscape);
            }
            };
            document.addEventListener('keydown', handleEscape);
        }
        
        return { success: true };
        })();
    `;
  }

  private cleanup(): void {
    log.info("Cleaning up Jitsi window...");
    
    this.state.isStreamActive = false;
    this.state.streamId = null;
    this.state.window = null;

    // Останавливаем native capture если активен
    if (this.nativeCapture.isCapturing) {
      this.nativeCapture.stopCapture();
    }
  }

  async closeWindow(): Promise<void> {
    if (this.state.window && !this.state.window.isDestroyed()) {
      this.state.window.close();
      this.state.window = null;
    }
    this.cleanup();
  }

  private createTestPattern(width: number, height: number, frameNum: number): string {
    // Этот метод больше не используется, паттерн создается прямо в Jitsi
    return "";
  }
}

export default JitsiManager;