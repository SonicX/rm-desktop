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
      await this.state.window.loadURL(conferenceUrl);

      // Инъекция обработчиков после загрузки
      setTimeout(() => {
        this.injectHandlers();
      }, 3000);

      // Обработчик закрытия
      this.state.window.on('closed', () => {
        this.cleanup();
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
      log.info("Injecting Jitsi handlers...");

      // Инъекция перехвата демонстрации экрана
      await this.state.window.webContents.executeJavaScript(`
        ${this.getScreenShareInterceptorCode()}
      `);

      // Добавление UI кнопки для native stream
      await this.state.window.webContents.executeJavaScript(`
        ${this.getNativeStreamButtonCode()}
      `);

      log.info("Handlers injected successfully");

    } catch (error: any) {
      log.error(`Failed to inject handlers: ${error.message}`);
    }
  }

  private getScreenShareInterceptorCode(): string {
    return `
      (function() {
        console.log('[JitsiManager] Installing screen share interceptor...');
        
        // Ждем загрузки Jitsi API
        function waitForJitsiAPI() {
          return new Promise((resolve) => {
            let attempts = 0;
            const checkInterval = setInterval(() => {
              attempts++;
              if (window.JitsiMeetScreenObtainer) {
                clearInterval(checkInterval);
                console.log('[JitsiManager] JitsiMeetScreenObtainer found');
                resolve(true);
              } else if (attempts > 50) {
                clearInterval(checkInterval);
                console.error('[JitsiManager] JitsiMeetScreenObtainer not found');
                resolve(false);
              }
            }, 100);
          });
        }
        
        waitForJitsiAPI().then(ready => {
          if (!ready) return;
          
          // Перехватываем openDesktopPicker
          const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
          
          window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
            console.log('[JitsiManager] Desktop picker intercepted');
            
            // Запрашиваем источники через IPC
            if (window.ipcRenderer) {
              window.ipcRenderer.invoke('get-desktop-sources').then(sources => {
                console.log('[JitsiManager] Got', sources.length, 'sources');
                
                if (sources && sources.length > 0) {
                  // Здесь можно показать свой диалог выбора
                  // Для простоты используем первый источник
                  const selectedSource = sources[0];
                  callback(selectedSource.id, { audio: true });
                } else {
                  // Fallback на оригинальный метод
                  originalOpenDesktopPicker.call(this, options, callback);
                }
              }).catch(error => {
                console.error('[JitsiManager] Error getting sources:', error);
                originalOpenDesktopPicker.call(this, options, callback);
              });
            } else {
              originalOpenDesktopPicker.call(this, options, callback);
            }
          };
        });
        
        return { success: true };
      })();
    `;
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

  async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      return { success: false, error: "No active Jitsi window" };
    }

    if (!this.nativeCapture.isAvailable) {
      return { success: false, error: "Native capture not available" };
    }

    try {
      log.info("Injecting native stream into Jitsi...");

      // Создаем MediaStream в окне Jitsi
      const result = await this.state.window.webContents.executeJavaScript(`
        ${this.getStreamCreationCode()}
      `);

      if (!result.success) {
        throw new Error(result.error || "Failed to create stream");
      }

      this.state.streamId = result.streamId;
      this.state.isStreamActive = true;

      // Устанавливаем колбэки для передачи фреймов
      this.setupFrameForwarding();

      // Запускаем native capture
      const sources = await this.nativeCapture.getSources();
      if (sources.length > 0) {
        await this.nativeCapture.startCapture(sources[0].id);
      }

      return { success: true, streamId: result.streamId };

    } catch (error: any) {
      log.error(`Failed to inject native stream: ${error.message}`);
      return { success: false, error: error.message };
    }
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

  private getStreamCreationCode(): string {
    return `
      (async function() {
        console.log('[NativeStream] Creating native stream...');
        
        // Проверяем существующий stream
        if (window.nativeStream && window.isNativeActive) {
          return { 
            success: true, 
            streamId: window.nativeStream.id,
            error: 'Stream already exists'
          };
        }
        
        try {
          // Создаем canvas для видео
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1080;
          canvas.style.display = 'none';
          document.body.appendChild(canvas);
          
          const ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true
          });
          
          if (!ctx) {
            throw new Error('Failed to get canvas context');
          }
          
          // Создаем audio context
          const audioContext = new AudioContext({ sampleRate: 48000 });
          const scriptProcessor = audioContext.createScriptProcessor(4096, 0, 2);
          const audioBufferQueue = [];
          
          scriptProcessor.onaudioprocess = (event) => {
            if (!window.isNativeActive) return;
            
            const outputBuffer = event.outputBuffer;
            for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
              const outputData = outputBuffer.getChannelData(channel);
              if (audioBufferQueue.length > 0) {
                const audioData = audioBufferQueue.shift();
                if (audioData && audioData[channel]) {
                  outputData.set(audioData[channel]);
                } else {
                  outputData.fill(0);
                }
              } else {
                outputData.fill(0);
              }
            }
          };
          
          const destination = audioContext.createMediaStreamDestination();
          scriptProcessor.connect(destination);
          
          // Создаем MediaStream
          const stream = canvas.captureStream(30);
          const audioTrack = destination.stream.getAudioTracks()[0];
          if (audioTrack) {
            stream.addTrack(audioTrack);
          }
          
          // Сохраняем глобально
          window.nativeStream = stream;
          window.nativeCanvas = canvas;
          window.nativeCtx = ctx;
          window.nativeAudioQueue = audioBufferQueue;
          window.isNativeActive = true;
          
          // Функции обновления
          window.updateNativeVideo = function(frameData) {
            if (!window.isNativeActive || !ctx) return;
            
            if (frameData && frameData.data && frameData.width && frameData.height) {
              if (canvas.width !== frameData.width || canvas.height !== frameData.height) {
                canvas.width = frameData.width;
                canvas.height = frameData.height;
              }
              
              try {
                const pixelData = new Uint8ClampedArray(frameData.data);
                // Конвертируем BGRA в RGBA
                for (let i = 0; i < pixelData.length; i += 4) {
                  const b = pixelData[i];
                  const r = pixelData[i + 2];
                  pixelData[i] = r;
                  pixelData[i + 2] = b;
                }
                
                const imageData = new ImageData(pixelData, frameData.width, frameData.height);
                ctx.putImageData(imageData, 0, 0);
              } catch (e) {
                console.error('[NativeStream] Error rendering frame:', e);
              }
            }
          };
          
          window.addNativeAudio = function(audioData) {
            if (!window.isNativeActive) return;
            if (audioData && audioData.length === 2) {
              audioBufferQueue.push(audioData);
              if (audioBufferQueue.length > 20) {
                audioBufferQueue.shift();
              }
            }
          };
          
          // Подмена getDisplayMedia
          if (!window.originalGetDisplayMedia) {
            window.originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
          }
          
          navigator.mediaDevices.getDisplayMedia = async function(constraints) {
            console.log('[NativeStream] Intercepted getDisplayMedia');
            return window.nativeStream;
          };
          
          return { 
            success: true, 
            streamId: stream.id 
          };
          
        } catch (error) {
          console.error('[NativeStream] Error:', error);
          return { 
            success: false, 
            error: error.message 
          };
        }
      })();
    `;
  }

  private setupFrameForwarding(): void {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    // Устанавливаем колбэки для передачи фреймов из native capture в Jitsi
    this.nativeCapture.setFrameCallbacks(
      // Видео колбэк
      (videoData: any) => {
        if (!this.state.isStreamActive || !this.state.window || this.state.window.isDestroyed()) return;

        const frameData: any = {
          width: videoData?.width || 1920,
          height: videoData?.height || 1080
        };

        // Передаем пиксельные данные если есть
        if (videoData?.data && videoData?.dataSize > 0) {
          try {
            let pixelArray;
            if (videoData.data instanceof ArrayBuffer) {
              pixelArray = Array.from(new Uint8Array(videoData.data));
            } else if (Buffer.isBuffer(videoData.data)) {
              const maxSize = 1920 * 1080 * 4;
              const size = Math.min(videoData.data.length, maxSize);
              pixelArray = Array.from(videoData.data.slice(0, size));
            }
            
            if (pixelArray && pixelArray.length > 0) {
              frameData.data = pixelArray;
            }
          } catch (e) {
            log.error(`Error processing video frame: ${e}`);
          }
        }

        // Отправляем фрейм в Jitsi
        this.state.window.webContents.executeJavaScript(`
          if (window.updateNativeVideo) {
            window.updateNativeVideo(${JSON.stringify(frameData)});
          }
        `).catch(() => {});
      },
      
      // Аудио колбэк
      (audioData: any) => {
        if (!this.state.isStreamActive || !this.state.window || this.state.window.isDestroyed()) return;
        if (audioData?.source !== 'system') return;

        try {
          const buffer = Buffer.isBuffer(audioData.data) ? audioData.data : Buffer.from(audioData.data);
          const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, Math.min(2048, buffer.length / 2));
          
          const samples = Math.min(256, Math.floor(int16Array.length / 2));
          const ch0 = [];
          const ch1 = [];
          
          for (let i = 0; i < samples; i++) {
            ch0.push((int16Array[i * 2] / 32768.0).toFixed(4));
            ch1.push((int16Array[i * 2 + 1] / 32768.0).toFixed(4));
          }
          
          this.state.window.webContents.executeJavaScript(`
            if (window.addNativeAudio) {
              window.addNativeAudio([
                new Float32Array([${ch0.join(',')}]),
                new Float32Array([${ch1.join(',')}])
              ]);
            }
          `).catch(() => {});
          
        } catch (e) {
          log.error(`Error processing audio frame: ${e}`);
        }
      }
    );
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
}

export default JitsiManager;