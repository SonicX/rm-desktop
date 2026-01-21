// App/renderer/js/jitsi-native-stream.ts
/* eslint-disable @typescript-eslint/triple-slash-reference, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises, @typescript-eslint/member-ordering, @typescript-eslint/no-this-alias, unicorn/no-this-assignment, promise/prefer-await-to-then, @typescript-eslint/no-unused-vars */
/// <reference path="../../../../typings.d.ts" />

import log from "electron-log/renderer";

export class JitsiNativeStreamIntegration {
  private nativeStream: MediaStream | null = null;
  private videoCanvas: HTMLCanvasElement | null = null;
  private audioContext: AudioContext | null = null;
  private isStreamActive = false;
  private frameUpdateInterval: number | null = null;

  constructor() {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Слушаем события от electron_bridge
    if (window.electron_bridge) {
      window.electron_bridge.on_event("native-capture-started", (data: any) => {
        console.log("[JitsiNative] Native capture started:", data);
        this.createMediaStreamFromNative();
      });

      window.electron_bridge.on_event("native-capture-stopped", () => {
        console.log("[JitsiNative] Native capture stopped");
        this.stopNativeStream();
      });
    }
  }

  /**
   * Создает MediaStream из нативных фреймов
   */
  async createMediaStreamFromNative(): Promise<MediaStream> {
    console.log("[JitsiNative] Creating MediaStream from native frames");

    try {
      // Создаем canvas для видео
      this.videoCanvas = document.createElement("canvas");
      this.videoCanvas.width = 1920;
      this.videoCanvas.height = 1080;
      const context = this.videoCanvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
      });

      if (!context) {
        throw new Error("Failed to get canvas context");
      }

