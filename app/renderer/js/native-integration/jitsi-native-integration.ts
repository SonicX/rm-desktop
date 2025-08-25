// app/renderer/js/native-integration/jitsi-native-integration.ts

import { NativeMediaStreamBridge } from './native-mediastream-bridge';

interface NativeCaptureAPI {
  isAvailable(): Promise<boolean>;
  getCapabilities(): Promise<{ video: boolean; audio: boolean; systemAudio: boolean }>;
  startFullCapture(sourceId: string, options?: any): Promise<string>;
  startAudioCapture(sourceId: string, options?: any): Promise<string>;
  stopCapture(): Promise<boolean>;
}

interface JitsiAPI {
  executeCommand(command: string, ...args: any[]): void;
  on(event: string, callback: (data: any) => void): void;
  addTrack(track: any): void;
}

export class JitsiNativeIntegration {
  private nativeCapture: NativeCaptureAPI;
  private currentBridge: NativeMediaStreamBridge | null = null;
  private currentStream: MediaStream | null = null;
  private captureMode: 'full' | 'hybrid' | 'standard' = 'hybrid';
  private isCapturing: boolean = false;

  constructor() {
    // Используем глобальный API из preload
    this.nativeCapture = (window as any).nativeCapture;
  }

  // Метод 1: Полный нативный захват (видео + аудио)
  async startFullNativeCapture(sourceId: string): Promise<MediaStream> {
    console.log('[JitsiNative] Starting full native capture for source:', sourceId);
    
    try {
      // Останавливаем предыдущий захват
      await this.stopCapture();

      // Проверяем доступность
      const isAvailable = await this.nativeCapture.isAvailable();
      if (!isAvailable) {
        throw new Error('Native capture not available');
      }

      // Создаем мост для MediaStream
      this.currentBridge = new NativeMediaStreamBridge();

      // Конфигурируем захват
      const config = {
        width: 1920,
        height: 1080,
        frameRate: 30,
        captureAudio: true,
        audioDevice: 'system'
      };

      // Запускаем захват через IPC
      const streamId = await this.nativeCapture.startFullCapture(sourceId, config);
      console.log('[JitsiNative] Native capture started with streamId:', streamId);

      // Создаем MediaStream из нативных данных
      const { mediaStream } = await this.currentBridge.createFullNativeStream(config);

      this.currentStream = mediaStream;
      this.isCapturing = true;
      this.captureMode = 'full';

      console.log('[JitsiNative] Full native capture started successfully');
      return mediaStream;

    } catch (error) {
      console.error('[JitsiNative] Error starting full native capture:', error);
      await this.stopCapture();
      throw error;
    }
  }

  // Метод 2: Гибридный подход (Electron видео + нативный аудио)
  async startHybridCapture(sourceId: string): Promise<MediaStream> {
    console.log('[JitsiNative] Starting hybrid capture for source:', sourceId);
    
    try {
      // Останавливаем предыдущий захват
      await this.stopCapture();

      // Проверяем, что это не нативный источник
      if (sourceId.startsWith('native:')) {
        console.log('[JitsiNative] Native source detected, switching to full native mode');
        return this.startFullNativeCapture(sourceId);
      }

      // Используем стандартный Electron для видео
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        }
      };

      const videoStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('[JitsiNative] Got Electron video stream');

