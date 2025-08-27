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

export interface CaptureQuality {
    width: number;
    height: number;
    fps: number;
}

export interface CapturePreset {
    name: string;
    quality: CaptureQuality;
    description: string;
}

interface AudioPacket {
    data: Float32Array;
    timestamp: number;      // Временная метка в миллисекундах
    sampleRate: number;
    channels: number;
    numSamples: number;
}

// Предустановленные настройки качества
export const CAPTURE_PRESETS: { [key: string]: CapturePreset } = {
    ULTRALOW: {
        name: 'Очень низкое',
        quality: { width: 320, height: 240, fps: 15 },
        description: 'Экономия трафика, 480p @ 10fps'
    },
    LOW: {
        name: 'Низкое',
        quality: { width: 640, height: 480, fps: 15 },
        description: 'Экономия трафика, 480p @ 15fps'
    },
    MEDIUM: {
        name: 'Среднее',
        quality: { width: 1280, height: 720, fps: 10 },
        description: 'Оптимальный баланс, 720p @ 10fps'
    },
    HIGH: {
        name: 'Высокое',
        quality: { width: 1920, height: 1080, fps: 30 },
        description: 'Высокое качество, 1080p @ 30fps'
    },
    ULTRAHIGH: {
        name: 'Ультра',
        quality: { width: 2560, height: 1440, fps: 30 },
        description: 'Максимальное качество, 1440p @ 30fps'
    },
    PRESENTATION: {
        name: 'Презентация',
        quality: { width: 1920, height: 1080, fps: 5 },
        description: 'Для показа слайдов, 1080p @ 5fps'
    },
    SCREENSHARE: {
        name: 'Демонстрация экрана',
        quality: { width: 1920, height: 1080, fps: 15 },
        description: 'Для демонстрации экрана, 1080p @ 15fps'
    }
};

export class NativeCaptureManager {
    private state: NativeCaptureState;
    private currentQuality: CaptureQuality = CAPTURE_PRESETS.ULTRALOW.quality;
    private addonType: 'mac-swift' | 'windows-cpp' | 'unknown' = 'unknown';
    private debugCallback?: (packetInfo: any) => void; // 🆕

    // private useWindowsSync: boolean = false;
    // private windowsSyncBuffer?: AudioSyncBuffer;

    // 🆕 НОВЫЙ МЕТОД - установка debug callback
    setDebugCallback(callback: (packetInfo: any) => void): void {
        this.debugCallback = callback;
        log.info("[NATIVE-CAPTURE] Debug callback set");
    }

    notifyDebugPacket(frameNumber: number, audioData: any): void {
        if (this.debugCallback && frameNumber % 10 === 0) {
            const packetInfo = {
                frameNumber: frameNumber,
                dataSize: audioData.data?.byteLength || 0,
                sampleRate: audioData.sampleRate || 'unknown',
                channels: audioData.channels || 'unknown',
                numSamples: audioData.numSamples || 'unknown',
                source: audioData.source || 'unknown',
                timestamp: Date.now(),
                hasData: !!(audioData.data && audioData.data.byteLength > 0),
                addonType: this.addonType
            };
            
            this.debugCallback(packetInfo);
        }
    }

    constructor() {
        this.state = {
          addon: null, 
          isCapturing: false,
          currentSourceId: null,
          videoFrameCount: 0,
          audioFrameCount: 0,
          callbacks: {}
      };
        // if (!addon) {
        this.loadAddon(); // Загружаем только если не передан
        // }

        this.detectAddonType();
        this.registerHandlers();
    }

    private detectAddonType(): void {
        console.log("🪟 [detectAddonType] Start detect");
        
        if (!this.state.addon) {
            this.addonType = 'unknown';
            console.log("❌ [detectAddonType] No addon loaded - skipping detection");
            return;
        }
        
        if (typeof this.state.addon.getAvailableSources === 'function') {
            // Проверяем наличие testMethod для определения Windows плагина
            console.log("🪟 [detectAddonType] Start more");
            if (typeof this.state.addon.testMethod === 'function') {
                try {
                    const testResult = this.state.addon.testMethod();
                    if (testResult && testResult.includes('Windows')) {
                        this.addonType = 'windows-cpp';
                        console.log("🪟 [detectAddonType] Detected Windows C++ addon");
                        return;
                    }
                } catch (e) {
                    console.log("🪟 [detectAddonType] Error 1");
                }
            }
            
            // Проверка на Mac Swift плагин
            if (typeof this.state.addon.startAudioOnlyCapture === 'function') {
                this.addonType = 'mac-swift';
                console.log("🍎 [detectAddonType] Detected macOS Swift addon");
            } else if (process.platform === 'win32') {
                // Если мы на Windows и есть базовые методы - это Windows плагин
                this.addonType = 'windows-cpp';
                console.log("🪟 [detectAddonType] Detected Windows C++ addon (by platform)");
            } else {
                this.addonType = 'unknown';
                console.log("❓[detectAddonType] Unknown addon type");
            }
        } else {
            this.addonType = 'unknown';
            console.log("❓[detectAddonType] Unknown addon type - no getAvailableSources");
        }
        console.log("🪟 [detectAddonType] End detect");
    }

    public isNativeAvailable(): boolean {
        return !!this.state.addon && this.addonType !== 'not-loaded' && this.addonType !== 'unknown';
    }