      // Создаем аудио контекст
      this.audioContext = new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });

      // Создаем ScriptProcessor для аудио
      const scriptProcessor = this.audioContext.createScriptProcessor(
        4096,
        0,
        2,
      );
      const audioQueue: Float32Array[][] = [];

      scriptProcessor.onaudioprocess = (event) => {
        const {outputBuffer} = event;

        for (
          let channel = 0;
          channel < outputBuffer.numberOfChannels;
          channel++
        ) {
          const outputData = outputBuffer.getChannelData(channel);

          if (audioQueue.length > 0) {
            const audioData = audioQueue.shift();
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

      // Запускаем обновление фреймов
      this.isStreamActive = true;
      this.startFrameUpdates(context, audioQueue);

      // Получаем треки
      const videoStream = this.videoCanvas.captureStream(30);
      const videoTrack = videoStream.getVideoTracks()[0];
      const audioTrack = destination.stream.getAudioTracks()[0];

      // Создаем итоговый MediaStream
      const tracks: MediaStreamTrack[] = [];
      if (videoTrack) {
        videoTrack.contentHint = "detail";
        tracks.push(videoTrack);
      }

      if (audioTrack) {
        (audioTrack as any)._isSystemAudio = true;
        tracks.push(audioTrack);
      }

      this.nativeStream = new MediaStream(tracks);

      console.log(
        "[JitsiNative] MediaStream created with tracks:",
        tracks.length,
      );
      return this.nativeStream;
    } catch (error) {
      console.error("[JitsiNative] Error creating MediaStream:", error);
      throw error;
    }
  }

  /**
   * Обновление фреймов из нативного захвата
   */
  private async startFrameUpdates(
    context: CanvasRenderingContext2D,
    audioQueue: Float32Array[][],
  ) {
    let frameCount = 0;

    const updateFrames = async () => {
      if (!this.isStreamActive || !window.ipcRenderer) return;

      try {
        // Получаем фреймы от main процесса
        const frames = await window.ipcRenderer.invoke("get-native-frames");

        // Обрабатываем видео фреймы
        if (frames.video && frames.video.length > 0) {
          const latestFrame = frames.video.at(-1);

          // Конвертируем ArrayBuffer в ImageData
          const uint8Array = new Uint8ClampedArray(latestFrame);
          const imageData = new ImageData(uint8Array, 1920, 1080);

          // Рисуем на canvas
          context.putImageData(imageData, 0, 0);

          frameCount++;
          if (frameCount % 30 === 0) {
            console.log(`[JitsiNative] Processed ${frameCount} video frames`);
          }
        }

        // Обрабатываем аудио фреймы
        if (frames.audio && frames.audio.length > 0) {
          for (const audioFrame of frames.audio) {
            // Конвертируем ArrayBuffer в Float32Array для каждого канала
            const int16Array = new Int16Array(audioFrame);
            const channels = 2;
            const samplesPerChannel = int16Array.length / channels;
            const channelData: Float32Array[] = [];

            for (let channel = 0; channel < channels; channel++) {
              const float32Array = new Float32Array(samplesPerChannel);
              for (let i = 0; i < samplesPerChannel; i++) {
                const sampleIndex = i * channels + channel;
                // Нормализуем int16 в float32 [-1, 1]
                float32Array[i] = int16Array[sampleIndex] / 32_768;
              }

              channelData.push(float32Array);
            }

            audioQueue.push(channelData);

            // Ограничиваем размер очереди
            if (audioQueue.length > 10) {
              audioQueue.shift();
            }
          }
        }
      } catch (error) {
        console.error("[JitsiNative] Error updating frames:", error);
      }

      // Продолжаем обновление
      if (this.isStreamActive) {
        this.frameUpdateInterval = window.setTimeout(updateFrames, 33); // ~30 FPS
      }
    };

    updateFrames();
  }

  /**
   * Остановка нативного потока
   */
  stopNativeStream() {
    console.log("[JitsiNative] Stopping native stream");

    this.isStreamActive = false;

    if (this.frameUpdateInterval) {
      clearTimeout(this.frameUpdateInterval);
      this.frameUpdateInterval = null;
    }

    if (this.nativeStream) {
      for (const track of this.nativeStream.getTracks()) track.stop();
      this.nativeStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.videoCanvas &&= null;
  }

  /**
   * Получение текущего MediaStream для Jitsi
   */
  getNativeStream(): MediaStream | null {
    return this.nativeStream;
  }

  /**
   * Интеграция с Jitsi - переопределение getDisplayMedia
   */
  async injectIntoJitsi(jitsiWindow: Window) {
    console.log("[JitsiNative] Injecting into Jitsi");

    const originalGetDisplayMedia =
      jitsiWindow.navigator.mediaDevices.getDisplayMedia;
    const self = this;

    // Переопределяем getDisplayMedia
    jitsiWindow.navigator.mediaDevices.getDisplayMedia = async function (
      constraints?: MediaStreamConstraints,
    ) {
      console.log("[JitsiNative] getDisplayMedia intercepted");

      // Если есть активный нативный поток, возвращаем его
      if (self.nativeStream && self.isStreamActive) {
        console.log("[JitsiNative] Returning native stream");
        return self.nativeStream;
      }

      // Иначе создаем новый
      try {
        const stream = await self.createMediaStreamFromNative();
        console.log("[JitsiNative] Created and returning new native stream");
        return stream;
      } catch (error) {
        console.error(
          "[JitsiNative] Failed to create native stream, falling back",
          error,
        );
        // Fallback на оригинальный метод
        return originalGetDisplayMedia.call(this, constraints);
      }
    };

    // Также переопределяем для JitsiMeetScreenObtainer если он есть
    if ((jitsiWindow as any).JitsiMeetScreenObtainer) {
      const obtainer = (jitsiWindow as any).JitsiMeetScreenObtainer;

      const originalOpenDesktopPicker = obtainer.openDesktopPicker;
      obtainer.openDesktopPicker = function (options: any, callback: Function) {
        console.log("[JitsiNative] Desktop picker intercepted");

        // Если есть нативный захват, сразу возвращаем его ID
        window.ipcRenderer?.invoke("get-capture-status").then((status: any) => {
          if (status.isCapturing && status.currentSourceId) {
            console.log("[JitsiNative] Using existing native capture");
            callback(`native:${status.currentSourceId}:0`, {audio: false});
          } else {
            // Открываем селектор источников
            window.ipcRenderer
              ?.invoke("open-source-selector")
              .then((result: any) => {
                if (result.success && result.sourceId) {
                  // Запускаем захват
                  window.ipcRenderer
                    ?.invoke("start-native-capture", result.sourceId)
                    .then(() => {
                      callback(`native:${result.sourceId}:0`, {audio: true});
                    });
                } else {
                  // Fallback на оригинальный метод
                  originalOpenDesktopPicker.call(this, options, callback);
                }
              });
          }
        });
      };
    }
  }
}