      // Проверяем доступность нативного аудио
      const isAvailable = await this.nativeCapture.isAvailable();
      if (!isAvailable) {
        console.warn('[JitsiNative] Native audio not available, using standard capture');
        // Добавляем стандартный аудио
        const audioConstraints = {
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop'
            }
          },
          video: false
        };
        
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
          const audioTrack = audioStream.getAudioTracks()[0];
          videoStream.addTrack(audioTrack);
        } catch (e) {
          console.warn('[JitsiNative] Failed to get desktop audio:', e);
        }
        
        this.currentStream = videoStream;
        this.captureMode = 'standard';
        return videoStream;
      }

      // Создаем мост для аудио
      this.currentBridge = new NativeMediaStreamBridge();

      // Запускаем захват только аудио
      const audioStreamId = await this.nativeCapture.startAudioCapture(sourceId, {
        captureVideo: false,
        audioDevice: 'system'
      });

      // Создаем системный аудио трек
      const systemAudioTrack = await this.currentBridge.createSystemAudioTrack();

      // Создаем новый MediaStream с видео от Electron и аудио от нативного плагина
      const videoTrack = videoStream.getVideoTracks()[0];
      this.currentStream = new MediaStream([videoTrack, systemAudioTrack]);
      
      this.isCapturing = true;
      this.captureMode = 'hybrid';

      console.log('[JitsiNative] Hybrid capture started successfully');
      return this.currentStream;

    } catch (error) {
      console.error('[JitsiNative] Error starting hybrid capture:', error);
      await this.stopCapture();
      throw error;
    }
  }

  // Автоматический выбор метода на основе возможностей
  async startSmartCapture(sourceId: string, preferredMode: 'full' | 'hybrid' | 'standard' = 'hybrid'): Promise<MediaStream> {
    console.log('[JitsiNative] Starting smart capture, preferred mode:', preferredMode);

    // Если выбран нативный источник
    if (sourceId === 'native:system-audio') {
      console.log('[JitsiNative] Native source selected, starting full native capture');
      // Нужно выбрать реальный источник для видео
      const realSourceId = await this.selectRealSource();
      if (!realSourceId) {
        throw new Error('No source selected');
      }
      return this.startFullNativeCapture(realSourceId);
    }

    // Проверяем возможности нативного аддона
    const capabilities = await this.checkNativeCapabilities();
    console.log('[JitsiNative] Native capabilities:', capabilities);

    if (preferredMode === 'full' && capabilities.canCaptureVideo && capabilities.canCaptureAudio) {
      // Пробуем полный нативный захват
      try {
        return await this.startFullNativeCapture(sourceId);
      } catch (error) {
        console.warn('[JitsiNative] Full native capture failed, falling back to hybrid:', error);
        return await this.startHybridCapture(sourceId);
      }
    } else if (capabilities.canCaptureAudio) {
      // Используем гибридный подход
      return await this.startHybridCapture(sourceId);
    } else {
      // Fallback на обычный Electron захват
      console.warn('[JitsiNative] Native audio not available, using standard capture');
      return await this.startStandardCapture(sourceId);
    }
  }

  // Стандартный Electron захват (fallback)
  async startStandardCapture(sourceId: string): Promise<MediaStream> {
    console.log('[JitsiNative] Starting standard Electron capture');
    
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop'
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.currentStream = stream;
    this.isCapturing = true;
    this.captureMode = 'standard';
    
    return stream;
  }

  // Проверка возможностей нативного аддона
  async checkNativeCapabilities(): Promise<{ canCaptureVideo: boolean; canCaptureAudio: boolean }> {
    try {
      const isAvailable = await this.nativeCapture.isAvailable();
      if (!isAvailable) {
        return { canCaptureVideo: false, canCaptureAudio: false };
      }

      const capabilities = await this.nativeCapture.getCapabilities();
      return {
        canCaptureVideo: capabilities.video,
        canCaptureAudio: capabilities.audio || capabilities.systemAudio
      };
    } catch (error) {
      console.error('[JitsiNative] Error checking capabilities:', error);
      return { canCaptureVideo: false, canCaptureAudio: false };
    }
  }

  // Выбор реального источника для нативного захвата
  private async selectRealSource(): Promise<string | null> {
    return new Promise((resolve) => {
      // Запускаем процесс выбора источника
      const event = new CustomEvent('select-native-source', {
        detail: { callback: resolve }
      });
      window.dispatchEvent(event);
    });
  }

  // Остановка захвата
  async stopCapture(): Promise<void> {
    console.log('[JitsiNative] Stopping capture, mode:', this.captureMode);

    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => {
        track.stop();
        console.log(`[JitsiNative] Stopped track: ${track.kind}`);
      });
      this.currentStream = null;
    }

    if (this.currentBridge) {
      this.currentBridge.stop();
      this.currentBridge = null;
    }

    if (this.isCapturing && (this.captureMode === 'full' || this.captureMode === 'hybrid')) {
      try {
        await this.nativeCapture.stopCapture();
      } catch (error) {
        console.error('[JitsiNative] Error stopping native capture:', error);
      }
    }

    this.isCapturing = false;
  }

  // Получение текущего потока
  getCurrentStream(): MediaStream | null {
    return this.currentStream;
  }

  // Получение информации о текущем режиме
  getCaptureInfo(): {
    isCapturing: boolean;
    mode: string;
    hasVideo: boolean;
    hasAudio: boolean;
    hasSystemAudio: boolean;
  } {
    return {
      isCapturing: this.isCapturing,
      mode: this.captureMode,
      hasVideo: this.currentStream ? this.currentStream.getVideoTracks().length > 0 : false,
      hasAudio: this.currentStream ? this.currentStream.getAudioTracks().length > 0 : false,
      hasSystemAudio: this.currentStream ? 
        this.currentStream.getAudioTracks().some(track => (track as any)._isSystemAudio) : false
    };
  }
}

