// app/renderer/js/native-integration/native-mediastream-bridge.ts

interface NativeFrameData {
  data: ArrayBuffer | Uint8Array | Uint8ClampedArray;
  width?: number;
  height?: number;
  timestamp: number;
  channels?: number;
  sampleRate?: number;
}

interface NativeAddon {
  startCapture(config: any): Promise<{ success: boolean; error?: string; streamId?: string }>;
  stopCapture(): Promise<void>;
  getVideoFrame(): NativeFrameData | null;
  getAudioFrame(): NativeFrameData | null;
  getCapabilities?(): Promise<{ video: boolean; audio: boolean }>;
}

export class NativeMediaStreamBridge {
  private audioContext: AudioContext | null = null;
  private videoCanvas: HTMLCanvasElement | null = null;
  private videoContext: CanvasRenderingContext2D | null = null;
  private isActive: boolean = false;
  private audioBufferQueue: Float32Array[][] = [];
  private frameCount: number = 0;
  private scriptProcessor: ScriptProcessorNode | null = null;

  async createFullNativeStream(
    sourceConfig: { width?: number; height?: number; frameRate?: number }
  ): Promise<{ mediaStream: MediaStream; bridge: NativeMediaStreamBridge }> {
    console.log('[NativeMediaStreamBridge] Creating full native stream:', sourceConfig);
    
    try {
      // Инициализируем видео канвас
      this.videoCanvas = document.createElement('canvas');
      this.videoCanvas.width = sourceConfig.width || 1920;
      this.videoCanvas.height = sourceConfig.height || 1080;
      this.videoContext = this.videoCanvas.getContext('2d', {
        alpha: false,
        desynchronized: true,
        willReadFrequently: true
      });

      if (!this.videoContext) {
        throw new Error('Failed to get canvas context');
      }

      // Создаем видео поток из канваса
      const videoStream = this.videoCanvas.captureStream(sourceConfig.frameRate || 30);
      const videoTrack = videoStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'detail';
        (videoTrack as any)._isNativeTrack = true;
      }
      
      // Создаем аудио контекст и поток
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'interactive'
      });

      // Используем ScriptProcessorNode для обработки аудио
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 0, 2);
      
      this.scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        const outputBuffer = audioProcessingEvent.outputBuffer;
        
        // Заполняем аудио буфер данными из очереди
        for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
          const outputData = outputBuffer.getChannelData(channel);
          
          if (this.audioBufferQueue.length > 0) {
            const audioData = this.audioBufferQueue.shift();
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

      // Создаем destination и получаем аудио трек
      const destination = this.audioContext.createMediaStreamDestination();
      this.scriptProcessor.connect(destination);
      
      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack) {
        (audioTrack as any)._isSystemAudio = true;
        (audioTrack as any)._isNativeTrack = true;
      }

      // Запускаем обработку фреймов
      this.isActive = true;
      this.startNativeProcessing();

      // Создаем итоговый MediaStream
      const tracks: MediaStreamTrack[] = [];
      if (videoTrack) tracks.push(videoTrack);
      if (audioTrack) tracks.push(audioTrack);
      const mediaStream = new MediaStream(tracks);
      
      console.log('[NativeMediaStreamBridge] Full native stream created successfully');
      return { mediaStream, bridge: this };
      
    } catch (error) {
      console.error('[NativeMediaStreamBridge] Error creating native stream:', error);
      this.cleanup();
      throw error;
    }
  }

  async createSystemAudioTrack(): Promise<MediaStreamTrack> {
    console.log('[NativeMediaStreamBridge] Creating system audio track only');
    
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'interactive'
      });

      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 0, 2);
      
      this.scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        const outputBuffer = audioProcessingEvent.outputBuffer;
        
        for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
          const outputData = outputBuffer.getChannelData(channel);
          
          if (this.audioBufferQueue.length > 0) {
            const audioData = this.audioBufferQueue.shift();
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

      const destination = this.audioContext.createMediaStreamDestination();
      this.scriptProcessor.connect(destination);
      
      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack) {
        (audioTrack as any)._isSystemAudio = true;
        (audioTrack as any)._isNativeTrack = true;
      }

      // Запускаем только аудио обработку
      this.isActive = true;
      this.startAudioProcessing();

      console.log('[NativeMediaStreamBridge] System audio track created successfully');
      return audioTrack;
      
    } catch (error) {
      console.error('[NativeMediaStreamBridge] Error creating audio track:', error);
      this.cleanup();
      throw error;
    }
  }

  private startNativeProcessing(): void {
    // Слушаем события от preload
    window.addEventListener('native-video-frame', this.handleVideoFrame.bind(this));
    window.addEventListener('native-audio-frame', this.handleAudioFrame.bind(this));
  }

  private startAudioProcessing(): void {
    // Только аудио события
    window.addEventListener('native-audio-frame', this.handleAudioFrame.bind(this));
  }

  private handleVideoFrame(event: CustomEvent): void {
    if (!this.isActive || !this.videoContext) return;

    const frameData = event.detail as NativeFrameData;
    if (!frameData || !frameData.data) return;

    try {
      // Создаем ImageData из буфера
      const imageData = new ImageData(
        new Uint8ClampedArray(frameData.data),
        frameData.width || this.videoCanvas!.width,
        frameData.height || this.videoCanvas!.height
      );
      
      // Рисуем на канвас
      this.videoContext.putImageData(imageData, 0, 0);
      this.frameCount++;
      
      // Логирование для отладки
      if (this.frameCount % 30 === 0) {
        console.log(`[NativeMediaStreamBridge] Processed ${this.frameCount} video frames`);
      }
    } catch (error) {
      console.error('[NativeMediaStreamBridge] Error processing video frame:', error);
    }
  }

  private handleAudioFrame(event: CustomEvent): void {
    if (!this.isActive) return;

    const audioFrame = event.detail as NativeFrameData;
    if (!audioFrame || !audioFrame.data) return;

    try {
      // Преобразуем данные в Float32Array для каждого канала
      const channelData: Float32Array[] = [];
      const channels = audioFrame.channels || 2;
      const dataArray = new Int16Array(audioFrame.data);
      const samplesPerChannel = dataArray.length / channels;
      
      for (let channel = 0; channel < channels; channel++) {
        const channelArray = new Float32Array(samplesPerChannel);
        for (let i = 0; i < samplesPerChannel; i++) {
          // Нормализуем значения из Int16 в Float32 (-1.0 to 1.0)
          const sampleIndex = i * channels + channel;
          channelArray[i] = dataArray[sampleIndex] / 32768.0;
        }
        channelData.push(channelArray);
      }
      
      // Добавляем в очередь
      this.audioBufferQueue.push(channelData);
      
      // Ограничиваем размер очереди
      if (this.audioBufferQueue.length > 10) {
        this.audioBufferQueue.shift();
      }
    } catch (error) {
      console.error('[NativeMediaStreamBridge] Error processing audio frame:', error);
    }
  }

  stop(): void {
    console.log('[NativeMediaStreamBridge] Stopping native processing');
    this.isActive = false;
    
    // Удаляем слушатели событий
    window.removeEventListener('native-video-frame', this.handleVideoFrame.bind(this));
    window.removeEventListener('native-audio-frame', this.handleAudioFrame.bind(this));
    
    this.cleanup();
  }

  private cleanup(): void {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.videoCanvas) {
      const stream = this.videoCanvas.captureStream();
      stream.getTracks().forEach(track => track.stop());
      this.videoCanvas = null;
      this.videoContext = null;
    }

    this.audioBufferQueue = [];
    this.frameCount = 0;
  }
}