    async startAudioOnlyCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        // Для macOS Swift - используем оптимизированный метод
        if (this.addonType === 'mac-swift' && typeof this.state.addon.startAudioOnlyCapture === 'function') {
            log.info("[NATIVE-CAPTURE] Using macOS optimized audio-only capture");
            // ... существующий код для Mac
            return this.startAudioOnlyCaptureSwift(sourceId);
        }
        
        // Для Windows - используем обычный захват
        if (this.addonType === 'windows-cpp') {
            log.info("[NATIVE-CAPTURE] Using Windows standard capture for audio");
            return this.startAudioOnlyCaptureWindows(sourceId);
        }
        
        // Fallback на обычный метод
        return this.startCapture(sourceId);
    }


    private async startAudioOnlyCaptureWindows(sourceId: string): Promise<{ success: boolean; error?: string }> {
        try {
            log.info("[NATIVE-CAPTURE] Starting Windows audio capture");
            
            // Парсим sourceId (ваш существующий код)
            let sourceType = 'display';
            let realSourceId = sourceId;
            
            if (sourceId.includes(':')) {
                const parts = sourceId.split(':');
                if (parts[0] === 'screen' && parts.length >= 2) {
                    sourceType = 'display';
                    realSourceId = parts[1];
                } else if (parts[0] === 'window') {
                    sourceType = 'window';
                    realSourceId = parts[1];
                }
            }
            
            // Сбрасываем счетчики
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // Настраиваем callbacks
            this.setupCallbacks();
            
            // Устанавливаем минимальное качество для экономии CPU (только аудио нужно)
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                log.info("[NATIVE-CAPTURE] Setting minimal video quality for audio-only mode");
                this.state.addon.setCaptureQuality(320, 240, 1);
            }
            
            // Устанавливаем источник
            if (typeof this.state.addon.setCaptureSource === 'function') {
                log.info(`[NATIVE-CAPTURE] Setting Windows capture source: ${sourceType}:${realSourceId}`);
                await this.state.addon.setCaptureSource(sourceType, realSourceId);
            }
            
            // Запускаем захват
            log.info("[NATIVE-CAPTURE] Starting Windows capture...");
            const startResult = await this.state.addon.startCapture();
            
            if (!startResult || startResult.error) {
                const errorMsg = startResult?.error || "Unknown error";
                log.error(`[NATIVE-CAPTURE] Windows capture failed: ${errorMsg}`);
                return { success: false, error: errorMsg };
            }
            
            this.state.isCapturing = true;
            this.state.currentSourceId = sourceId;
            
            log.info("[NATIVE-CAPTURE] ✅ Windows audio capture started successfully");
            return { success: true };
            
        } catch (error: any) {
            log.error(`[NATIVE-CAPTURE] Windows audio capture error: ${error.message}`);
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            return { success: false, error: error.message };
        }
    }

    // В native-capture.ts добавьте метод для audio-only режима
    async startAudioOnlyCaptureSwift(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        if (this.state.isCapturing) {
            await this.stopCapture();
        }
        
        try {
            log.info("[NATIVE-CAPTURE] Starting AUDIO-ONLY capture (optimized)");
            log.info(`[NATIVE-CAPTURE] Raw sourceId: ${sourceId}`);
            
            // Парсим sourceId
            let sourceType = 'display';
            let realSourceId = sourceId;
            
            if (sourceId.includes(':')) {
                const parts = sourceId.split(':');
                if (parts[0] === 'screen' && parts.length >= 2) {
                    sourceType = 'display';
                    realSourceId = parts[1];
                } else if (parts[0] === 'window') {
                    sourceType = 'window';
                    realSourceId = parts[1];
                }
            }
            
            log.info(`[NATIVE-CAPTURE] Parsed - type: '${sourceType}', id: '${realSourceId}'`);
            
            // Сбрасываем счетчики
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // ВАЖНО: Настраиваем callbacks ДО установки источника
            this.setupCallbacks();
            
            // Устанавливаем минимальное качество видео
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                log.info("[NATIVE-CAPTURE] Setting minimal quality for audio-only mode");
                this.state.addon.setCaptureQuality(320, 240, 1);
            }
            
            // КРИТИЧНО: Устанавливаем источник И ПРОВЕРЯЕМ РЕЗУЛЬТАТ
            log.info(`[NATIVE-CAPTURE] Setting capture source...`);
            
            try {
                let setSourceResult;
                
                // Пробуем разные методы установки источника
                if (typeof this.state.addon.setCaptureSourceById === 'function') {
                    const sourceTypeNum = sourceType === 'display' ? 0 : 1;
                    const sourceIdNum = parseInt(realSourceId) || 1;
                    log.info(`[NATIVE-CAPTURE] Using setCaptureSourceById(${sourceTypeNum}, ${sourceIdNum})`);
                    setSourceResult = await this.state.addon.setCaptureSourceById(sourceTypeNum, sourceIdNum);
                } else if (typeof this.state.addon.setCaptureSource === 'function') {
                    log.info(`[NATIVE-CAPTURE] Using setCaptureSource('${sourceType}', '${realSourceId}')`);
                    setSourceResult = await this.state.addon.setCaptureSource(sourceType, realSourceId);
                } else {
                    // Если нет методов установки источника, пробуем без них
                    log.warn("[NATIVE-CAPTURE] No setCaptureSource methods available, trying direct capture");
                    setSourceResult = { success: true };
                }
                
                log.info(`[NATIVE-CAPTURE] Set source result: ${JSON.stringify(setSourceResult)}`);
                
                // Небольшая задержка после установки источника
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error: any) {
                log.error(`[NATIVE-CAPTURE] Failed to set source: ${error.message}`);
                // Продолжаем даже если установка источника не удалась
            }
            
            // Запускаем захват
            log.info("[NATIVE-CAPTURE] Starting capture...");
            const startResult = await this.state.addon.startCapture();
            
            if (!startResult || startResult.error) {
                const errorMsg = startResult?.error || "Unknown error";
                log.error(`[NATIVE-CAPTURE] Start capture failed: ${errorMsg}`);
                
                // Если первая попытка не удалась, пробуем с дефолтными параметрами
                log.info("[NATIVE-CAPTURE] Retrying with default source...");
                
                try {
                    // Устанавливаем дефолтный источник
                    if (typeof this.state.addon.setCaptureSource === 'function') {
                        await this.state.addon.setCaptureSource('display', '1');
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Повторная попытка
                    const retryResult = await this.state.addon.startCapture();
                    
                    if (!retryResult || retryResult.error) {
                        throw new Error(retryResult?.error || "Retry failed");
                    }
                    
                    log.info("[NATIVE-CAPTURE] ✅ Capture started on retry");
                    
                } catch (retryError: any) {
                    log.error(`[NATIVE-CAPTURE] Retry failed: ${retryError.message}`);
                    return { success: false, error: retryError.message };
                }
            }
            
            log.info(`[NATIVE-CAPTURE] startCapture result: ${JSON.stringify(startResult)}`);
            
            this.state.isCapturing = true;
            this.state.currentSourceId = sourceId;
            
            log.info("[NATIVE-CAPTURE] ✅ Audio capture started successfully");
            return { success: true };
            
        } catch (error: any) {
            log.error(`[NATIVE-CAPTURE] Failed to start audio-only capture: ${error.message}`);
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            return { success: false, error: error.message || "Unknown error" };
        }
    }

    async startAudioVideoCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        if (this.state.isCapturing) {
            await this.stopCapture();
        }
        
        try {
            log.info("[NATIVE-CAPTURE] Starting AUDIO+VIDEO capture");
            log.info(`[NATIVE-CAPTURE] Quality: ${this.currentQuality.width}x${this.currentQuality.height} @ ${this.currentQuality.fps}fps`);
            
            // Парсим sourceId
            let sourceType = 'display';
            let realSourceId = sourceId;
            
            if (sourceId.includes(':')) {
                const parts = sourceId.split(':');
                if (parts[0] === 'screen' && parts.length >= 2) {
                    sourceType = 'display';
                    realSourceId = parts[1];
                } else if (parts[0] === 'window') {
                    sourceType = 'window';
                    realSourceId = parts[1];
                }
            }
            
            // Сбрасываем счетчики
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // Настраиваем callbacks для аудио И видео
            this.setupCallbacks();
            
            // Устанавливаем источник
            if (typeof this.state.addon.setCaptureSourceById === 'function') {
                const sourceTypeNum = sourceType === 'display' ? 0 : 1;
                const sourceIdNum = parseInt(realSourceId) || 1;
                await this.state.addon.setCaptureSourceById(sourceTypeNum, sourceIdNum);
            } else {
                await this.state.addon.setCaptureSource(sourceType, realSourceId);
            }
            
            // Устанавливаем качество видео
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                this.state.addon.setCaptureQuality(
                    this.currentQuality.width,
                    this.currentQuality.height,
                    this.currentQuality.fps
                );
            }
            
            // ИСПОЛЬЗУЕМ НОВЫЙ МЕТОД startAudioVideoCapture
            if (typeof this.state.addon.startAudioVideoCapture === 'function') {
                log.info("[NATIVE-CAPTURE] ✅ Using new startAudioVideoCapture method");
                const result = await this.state.addon.startAudioVideoCapture();
                log.info(`[NATIVE-CAPTURE] startAudioVideoCapture result: ${JSON.stringify(result)}`);
                
                this.state.isCapturing = true;
                this.state.currentSourceId = sourceId;
                
                log.info("[NATIVE-CAPTURE] ✅ Audio+Video capture started");
                return { success: true };
                
            } else {
                // Fallback на старый метод
                log.warn("[NATIVE-CAPTURE] startAudioVideoCapture not available, using regular startCapture");
                return this.startCapture(sourceId);
            }
            
        } catch (error: any) {
            log.error(`[NATIVE-CAPTURE] Failed to start audio+video capture: ${error.message}`);
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            return { success: false, error: error.message };
        }
    }

    private loadAddon(): boolean {
        try {
            const isDevelopment = process.env.NODE_ENV === 'development';
            const isPackaged = app.isPackaged; // Требует import { app } from 'electron'
            
            const possiblePaths = [];
            
            if (isPackaged) {
                // PRODUCTION пути для упакованного приложения
                if (process.platform === 'win32') {
                    // Windows production пути
                    possiblePaths.push(
                        // 1. В resources (из extraResources) - ОСНОВНОЙ ПУТЬ
                        path.join(process.resourcesPath, 'native-addon.node'),
                        
                        // 2. В распакованном app.asar (из asarUnpack)
                        path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'native-addon.node'),
                        
                        // 3. Остальные пути оставляем для совместимости
                        path.join(__dirname, 'native-addon.node'),
                        path.join(__dirname, '..', 'native-addon.node')
                    );
                } else {
                    // Mac production пути
                    possiblePaths.push(
                        path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'native-addon.node'),
                        path.join(__dirname, 'native-addon.node')
                    );
                }
            } else {
                // DEVELOPMENT пути
                possiblePaths.push(
                    path.join(__dirname, 'native-addon.node'),
                    path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
                    path.join(process.cwd(), 'dist-electron', 'native-addon.node')
                );
            }
            
            // Логируем все проверяемые пути
            log.info(`[NativeCapture] Checking for addon in ${possiblePaths.length} locations:`);
            log.info(`[NativeCapture] Platform: ${process.platform}`);
            log.info(`[NativeCapture] Is Packaged: ${isPackaged}`);
            log.info(`[NativeCapture] __dirname: ${__dirname}`);
            log.info(`[NativeCapture] process.resourcesPath: ${process.resourcesPath}`);
            
            let addonPath: string | null = null;
            for (const testPath of possiblePaths) {
                log.info(`[NativeCapture] Checking: ${testPath} - ${fs.existsSync(testPath) ? '✅ FOUND' : '❌ not found'}`);
                if (fs.existsSync(testPath)) {
                    addonPath = testPath;
                    break;
                }
            }
            
            if (!addonPath) {
                log.error(`[NativeCapture] ❌ Native addon not found in any location!`);
                return false;
            }
            
            log.info(`[NativeCapture] Loading native addon from: ${addonPath}`);
            this.state.addon = require(addonPath);
            
            // Проверяем методы
            const requiredMethods = this.getRequiredMethods();
            const missingMethods = requiredMethods.filter(m => typeof this.state.addon[m] !== 'function');
            
            if (missingMethods.length > 0) {
                log.warn(`[NativeCapture] Addon missing methods: ${missingMethods.join(', ')}`);
            }
            
            this.detectAddonType();
            
            log.info(`[NativeCapture] ✅ Native addon loaded successfully`);
            return true;
            
        } catch (error: any) {
            log.error(`[NativeCapture] ❌ Failed to load native addon: ${error.message}`);
            return false;
        }
    }

    private getRequiredMethods(): string[] {
        const baseMethods = ['getAvailableSources', 'startCapture', 'stopCapture', 
                            'setWebRTCVideoCallback', 'setWebRTCAudioCallback'];
        
        // Для Windows добавляем setCaptureSource, setCaptureQuality
        if (process.platform === 'win32') {
            return [...baseMethods, 'setCaptureSource', 'setCaptureQuality'];
        }
        
        // Для Mac оставляем как есть + оптимизированные методы
        return [...baseMethods, 'startAudioOnlyCapture', 'startAudioVideoCapture'];
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

    async testAddonHealth(): Promise<{ healthy: boolean; details: string; addonType: string }> {
        if (!this.state.addon) {
            return { 
                healthy: false, 
                details: "Addon not loaded",
                addonType: this.addonType
            };
        }
        
        const tests: string[] = [];
        
        // Проверяем основные методы
        const methods = [
            'setCaptureSource',
            'setCaptureQuality', 
            'startCapture',
            'stopCapture',
            'setWebRTCVideoCallback',
            'setWebRTCAudioCallback',
            'getAvailableSources'
        ];
        
        // Добавляем специфичные для платформы методы
        if (this.addonType === 'mac-swift') {
            methods.push('startAudioOnlyCapture', 'startAudioVideoCapture');
        }
        
        for (const method of methods) {
            if (typeof this.state.addon[method] === 'function') {
                tests.push(`✅ ${method}: exists`);
            } else {
                tests.push(`❌ ${method}: missing`);
            }
        }
        
        // 🆕 Информация о типе плагина
        tests.push(`🔧 Addon type: ${this.addonType}`);
        tests.push(`🖥️ Platform: ${process.platform}`);
        
        if (this.addonType === 'mac-swift') {
            tests.push(`🍎 macOS Swift addon - Optimized methods available`);
        } else if (this.addonType === 'windows-cpp') {
            tests.push(`🪟 Windows C++ addon - Standard methods`);
        }
        
        const details = tests.join('\n');
        const healthy = !tests.some(t => t.startsWith('❌'));
        
        log.info(`Native addon health check:\n${details}`);
        
        return { healthy, details, addonType: this.addonType };
    }

    private async syncTimeWithNative(): Promise<void> {
        if (!this.state.addon || typeof this.state.addon.syncTimeBase !== 'function') {
            log.warn("[NATIVE-CAPTURE] syncTimeBase not available");
            return;
        }
        
        try {
            // Синхронизируем несколько раз для точности
            for (let i = 0; i < 3; i++) {
                const jsTime = performance.now();
                await this.state.addon.syncTimeBase(jsTime);
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            log.info("[NATIVE-CAPTURE] Time synchronized with native addon");
        } catch (error: any) {
            log.error(`[NATIVE-CAPTURE] Time sync failed: ${error.message}`);
        }
    }

    async startCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        if (this.state.isCapturing) {
            await this.stopCapture();
        }

        if (this.addonType === 'windows-cpp') {
            await this.syncTimeWithNative();
        }
        
        try {
            // Парсим sourceId
            let sourceType = 'display';
            let realSourceId = sourceId;
            
            log.info(`Raw sourceId: '${sourceId}'`);
            
            if (sourceId.includes(':')) {
                const parts = sourceId.split(':');
                log.info(`Split parts: ${JSON.stringify(parts)}`);
                
                if (parts[0] === 'screen' && parts.length >= 2) {
                    sourceType = 'display';
                    realSourceId = parts[1];
                } else if (parts[0] === 'window') {
                    sourceType = 'window';
                    realSourceId = parts[1];
                }
            }
            
            log.info(`Parsed - type: '${sourceType}', id: '${realSourceId}'`);
            log.info(`Current quality settings: ${JSON.stringify(this.currentQuality)}`);
            
            // Сбрасываем счетчики
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // Настраиваем колбэки
            this.setupCallbacks();
            
            // Устанавливаем качество
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                log.info(`Setting quality: ${this.currentQuality.width}x${this.currentQuality.height} @ ${this.currentQuality.fps}fps`);
                
                try {
                    this.state.addon.setCaptureQuality(
                        this.currentQuality.width,
                        this.currentQuality.height,
                        this.currentQuality.fps
                    );
                    log.info("✅ Quality set successfully");
                } catch (error: any) {
                    log.error(`Failed to set quality: ${error.message}`);
                }
            }
            
            // ВРЕМЕННЫЙ ОБХОДНОЙ ПУТЬ: используем числовую версию если доступна
            log.info(`Setting capture source...`);
            
            try {
                if (typeof this.state.addon.setCaptureSourceById === 'function') {
                    // Используем числовую версию
                    const sourceTypeNum = sourceType === 'display' ? 0 : 1;
                    const sourceIdNum = parseInt(realSourceId) || 1;
                    
                    log.info(`Using setCaptureSourceById with type=${sourceTypeNum}, id=${sourceIdNum}`);
                    const setResult = await this.state.addon.setCaptureSourceById(sourceTypeNum, sourceIdNum);
                    log.info(`setCaptureSourceById result: ${JSON.stringify(setResult)}`);
                    
                } else {
                    // Fallback на обычную версию (которая сейчас использует захардкоженные значения)
                    log.info(`Using setCaptureSource (simplified version)`);
                    const setResult = await this.state.addon.setCaptureSource(sourceType, realSourceId);
                    log.info(`setCaptureSource result: ${JSON.stringify(setResult)}`);
                }
            } catch (error: any) {
                log.error(`setCaptureSource failed: ${error.message}`);
                
                // В случае ошибки пробуем с дефолтными значениями
                log.info("Trying with default source...");
                try {
                    const fallbackResult = await this.state.addon.setCaptureSource('display', '1');
                    log.info(`Fallback result: ${JSON.stringify(fallbackResult)}`);
                } catch (fallbackError: any) {
                    log.error(`Fallback also failed: ${fallbackError.message}`);
                    throw fallbackError;
                }
            }
            
            // Запускаем захват
            log.info("Calling startCapture...");
            const startResult = await this.state.addon.startCapture();
            log.info(`startCapture result: ${JSON.stringify(startResult)}`);
            
            this.state.isCapturing = true;
            this.state.currentSourceId = sourceId;
            
            log.info(`✅ Capture started with quality: ${this.currentQuality.width}x${this.currentQuality.height} @ ${this.currentQuality.fps}fps`);
            return { success: true };
            
        } catch (error: any) {
            log.error(`Failed to start capture: ${error.message}`);
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            return { success: false, error: error.message };
        }
    }

    async testAddon(): Promise<void> {
        if (!this.state.addon) {
            log.error("Addon not loaded");
            return;
        }
        
        log.info("=== Testing Native Addon ===");
        log.info("Addon type:", typeof this.state.addon);
        log.info("Available methods:");
        
        for (const key of Object.keys(this.state.addon)) {
            const value = this.state.addon[key];
            const type = typeof value;
            if (type === 'function') {
                log.info(`  ${key}: function(${value.length} args)`);
            } else {
                log.info(`  ${key}: ${type}`);
            }
        }
        
        // Тест базового метода
        if (typeof this.state.addon.testMethod === 'function') {
            try {
                const result = this.state.addon.testMethod();
                log.info("Test method result:", result);
            } catch (e: any) {
                log.error("Test method error:", e.message);
            }
        }
    }

    async stopCapture(): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon || !this.state.isCapturing) {
            return { success: true };
        }

        try {
            // stopCapture тоже возвращает Promise
            const result = await this.state.addon.stopCapture();
            log.info(`Stop capture result: ${JSON.stringify(result)}`);
            
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            
            return { success: true };
            
        } catch (error: any) {
            log.error(`Failed to stop capture: ${error.message}`);
            
            // Force cleanup
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            
            return { success: false, error: error.message };
        }
    }

    private decodeAudioData(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        const float32Data = new Float32Array(arrayBuffer);
        const leftChannel = new Float32Array(samples);
        const rightChannel = new Float32Array(samples);
        
        // Windows использует INTERLEAVED формат (L,R,L,R,L,R...)
        // 480 samples * 2 channels * 4 bytes = 3840 bytes
        if (arrayBuffer.byteLength === samples * channels * 4) {
            // Interleaved формат
            for (let i = 0; i < samples; i++) {
                leftChannel[i] = float32Data[i * 2];
                rightChannel[i] = float32Data[i * 2 + 1];
            }
        } else {
            console.log(`[DECODE] Unexpected buffer size: ${arrayBuffer.byteLength} bytes for ${samples} samples`);
            // Пробуем прочитать как есть
            for (let i = 0; i < samples && i < float32Data.length / 2; i++) {
                leftChannel[i] = float32Data[i * 2] || 0;
                rightChannel[i] = float32Data[i * 2 + 1] || 0;
            }
        }
        
        // Проверка на валидность
        let hasData = false;
        let maxAmp = 0;
        for (let i = 0; i < Math.min(100, samples); i++) {
            const absLeft = Math.abs(leftChannel[i]);
            const absRight = Math.abs(rightChannel[i]);
            maxAmp = Math.max(maxAmp, absLeft, absRight);
            if (absLeft > 0.00001 || absRight > 0.00001) {
                hasData = true;
            }
        }
        
        if (this.state.audioFrameCount === 1 || this.state.audioFrameCount % 100 === 0) {
            console.log(`[DECODE] Frame ${this.state.audioFrameCount}: maxAmp=${maxAmp.toFixed(4)}, hasData=${hasData}`);
        }
        
        return { leftChannel, rightChannel };
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

            // Критично для Windows: проверяем формат данных
            if (this.state.audioFrameCount === 1) {
                console.log("[NATIVE-CAPTURE] First audio frame structure:", {
                    hasData: !!audioData?.data,
                    dataType: audioData?.data?.constructor?.name,
                    dataByteLength: audioData?.data?.byteLength,
                    sampleRate: audioData?.sampleRate,
                    channels: audioData?.channels,
                    numSamples: audioData?.numSamples,
                    source: audioData?.source || audioData?.applicationName
                });
                
                // Проверяем реальные данные
                if (audioData?.data && audioData.data.byteLength > 0) {
                    const testArray = new Float32Array(audioData.data);
                    let maxAmp = 0;
                    for (let i = 0; i < Math.min(100, testArray.length); i++) {
                        maxAmp = Math.max(maxAmp, Math.abs(testArray[i]));
                    }
                    console.log(`[NATIVE-CAPTURE] First frame max amplitude: ${maxAmp.toFixed(4)}`);
                    console.log(`[NATIVE-CAPTURE] First 10 samples: ${Array.from(testArray.slice(0, 10)).map(v => v.toFixed(4)).join(', ')}`);
                }
            }

            // Обработка в зависимости от платформы
            if (this.addonType === 'windows-cpp' && this.useWindowsSync) {
                this.processWindowsAudioWithSync(audioData);
            } else {
                this.processStandardAudio(audioData);
            }
            
            if (this.state.audioFrameCount % 100 === 0) {
                console.log(`[NATIVE-CAPTURE] Audio frames: ${this.state.audioFrameCount}`);
            }
        });
        
        log.info("Native capture callbacks setup complete");
    }

    private processNativeAudio(audioData: any): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        this.state.audioFrameCount++;
        
        // Добавляем диагностику
        if (this.state.audioFrameCount <= 5 || this.state.audioFrameCount % 50 === 0) {
            log.info(`[PROCESS-AUDIO] Frame ${this.state.audioFrameCount}:`, {
                hasData: !!audioData?.data,
                dataByteLength: audioData?.data?.byteLength,
                numSamples: audioData?.numSamples,
                channels: audioData?.channels
            });
        }
        
        try {
            const arrayBuffer = audioData.data;
            const samples = audioData.numSamples || 960;
            const channels = audioData.channels || 2;
            
            // КРИТИЧНО: Исправляем декодирование для Windows
            const { leftChannel, rightChannel } = this.decodeAudioDataWindows(arrayBuffer, samples, channels);
            
            // Анализируем уровни
            const levels = this.analyzeAudioLevels(leftChannel, rightChannel);
            
            if (this.state.audioFrameCount % 50 === 0) {
                log.info(`[STREAM-ELECTRON] Audio: Frame ${this.state.audioFrameCount}, ` +
                        `L=${levels.maxLeft.toFixed(4)}, R=${levels.maxRight.toFixed(4)}, ` +
                        `hasAudio=${levels.hasAudio}`);
            }
            
            // Если данные пустые, проверяем альтернативное декодирование
            if (!levels.hasAudio && this.state.audioFrameCount <= 10) {
                log.warn(`[AUDIO-DECODE] No audio detected, trying alternative decode`);
                // Пробуем другой формат декодирования
                const altDecode = this.tryAlternativeDecode(arrayBuffer, samples, channels);
                if (altDecode.hasAudio) {
                    log.info(`[AUDIO-DECODE] Alternative decode successful!`);
                    leftChannel.set(altDecode.left);
                    rightChannel.set(altDecode.right);
                }
            }
            
            const { processedLeft, processedRight } = this.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );
            
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] processNativeAudio ERROR: ${error.message}`);
        }
    }

    private decodeAudioDataWindows(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        let leftChannel = new Float32Array(samples);
        let rightChannel = new Float32Array(samples);
        
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            log.warn('[AUDIO-DECODE] Empty buffer received');
            return { leftChannel, rightChannel };
        }
        
        const dataView = new DataView(arrayBuffer);
        const bytesPerSample = 4; // Float32
        const expectedSize = samples * channels * bytesPerSample;
        
        log.info(`[AUDIO-DECODE] Buffer size: ${arrayBuffer.byteLength}, Expected: ${expectedSize}`);
        
        // Windows C++ addon может отправлять данные в разных форматах
        if (arrayBuffer.byteLength === samples * channels * bytesPerSample) {
            // Проверяем, интерливд или планарный формат
            
            // Сначала пробуем интерливд (L,R,L,R,...)
            let hasDataInterleaved = false;
            for (let i = 0; i < samples; i++) {
                const leftSample = dataView.getFloat32((i * channels) * bytesPerSample, true);
                const rightSample = channels > 1 ? 
                    dataView.getFloat32((i * channels + 1) * bytesPerSample, true) : 
                    leftSample;
                
                leftChannel[i] = leftSample;
                rightChannel[i] = rightSample;
                
                if (Math.abs(leftSample) > 0.00001 || Math.abs(rightSample) > 0.00001) {
                    hasDataInterleaved = true;
                }
            }
            
            // Если интерливд пустой, пробуем планарный (LLLL...RRRR...)
            if (!hasDataInterleaved) {
                log.info('[AUDIO-DECODE] Interleaved was empty, trying planar format');
                
                const samplesPerChannel = arrayBuffer.byteLength / (channels * bytesPerSample);
                for (let i = 0; i < samplesPerChannel; i++) {
                    leftChannel[i] = dataView.getFloat32(i * bytesPerSample, true);
                    if (channels > 1) {
                        const rightOffset = samplesPerChannel * bytesPerSample;
                        rightChannel[i] = dataView.getFloat32(rightOffset + i * bytesPerSample, true);
                    } else {
                        rightChannel[i] = leftChannel[i];
                    }
                }
            }
        }
        
        return { leftChannel, rightChannel };
    }

    private processStandardAudio(audioData: any): void {
        if (audioData && audioData.data && audioData.data.byteLength > 0) {
            // Для отладки - проверяем реальные данные
            if (this.state.audioFrameCount % 100 === 0) {
                const float32 = new Float32Array(audioData.data);
                let maxAmp = 0;
                for (let i = 0; i < Math.min(100, float32.length); i++) {
                    maxAmp = Math.max(maxAmp, Math.abs(float32[i]));
                }
                console.log(`[STANDARD-AUDIO] Frame ${this.state.audioFrameCount}: maxAmp=${maxAmp.toFixed(4)}, bytes=${audioData.data.byteLength}`);
            }
            
            if (this.state.callbacks.audio) {
                // КРИТИЧНО: Правильные numSamples для каждой платформы
                const isWindows = process.platform === 'win32';

                const correctedData = {
                    data: audioData.data, // ArrayBuffer как есть
                    sampleRate: audioData?.sampleRate || 48000,
                    channels: audioData?.channels || 2,
                    numSamples: audioData?.numSamples || (isWindows ? 480 : 960), // Windows: 480, macOS: 960

                    source: audioData?.source || audioData?.applicationName || 'unknown'
                };
                
                this.state.callbacks.audio(correctedData);
                
                if (this.state.audioFrameCount === 1) {
                    console.log(`✅ First audio frame sent to callback (${isWindows ? 'Windows' : 'macOS'}: ${correctedData.numSamples} samples)`);
                }
            }
        } else {
            console.log(`[STANDARD-AUDIO] Empty frame ${this.state.audioFrameCount}`);
        }
    }

    private processWindowsAudioWithSync(audioData: any): void {
        if (!this.windowsSyncBuffer) return;
        
        try {
            const arrayBuffer = audioData.data;
            const samples = audioData.numSamples || 960;
            const channels = audioData.channels || 2;
            const timestamp = audioData.timestamp || Date.now();
            
            // Windows-специфичная обработка с буферизацией
            const { leftChannel, rightChannel } = this.decodeAudioData(arrayBuffer, samples, channels);
            
            const stereoData = new Float32Array(samples * 2);
            for (let i = 0; i < samples; i++) {
                stereoData[i * 2] = leftChannel[i];
                stereoData[i * 2 + 1] = rightChannel[i];
            }
            
            // Добавляем в синхронизирующий буфер
            this.windowsSyncBuffer.addPacket({
                data: stereoData,
                timestamp: timestamp,
                sampleRate: audioData.sampleRate || 48000,
                channels: channels,
                numSamples: samples
            });
            
            // Отправляем с коррекцией тайминга
            if (this.state.callbacks.audio) {
                this.state.callbacks.audio({
                    data: audioData.data,
                    sampleRate: audioData.sampleRate || 48000,
                    channels: channels,
                    numSamples: samples,
                    source: audioData.source || 'unknown',
                    syncTimestamp: timestamp // Добавляем метку для Windows
                });
            }
            
        } catch (error: any) {
            log.error(`[WINDOWS-SYNC] Error: ${error.message}`);
            // Fallback на стандартную обработку
            this.processStandardAudio(audioData);
        }
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

  // Установка качества захвата
    async setCaptureQuality(quality: CaptureQuality): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        try {
            // Валидация параметров
            const validatedQuality = {
                width: Math.max(320, Math.min(3840, quality.width)),
                height: Math.max(240, Math.min(2160, quality.height)),
                fps: Math.max(5, Math.min(60, quality.fps))
            };
            
            log.info(`Setting capture quality: ${validatedQuality.width}x${validatedQuality.height} @ ${validatedQuality.fps}fps`);
            
            // Проверяем наличие метода
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                const result = this.state.addon.setCaptureQuality(
                    validatedQuality.width,
                    validatedQuality.height,
                    validatedQuality.fps
                );
                
                this.currentQuality = validatedQuality;
                log.info(`Capture quality set: ${result}`);
                return { success: true };
            } else {
                log.warn("setCaptureQuality method not found in addon");
                return { success: false, error: "Method not available" };
            }
            
        } catch (error: any) {
            log.error(`Failed to set capture quality: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Использовать предустановку качества
    async useQualityPreset(presetName: keyof typeof CAPTURE_PRESETS): Promise<{ success: boolean; error?: string }> {
        const preset = CAPTURE_PRESETS[presetName];
        if (!preset) {
            return { success: false, error: `Unknown preset: ${presetName}` };
        }
        
        log.info(`📐 Using quality preset: ${preset.name} - ${preset.description}`);
        log.info(`📐 Setting quality to: ${preset.quality.width}x${preset.quality.height} @ ${preset.quality.fps}fps`);
        
        // Сохраняем качество локально
        this.currentQuality = { ...preset.quality };
        
        // И отправляем в Swift если захват уже идет
        if (this.state.isCapturing && this.state.addon && typeof this.state.addon.setCaptureQuality === 'function') {
            try {
                this.state.addon.setCaptureQuality(
                    preset.quality.width,
                    preset.quality.height,
                    preset.quality.fps
                );
                log.info("✅ Quality updated in Swift during active capture");
            } catch (error: any) {
                log.error(`Failed to update quality in Swift: ${error.message}`);
            }
        }
        
        return { success: true };
    }
    
    // Запуск захвата с указанным качеством
    async startCaptureWithQuality(
        sourceId: string, 
        quality?: CaptureQuality
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        // Если качество указано, устанавливаем его
        if (quality) {
            this.currentQuality = { ...quality };
            log.info(`Setting custom quality: ${quality.width}x${quality.height} @ ${quality.fps}fps`);
        }
        
        // Используем обычный startCapture, который уже умеет работать с currentQuality
        return this.startCapture(sourceId);
    }
    
    // Получить текущие настройки качества
    getCurrentQuality(): CaptureQuality {
        return { ...this.currentQuality };
    }
    
    // Изменить качество во время захвата
    async updateQualityDuringCapture(quality: CaptureQuality): Promise<{ success: boolean; error?: string }> {
        if (!this.state.isCapturing) {
            // Если захват не идет, просто сохраняем настройки
            return this.setCaptureQuality(quality);
        }
        
        log.info("Updating quality during capture...");
        
        // В зависимости от возможностей Swift, можем либо:
        // 1. Перезапустить захват с новыми параметрами
        // 2. Изменить качество на лету (если Swift поддерживает)
        
        const currentSourceId = this.state.currentSourceId;
        if (!currentSourceId) {
            return { success: false, error: "No active capture source" };
        }
        
        // Останавливаем текущий захват
        await this.stopCapture();
        
        // Запускаем с новым качеством
        return this.startCaptureWithQuality(currentSourceId, quality);
    }
}