// Функция интеграции с Jitsi
export function integrateWithJitsi(jitsiAPI: JitsiAPI): JitsiNativeIntegration {
  const integration = new JitsiNativeIntegration();

  // Сохраняем оригинальный метод
  const originalExecuteCommand = jitsiAPI.executeCommand.bind(jitsiAPI);
  
  // Переопределяем executeCommand
  jitsiAPI.executeCommand = async function(command: string, ...args: any[]) {
    if (command === 'toggleShareScreen' || command === 'startShareScreen') {
      console.log('[JitsiNative] Intercepting screen share command');
      
      try {
        // Ждем выбора источника если он не передан
        let sourceId = args[0];
        
        if (!sourceId) {
          console.log('[JitsiNative] No source provided, waiting for selection...');
          // Здесь Jitsi сам покажет диалог выбора
          originalExecuteCommand(command, ...args);
          return;
        }

        // Если выбран нативный источник или нужен системный звук
        const captureMode = await getCaptureMode();
        
        if (sourceId === 'native:system-audio' || captureMode !== 'standard') {
          // Запускаем нативный захват
          const stream = await integration.startSmartCapture(sourceId, captureMode as any);
          
          // Заменяем поток в Jitsi
          replaceJitsiStream(jitsiAPI, stream);
        } else {
          // Используем стандартный метод
          originalExecuteCommand(command, ...args);
        }
        
      } catch (error) {
        console.error('[JitsiNative] Error in screen share:', error);
        originalExecuteCommand(command, ...args);
      }
    } else {
      originalExecuteCommand(command, ...args);
    }
  };

  // Обработчик остановки демонстрации
  jitsiAPI.on('screenSharingStatusChanged', async (event: any) => {
    if (!event.on) {
      console.log('[JitsiNative] Screen sharing stopped');
      await integration.stopCapture();
    }
  });

  return integration;
}

// Вспомогательные функции
async function getCaptureMode(): Promise<string> {
  // Проверяем настройки или показываем диалог
  if ((window as any).JitsiNativeIntegration?.selectCaptureMode) {
    return await (window as any).JitsiNativeIntegration.selectCaptureMode();
  }
  return 'standard';
}

function replaceJitsiStream(jitsiAPI: JitsiAPI, stream: MediaStream): void {
  // Здесь нужна интеграция с Jitsi API для замены потока
  console.log('[JitsiNative] Replacing Jitsi stream with native stream');
  
  // Это зависит от версии Jitsi и доступных методов
  // Возможные варианты:
  
  // 1. Через JitsiMeetJS
  if ((window as any).JitsiMeetJS) {
    console.log('[JitsiNative] Using JitsiMeetJS to replace stream');
    // Код для замены через JitsiMeetJS
  }
  
  // 2. Через внутренние методы
  if ((jitsiAPI as any)._replaceStream) {
    console.log('[JitsiNative] Using internal _replaceStream method');
    (jitsiAPI as any)._replaceStream(stream);
  }
  
  // 3. Через события
  window.dispatchEvent(new CustomEvent('jitsi-replace-stream', { detail: stream }));
}