// App/renderer/js/native-integration/macos-native-capture.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/member-ordering, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unused-vars, @typescript-eslint/naming-convention */

type MacOSNativeCapture = {
  startCapture(config: any): Promise<{success: boolean; error?: string}>;
  stopCapture(): Promise<{success: boolean; error?: string}>;
  getVideoFrame(): Promise<any>;
  getAudioFrame(): Promise<any>;
  getAvailableSources(): Promise<any[]>;
};

export class MacOSNativeCaptureIntegration {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private videoCanvas: HTMLCanvasElement | null = null;
  private videoContext: CanvasRenderingContext2D | null = null;
  private isCapturing = false;
  private frameProcessor: number | null = null;
  private audioProcessor: number | null = null;

  constructor() {
    console.log("[MacOSNative] Integration initialized");
  }

  /**
   * Создает MediaStream с системным звуком для Jitsi
   */
  async createNativeMediaStream(sourceId: string): Promise<MediaStream> {
    console.log(
      "[MacOSNative] Creating native media stream for source:",
      sourceId,
    );

    try {
      // Останавливаем предыдущий захват если был
      await this.stopCapture();

      // Создаем canvas для видео
      this.videoCanvas = document.createElement("canvas");
      this.videoCanvas.width = 1920;
      this.videoCanvas.height = 1080;
      this.videoContext = this.videoCanvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
      });

      if (!this.videoContext) {
        throw new Error("Failed to get canvas context");
      }

      // Получаем видео поток из canvas
      const videoStream = this.videoCanvas.captureStream(30);
      const videoTrack = videoStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = "detail";
      }

      // Создаем аудио контекст для системного звука
      this.audioContext = new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });

      // Создаем обработчик аудио
      const scriptProcessor = this.audioContext.createScriptProcessor(
        4096,
        0,
        2,
      );
      const audioBufferQueue: Float32Array[][] = [];

      scriptProcessor.onaudioprocess = (event) => {
        const {outputBuffer} = event;

        for (
          let channel = 0;
          channel < outputBuffer.numberOfChannels;
          channel++
        ) {
          const outputData = outputBuffer.getChannelData(channel);

          if (audioBufferQueue.length > 0) {
            const audioData = audioBufferQueue.shift();
            if (audioData?.[channel]) {
              outputData.set(audioData[channel]);
            } else {
              outputData.fill(0);
            }
          } else {
            outputData.fill(0);
          }
        }
      };

      // Подключаем к destination
      const destination = this.audioContext.createMediaStreamDestination();
      scriptProcessor.connect(destination);

      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack) {
        (audioTrack as any)._isSystemAudio = true;
      }

      // Запускаем захват через нативный аддон
      const startResult = await (window as any).screenCapture?.startCapture({
        sourceId,
        width: 1920,
        height: 1080,
        frameRate: 30,
        enableAppSpecificAudio: true,
      });

      if (!startResult?.success) {
        throw new Error(startResult?.error || "Failed to start native capture");
      }

      // Начинаем обработку фреймов
      this.isCapturing = true;
      this.startFrameProcessing(audioBufferQueue);

      // Создаем итоговый MediaStream
      const tracks: MediaStreamTrack[] = [];
      if (videoTrack) tracks.push(videoTrack);
      if (audioTrack) tracks.push(audioTrack);

      this.mediaStream = new MediaStream(tracks);

      console.log("[MacOSNative] Native media stream created successfully");
      return this.mediaStream;
    } catch (error) {
      console.error("[MacOSNative] Error creating media stream:", error);
      await this.stopCapture();
      throw error;
    }
  }

  /**
   * Обработка видео и аудио фреймов от нативного аддона
   */
  private startFrameProcessing(audioBufferQueue: Float32Array[][]): void {
    let frameCount = 0;

    // Обработка видео фреймов
    const processVideoFrame = async () => {
      if (!this.isCapturing) return;

      try {
        const frameData = await (window as any).screenCapture?.getVideoFrame();

        if (frameData?.data && this.videoContext) {
          // Создаем ImageData из буфера
          const imageData = new ImageData(
            new Uint8ClampedArray(frameData.data),
            frameData.width || 1920,
            frameData.height || 1080,
          );

          // Рисуем на canvas
          this.videoContext.putImageData(imageData, 0, 0);
          frameCount++;

          if (frameCount % 30 === 0) {
            console.log(`[MacOSNative] Processed ${frameCount} video frames`);
          }
        }
      } catch (error) {
        console.error("[MacOSNative] Error processing video frame:", error);
      }

      this.frameProcessor = requestAnimationFrame(processVideoFrame);
    };

    // Обработка аудио фреймов
    const processAudioFrame = async () => {
      if (!this.isCapturing) return;

      try {
        const audioFrame = await (window as any).screenCapture?.getAudioFrame();

        if (audioFrame?.data) {
          // Преобразуем данные для Web Audio API
          const channels = audioFrame.channels || 2;
          const dataArray = new Int16Array(audioFrame.data);
          const samplesPerChannel = dataArray.length / channels;
          const channelData: Float32Array[] = [];

          for (let channel = 0; channel < channels; channel++) {
            const channelArray = new Float32Array(samplesPerChannel);
            for (let i = 0; i < samplesPerChannel; i++) {
              const sampleIndex = i * channels + channel;
              channelArray[i] = dataArray[sampleIndex] / 32_768;
            }

            channelData.push(channelArray);
          }

          audioBufferQueue.push(channelData);

          // Ограничиваем размер очереди
          if (audioBufferQueue.length > 10) {
            audioBufferQueue.shift();
          }
        }
      } catch (error) {
        console.error("[MacOSNative] Error processing audio frame:", error);
      }

      this.audioProcessor = window.setTimeout(processAudioFrame, 10);
    };

    // Запускаем обработку
    processVideoFrame();
    processAudioFrame();
  }

  /**
   * Остановка захвата
   */
  async stopCapture(): Promise<void> {
    console.log("[MacOSNative] Stopping capture");

    this.isCapturing = false;

    // Останавливаем обработку фреймов
    if (this.frameProcessor) {
      cancelAnimationFrame(this.frameProcessor);
      this.frameProcessor = null;
    }

    if (this.audioProcessor) {
      clearTimeout(this.audioProcessor);
      this.audioProcessor = null;
    }

    // Останавливаем треки
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop();
      this.mediaStream = null;
    }

    // Закрываем аудио контекст
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    // Очищаем canvas
    if (this.videoCanvas) {
      const stream = this.videoCanvas.captureStream();
      for (const track of stream.getTracks()) track.stop();
      this.videoCanvas = null;
      this.videoContext = null;
    }

    // Останавливаем нативный захват
    try {
      await (window as any).screenCapture?.stopCapture();
    } catch (error) {
      console.error("[MacOSNative] Error stopping native capture:", error);
    }
  }

  /**
   * Получение текущего MediaStream
   */
  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  /**
   * Проверка доступности нативного захвата
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const {screenCapture} = window as any;
      return Boolean(
        screenCapture &&
          typeof screenCapture.startCapture === "function" &&
          typeof screenCapture.getVideoFrame === "function" &&
          typeof screenCapture.getAudioFrame === "function",
      );
    } catch {
      return false;
    }
  }
}
