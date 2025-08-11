// native-capture.ts - Модуль для работы с native addon
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import * as fs from "fs";
import log from "electron-log";

interface NativeCaptureState {
  addon: any;
  isCapturing: boolean;
  currentSourceId: string | null;
  videoFrameCount: number;
  audioFrameCount: number;
  callbacks: {
    video?: (data: any) => void;
    audio?: (data: any) => void;
  };
}

export class NativeCaptureManager {
  private state: NativeCaptureState;

  constructor(addon?: any) {
      this.state = {
        addon: addon || null, // Используем переданный addon
        isCapturing: false,
        currentSourceId: null,
        videoFrameCount: 0,
        audioFrameCount: 0,
        callbacks: {}
    };

    if (!addon) {
        this.loadAddon(); // Загружаем только если не передан
    }
    this.registerHandlers();
  }

  private loadAddon(): boolean {
    try {
      const possiblePaths = [
        path.join(__dirname, 'native-addon.node'),
        path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
        path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
        '/Users/sg12/zulip-desktop/dist-electron/native-addon.node'
      ];
      
      let addonPath: string | null = null;
      for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
          addonPath = testPath;
          break;
        }
      }
      
      if (!addonPath) {
        log.error(`Native addon not found in any of: ${possiblePaths.join(', ')}`);
        return false;
      }
      
      log.info(`Loading native addon from: ${addonPath}`);
      this.state.addon = require(addonPath);
      
      // Проверяем основные методы
      const requiredMethods = ['getAvailableSources', 'startCapture', 'stopCapture', 
                               'setWebRTCVideoCallback', 'setWebRTCAudioCallback'];
      const missingMethods = requiredMethods.filter(m => typeof this.state.addon[m] !== 'function');
      
      if (missingMethods.length > 0) {
        log.warn(`Native addon missing methods: ${missingMethods.join(', ')}`);
      }
      