class AudioSyncBuffer {
    private packets: AudioPacket[] = [];
    private baseTimestamp: number = 0;
    private audioTimestamp: number = 0;
    private readonly maxBufferMs = 100; // Максимальная буферизация
    private readonly targetLatencyMs = 20; // Целевая задержка
    
    constructor(private sampleRate: number = 48000) {}
    
    reset(): void {
        this.packets = [];
        this.baseTimestamp = 0;
        this.audioTimestamp = 0;
    }
    
    addPacket(packet: AudioPacket): void {
        if (this.baseTimestamp === 0) {
            this.baseTimestamp = packet.timestamp;
            this.audioTimestamp = 0;
        }
        
        // Вычисляем относительную временную метку
        const relativeTimestamp = packet.timestamp - this.baseTimestamp;
        
        // Добавляем пакет с корректной меткой
        this.packets.push({
            ...packet,
            timestamp: relativeTimestamp
        });
        
        // Очищаем старые пакеты
        this.cleanOldPackets();
    }
    
    private cleanOldPackets(): void {
        if (this.packets.length === 0) return;
        
        const now = this.packets[this.packets.length - 1].timestamp;
        const cutoff = now - this.maxBufferMs;
        
        this.packets = this.packets.filter(p => p.timestamp > cutoff);
    }
    
    getAudioForTimestamp(videoTimestamp: number): Float32Array | null {
        if (this.packets.length === 0) return null;
        
        // Ищем подходящий аудио пакет для текущего видео кадра
        const targetTime = videoTimestamp + this.targetLatencyMs;
        
        // Находим ближайший пакет
        let bestPacket: AudioPacket | null = null;
        let minDiff = Infinity;
        
        for (const packet of this.packets) {
            const diff = Math.abs(packet.timestamp - targetTime);
            if (diff < minDiff) {
                minDiff = diff;
                bestPacket = packet;
            }
        }
        
        // Если разница слишком большая, возвращаем тишину
        if (minDiff > 50) { // 50ms максимальное расхождение
            return null;
        }
        
        return bestPacket?.data || null;
    }
    
    getBufferStatus(): { packets: number; latencyMs: number } {
        if (this.packets.length === 0) {
            return { packets: 0, latencyMs: 0 };
        }
        
        const first = this.packets[0].timestamp;
        const last = this.packets[this.packets.length - 1].timestamp;
        
        return {
            packets: this.packets.length,
            latencyMs: last - first
        };
    }
}

export default NativeCaptureManager;