      log.info(`✅ Native addon loaded successfully`);
      return true;
      
    } catch (error: any) {
      log.error(`❌ Failed to load native addon: ${error.message}`);
      return false;
    }
  }

  private registerHandlers(): void {
    // Получение списка источников
    ipcMain.handle("native-capture:get-sources", async () => {
      return this.getSources();
    });

    // Начало захвата
    ipcMain.handle("native-capture:start", async (event, sourceId: string) => {
      return this.startCapture(sourceId);
    });

    // Остановка захвата
    ipcMain.handle("native-capture:stop", async () => {
      return this.stopCapture();
    });

    // Получение статуса
    ipcMain.handle("native-capture:get-status", async () => {
      return {
        isCapturing: this.state.isCapturing,
        currentSourceId: this.state.currentSourceId,
        hasAddon: !!this.state.addon,
        videoFrames: this.state.videoFrameCount,
        audioFrames: this.state.audioFrameCount
      };
    });
  }

  private createDefaultThumbnail(): string {
    const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="200" fill="#9E9E9E"/>
      <text x="150" y="100" font-size="50" text-anchor="middle" fill="white">❓</text>
      <text x="150" y="140" font-size="16" text-anchor="middle" fill="white">Unknown Source</text>
    </svg>`;
    
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  async getSources(): Promise<any[]> {
    if (!this.state.addon) {
      log.error("Native addon not loaded");
      return [];
    }

    try {
      const sources = await this.state.addon.getAvailableSources();
      log.info(`Got ${sources?.length || 0} native sources from addon`);
      
      // ВАЖНО: Фильтруем и форматируем источники для безопасной передачи через IPC
      const formattedSources = sources.map((source: any, index: number) => {
        try {
          // Создаем безопасный объект без циклических ссылок и нестандартных типов
          const safeSource = {
            id: String(source.id || index),
            name: String(source.name || `Source ${index}`),
            type: String(source.type || 'unknown'),
            isNative: true,
            // Создаем thumbnail как простой объект с dataUrl строкой
            thumbnail: {
              dataUrl: this.createThumbnail(source)
            }
          };
          
          // Проверяем, что объект можно сериализовать
          JSON.stringify(safeSource);
          
          return safeSource;
          
        } catch (error: any) {
          log.error(`Error formatting source ${index}: ${error.message}`);
          // Возвращаем минимальный безопасный объект
          return {
            id: String(index),
            name: `Source ${index}`,
            type: 'unknown',
            isNative: true,
            thumbnail: {
              dataUrl: this.createDefaultThumbnail()
            }
          };
        }
      });
      
      log.info(`Formatted ${formattedSources.length} sources for IPC`);
      return formattedSources;
      
    } catch (error: any) {
      log.error(`Failed to get native sources: ${error.message}`);
      return [];
    }
  }

  async startCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.state.addon) {
      return { success: false, error: "Native addon not loaded" };
    }

    if (this.state.isCapturing) {
      await this.stopCapture();
    }

    try {
      // Извлекаем оригинальный ID
      let realSourceId = sourceId;
      if (sourceId.includes(':')) {
        const parts = sourceId.split(':');
        realSourceId = parts[parts.length - 1];
      }

      log.info(`Starting capture for source: ${realSourceId}`);

      // Сбрасываем счетчики
      this.state.videoFrameCount = 0;
      this.state.audioFrameCount = 0;

      // Устанавливаем колбэки
      this.setupCallbacks();

      // Пробуем запустить захват
      try {
        const result = await this.state.addon.startCapture(realSourceId);
        log.info(`Capture started directly: ${JSON.stringify(result)}`);
      } catch (error: any) {
        // Если не удалось напрямую, показываем системный диалог
        log.info("Direct capture failed, showing system picker...");
        
        const pickerResult = await this.state.addon.selectSourceWithPicker();
        if (!pickerResult || !pickerResult.id) {
          throw new Error("User cancelled source selection");
        }

        await this.state.addon.setCaptureSource({
          type: pickerResult.type || 'window',
          id: String(pickerResult.id)
        });

        const result = await this.state.addon.startCapture();
        log.info(`Capture started after picker: ${JSON.stringify(result)}`);
      }

      this.state.isCapturing = true;
      this.state.currentSourceId = sourceId;

      return { success: true };

    } catch (error: any) {
      log.error(`Failed to start capture: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async stopCapture(): Promise<{ success: boolean; error?: string }> {
    if (!this.state.addon || !this.state.isCapturing) {
      return { success: true };
    }

    try {
      await this.state.addon.stopCapture();
      this.state.isCapturing = false;
      this.state.currentSourceId = null;
      log.info("Capture stopped successfully");
      return { success: true };
      
    } catch (error: any) {
      log.error(`Failed to stop capture: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private setupCallbacks(): void {
      if (!this.state.addon) return;

      // Видео колбэк с исправленной обработкой ArrayBuffer
      this.state.addon.setWebRTCVideoCallback((videoData: any) => {
          this.state.videoFrameCount++;
          
          // Детальная диагностика для первых кадров
          if (this.state.videoFrameCount <= 3) {
              log.info(`Video frame ${this.state.videoFrameCount} structure:`, {
                  hasDataField: 'data' in videoData,
                  dataType: typeof videoData?.data,
                  dataConstructor: videoData?.data?.constructor?.name,
                  dataByteLength: videoData?.data?.byteLength,
                  width: videoData?.width,
                  height: videoData?.height
              });
          }
          
          // ИСПРАВЛЕНИЕ: Правильно обрабатываем ArrayBuffer
          if (videoData && videoData.data) {
              // ArrayBuffer от N-API имеет свойство byteLength
              if (videoData.data.byteLength !== undefined && videoData.data.byteLength > 0) {
                  // ЭТО ArrayBuffer! Передаем его напрямую в callback
                  if (this.state.callbacks.video) {
                      const normalizedData = {
                          data: videoData.data, // ArrayBuffer передаем как есть
                          width: videoData?.width || 1920,
                          height: videoData?.height || 1080,
                          dataSize: videoData?.dataSize || videoData.data.byteLength,
                          timestamp: videoData?.timestamp || 0
                      };
                      
                      this.state.callbacks.video(normalizedData);
                      
                      if (this.state.videoFrameCount === 1) {
                          log.info("✅ First video frame sent to callback with ArrayBuffer");
                      }
                  }
              } else if (Buffer.isBuffer(videoData.data)) {
                  // Если это Buffer
                  if (this.state.callbacks.video) {
                      this.state.callbacks.video({
                          data: videoData.data,
                          width: videoData?.width || 1920,
                          height: videoData?.height || 1080,
                          dataSize: videoData?.dataSize || videoData.data.length,
                          timestamp: videoData?.timestamp || 0
                      });
                  }
              }
          } else if (this.state.videoFrameCount <= 3) {
              log.warn(`Frame ${this.state.videoFrameCount}: No data field`);
          }

          if (this.state.videoFrameCount % 30 === 0) {
              log.info(`Video frames: ${this.state.videoFrameCount}`);
          }
      });

      // Аудио колбэк - аналогично упрощаем
      this.state.addon.setWebRTCAudioCallback((audioData: any) => {
          this.state.audioFrameCount++;
          
          if (this.state.audioFrameCount === 1) {
              log.info("First audio frame:", {
                  hasData: !!audioData?.data,
                  dataByteLength: audioData?.data?.byteLength,
                  sampleRate: audioData?.sampleRate,
                  channels: audioData?.channels,
                  source: audioData?.source
              });
          }
          
          // Передаем ArrayBuffer напрямую
          if (audioData && audioData.data && audioData.data.byteLength > 0) {
              if (this.state.callbacks.audio) {
                  this.state.callbacks.audio({
                      data: audioData.data, // ArrayBuffer как есть
                      sampleRate: audioData?.sampleRate || 48000,
                      channels: audioData?.channels || 2,
                      numSamples: audioData?.numSamples || 960,
                      source: audioData?.source || 'unknown'
                  });
                  
                  if (this.state.audioFrameCount === 1) {
                      log.info("✅ First audio frame sent to callback");
                  }
              }
          }

          if (this.state.audioFrameCount % 100 === 0) {
              log.info(`Audio frames: ${this.state.audioFrameCount}`);
          }
      });
      
      log.info("Native capture callbacks setup complete");
  }

  // Установка внешних колбэков для обработки фреймов
  setFrameCallbacks(videoCallback?: (data: any) => void, audioCallback?: (data: any) => void): void {
    if (videoCallback) this.state.callbacks.video = videoCallback;
    if (audioCallback) this.state.callbacks.audio = audioCallback;
  }

  private createThumbnail(source: any): string {
    try {
      const colors: { [key: string]: string } = {
        screen: '#4CAF50',
        display: '#4CAF50',
        window: '#2196F3',
        application: '#FF9800'
      };
      
      const sourceType = String(source.type || 'unknown').toLowerCase();
      const color = colors[sourceType] || '#9E9E9E';
      const icon = (sourceType === 'screen' || sourceType === 'display') ? '🖥️' : '🪟';
      
      // Безопасное экранирование имени
      const safeName = String(source.name || 'Unknown')
        .replace(/[<>&"']/g, '')
        .substring(0, 50); // Ограничиваем длину
      
      const safeAppName = source.appName 
        ? String(source.appName)
            .replace(/[<>&"']/g, '')
            .substring(0, 50)
        : '';
      
      const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="200" fill="${color}"/>
        <text x="150" y="80" font-size="50" text-anchor="middle" fill="white">${icon}</text>
        <text x="150" y="130" font-size="16" text-anchor="middle" fill="white" font-weight="bold">
          ${safeName}
        </text>
        ${safeAppName ? `
          <text x="150" y="155" font-size="14" text-anchor="middle" fill="white" opacity="0.9">
            ${safeAppName}
          </text>
        ` : ''}
        <rect x="20" y="180" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
        <rect x="20" y="180" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      
    } catch (error: any) {
      log.error(`Error creating thumbnail: ${error.message}`);
      return this.createDefaultThumbnail();
    }
  }

  // Геттер для проверки состояния
  get isAvailable(): boolean {
    return !!this.state.addon;
  }

  get isCapturing(): boolean {
    return this.state.isCapturing;
  }
}

export default NativeCaptureManager;