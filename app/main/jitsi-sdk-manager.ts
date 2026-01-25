// Jitsi-sdk-manager.ts - Модуль для работы с Jitsi через SDK
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-floating-promises, @typescript-eslint/naming-convention, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unused-vars, @typescript-eslint/member-ordering, eqeqeq, @typescript-eslint/no-unsafe-call, no-promise-executor-return, @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, no-await-in-loop, @typescript-eslint/no-unsafe-return, import/no-extraneous-dependencies, @typescript-eslint/parameter-properties, no-eq-null */
import {BrowserWindow, ipcMain} from "electron/main"; // eslint-disable-line no-restricted-imports
import * as path from "node:path";

import log from "electron-log/main";
import Store from "electron-store";

import {ElectronSourcePicker} from "./electron-source-picker.js";
import {AudioSessionService} from "./services/audioSessionService.js";

// Интерфейсы
type JitsiOptions = {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
  topic?: string;
  stream?: string;
  enableScreenPicker?: boolean;
  selectedSourceId?: string;
};

type JitsiSDKState = {
  window: BrowserWindow | null;
  isConnected: boolean;
  conferenceUrl: string | null;
};

const store = new Store();

export class JitsiSDKManager {
  private readonly closureFunction: (roomName: string) => void;

  private readonly state: JitsiSDKState = {
    window: null,
    isConnected: false,
    conferenceUrl: null,
  };

  private readonly iconPath: string;
  private currentRoomName = "";
  private readonly sourcePicker: ElectronSourcePicker;

  // Virtual Cable support (Windows)
  private useVirtualCableMode = false;
  private routedProcessPath: string | null = null;
  private readonly audioSessionService: AudioSessionService;

  // Native Capture Manager reference (для macOS нативного захвата)
  private nativeCaptureManager: any = null;

  constructor(iconPath: string, closure: (roomName: string) => void) {
    this.closureFunction = closure;
    this.iconPath = iconPath;
    this.sourcePicker = new ElectronSourcePicker();
    this.audioSessionService = new AudioSessionService();

    this.initializeSDK();
    this.registerHandlers();

    log.info("[JITSI-SDK] Manager created");
  }

  /**
   * Устанавливает ссылку на NativeCaptureManager для нативного захвата на macOS
   */
  setNativeCaptureManager(manager: any): void {
    this.nativeCaptureManager = manager;
    log.info("[JITSI-SDK] NativeCaptureManager reference set");
  }

  private setupJitsiIPC(): void {
    if (!this.state.window) return;

    this.state.window.webContents.on(
      "ipc-message",
      async (event, channel, ...arguments_) => {
        log.info(`[JITSI-SDK] IPC message from Jitsi: ${channel}`);

        if (channel === "show-screen-picker") {
          await this.handleScreenPickerRequest();
        }
      },
    );
  }

  private async handleScreenPickerRequest(): Promise<void> {
    log.info("[JITSI-SDK] Handling screen picker request from Jitsi");

    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] No window available for picker");
      return;
    }

    try {
      const sources = await this.sourcePicker.getSources();
      log.info(`[JITSI-SDK] Got ${sources.length} sources for picker`);

      if (sources.length === 0) {
        log.warn("[JITSI-SDK] No sources available");

        await this.state.window.webContents.executeJavaScript(`
          window.pickerCancelled = true;
        `);
        return;
      }

      const selectedSource = await this.sourcePicker.showPicker(sources);

      if (selectedSource) {
        log.info(
          `[JITSI-SDK] User selected: ${selectedSource.name} (${selectedSource.id})`,
        );

        // Запускаем нативный захват на macOS
        if (process.platform === "darwin" && this.nativeCaptureManager) {
          try {
            log.info(`[JITSI-SDK] Starting native capture for source: ${selectedSource.id}`);

            // Устанавливаем callback для пересылки аудио в Jitsi
            this.nativeCaptureManager.setAudioDataCallback((audioData: ArrayBuffer) => {
              this.sendNativeAudioToJitsi(audioData);
            });

            // startCapture уже сам парсит sourceId и устанавливает источник
            const result = await this.nativeCaptureManager.startCapture(selectedSource.id);

            if (result.success) {
              log.info(`[JITSI-SDK] Native capture started successfully`);

              // ВАЖНО: Активируем bridge СИНХРОННО и ждём завершения
              // Это должно быть ПЕРЕД установкой selectedSourceId
              const activationResult = await this.state.window.webContents.executeJavaScript(`
                (function() {
                  if (window.nativeAudioBridge && window.nativeAudioBridge.activate) {
                    window.nativeAudioBridge.activate();
                    console.log('[NATIVE-AUDIO] Bridge activated BEFORE setting selectedSourceId');
                    return { activated: true };
                  } else {
                    console.error('[NATIVE-AUDIO] Bridge not available for activation!');
                    return { activated: false, error: 'bridge not available' };
                  }
                })();
              `);

              log.info(`[JITSI-SDK] Bridge activation result: ${JSON.stringify(activationResult)}`);

              // Обновляем индикатор статуса
              this.updateAudioStatus(true, 0);
            } else {
              log.error(`[JITSI-SDK] Native capture failed: ${result.error}`);
            }
          } catch (error: any) {
            log.error(`[JITSI-SDK] Failed to start native capture: ${error.message}`);
          }
        }

        // Устанавливаем selectedSourceId ПОСЛЕ активации bridge
        // Jitsi продолжит работу с этим sourceId и увидит что bridge активен
        await this.state.window.webContents.executeJavaScript(`
          (function() {
            window.selectedSourceId = '${selectedSource.id}';
            console.log('[JITSI] Source selected:', window.selectedSourceId, 'nativeCaptureActive:', window.nativeCaptureActive);
          })();
        `);
      } else {
        log.info("[JITSI-SDK] User cancelled screen selection");

        await this.state.window.webContents.executeJavaScript(`
          window.pickerCancelled = true;
        `);
      }
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error in screen picker: ${error.message}`);

      await this.state.window.webContents.executeJavaScript(`
        window.pickerCancelled = true;
      `);
    }
  }

  private initializeSDK(): void {
    try {
      const jitsiSDK = require("@jitsi/electron-sdk");

      if (jitsiSDK.setupAlwaysOnTopMain) {
        try {
          jitsiSDK.setupAlwaysOnTopMain();
          log.info("[JITSI-SDK] Always on top initialized");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup always on top: ${error.message}`,
          );
        }
      }

      if (jitsiSDK.setupPowerMonitorMain) {
        try {
          jitsiSDK.setupPowerMonitorMain();
          log.info("[JITSI-SDK] Power monitor initialized");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup power monitor: ${error.message}`,
          );
        }
      }

      log.info("[JITSI-SDK] SDK helper functions initialized");
    } catch (error: any) {
      log.warn(
        `[JITSI-SDK] SDK not available or failed to initialize: ${error.message}`,
      );
    }
  }

  private initializeSDKScreenSharing(): void {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      const jitsiSDK = require("@jitsi/electron-sdk");

      if (jitsiSDK.setupScreenSharingMain) {
        try {
          jitsiSDK.setupScreenSharingMain(this.state.window.webContents, {});
          log.info("[JITSI-SDK] Screen sharing initialized with window");
        } catch (error: any) {
          log.warn(
            `[JITSI-SDK] Failed to setup screen sharing: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      log.warn(
        `[JITSI-SDK] Failed to initialize screen sharing: ${error.message}`,
      );
    }
  }

  private async injectAudioMuteIndicatorButton(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const BUTTON_ID = 'electron-audio-mute-indicator-btn';
          if (document.getElementById(BUTTON_ID)) return;

          const btn = document.createElement('button');
          btn.id = BUTTON_ID;
          btn.style.cssText = \`
            position: fixed;
            bottom: 16px;
            left: 20px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: white;
            border: 2px solid #000;
            font-size: 20px;
            color: black;
            cursor: pointer;
            z-index: 2147483646;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
            transition: all 0.2s ease;
          \`;

          function updateIcon(isMuted) {
            btn.textContent = isMuted ? '🔕' : '🔔';
          }

          // Получаем текущее состояние звука из Electron (через флаг)
          function getCurrentMutedState() {
            return window.electronAudioMuted ?? false;
          }

          updateIcon(getCurrentMutedState());

          btn.onclick = () => {
            const newMuted = !getCurrentMutedState();
            window.electronRequestAudioMute = newMuted;
            updateIcon(newMuted);
          };

          document.body.appendChild(btn);
          console.log('[ELECTRON-BTN] Audio mute indicator button injected');
        })();
      `);

      log.info("[JITSI-SDK] Audio mute indicator button injected");
    } catch (error: any) {
      log.error(
        `[JITSI-SDK] Failed to inject audio mute indicator button: ${error.message}`,
      );
    }
  }

  // Состояние нативного плагина для индикатора
  private nativePluginStatus = {
    isLoaded: false,
    isAudioActive: false,
    audioPacketCount: 0,
  };

  /**
   * Инжектит индикатор статуса нативного плагина (две точки в левом верхнем углу)
   * - Первая точка: зеленая если плагин загружен, синяя если нет
   * - Вторая точка: зеленая если аудио пакеты идут, синяя если нет
   */
  private async injectNativeStatusIndicator(nativeAvailable: boolean): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    this.nativePluginStatus.isLoaded = nativeAvailable;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          const INDICATOR_ID = 'native-status-indicator';
          if (document.getElementById(INDICATOR_ID)) return;

          // Контейнер индикатора
          const container = document.createElement('div');
          container.id = INDICATOR_ID;
          container.style.cssText = \`
            position: fixed;
            top: 12px;
            left: 12px;
            display: flex;
            gap: 6px;
            padding: 6px 10px;
            background: rgba(0, 0, 0, 0.6);
            border-radius: 12px;
            z-index: 2147483647;
            align-items: center;
            backdrop-filter: blur(8px);
            transition: opacity 0.3s;
          \`;

          // Первая точка - статус плагина
          const pluginDot = document.createElement('div');
          pluginDot.id = 'plugin-status-dot';
          pluginDot.style.cssText = \`
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: ${nativeAvailable ? '#4CAF50' : '#2196F3'};
            transition: background 0.3s;
            box-shadow: 0 0 4px rgba(0,0,0,0.3);
          \`;
          pluginDot.title = 'Plugin: ' + (${nativeAvailable} ? 'Loaded' : 'Not loaded');

          // Вторая точка - статус аудио
          const audioDot = document.createElement('div');
          audioDot.id = 'audio-status-dot';
          audioDot.style.cssText = \`
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #2196F3;
            transition: background 0.3s;
            box-shadow: 0 0 4px rgba(0,0,0,0.3);
          \`;
          audioDot.title = 'Audio: Waiting';

          container.appendChild(pluginDot);
          container.appendChild(audioDot);
          document.body.appendChild(container);

          // Функция обновления индикатора
          window.updateNativeStatusIndicator = function(status) {
            const pluginDot = document.getElementById('plugin-status-dot');
            const audioDot = document.getElementById('audio-status-dot');

            if (pluginDot && status.pluginLoaded !== undefined) {
              pluginDot.style.background = status.pluginLoaded ? '#4CAF50' : '#2196F3';
              pluginDot.title = 'Plugin: ' + (status.pluginLoaded ? 'Loaded' : 'Not loaded');
            }

            if (audioDot && status.audioActive !== undefined) {
              audioDot.style.background = status.audioActive ? '#4CAF50' : '#2196F3';
              audioDot.title = 'Audio: ' + (status.audioActive ? 'Active (' + (status.packetCount || 0) + ' packets)' : 'Inactive');

              // Пульсация если активен
              if (status.audioActive) {
                audioDot.style.animation = 'none';
                audioDot.offsetHeight; // Trigger reflow
                audioDot.style.animation = 'pulse-dot 1s ease-in-out';
              }
            }
          };

          // CSS анимация пульсации
          if (!document.getElementById('native-indicator-styles')) {
            const style = document.createElement('style');
            style.id = 'native-indicator-styles';
            style.textContent = \`
              @keyframes pulse-dot {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.2); opacity: 0.8; }
              }
            \`;
            document.head.appendChild(style);
          }

          // Двойной клик скрывает индикатор
          container.ondblclick = function() {
            container.style.opacity = container.style.opacity === '0.1' ? '1' : '0.1';
          };

          console.log('[NATIVE-INDICATOR] Status indicator injected');
        })();
      `);

      log.info("[JITSI-SDK] Native status indicator injected");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject native status indicator: ${error.message}`);
    }
  }

  /**
   * Обновляет статус аудио в индикаторе
   */
  updateAudioStatus(isActive: boolean, packetCount?: number): void {
    this.nativePluginStatus.isAudioActive = isActive;
    if (packetCount !== undefined) {
      this.nativePluginStatus.audioPacketCount = packetCount;
    }

    if (this.state.window && !this.state.window.isDestroyed()) {
      this.state.window.webContents.executeJavaScript(`
        if (window.updateNativeStatusIndicator) {
          window.updateNativeStatusIndicator({
            pluginLoaded: ${this.nativePluginStatus.isLoaded},
            audioActive: ${isActive},
            packetCount: ${this.nativePluginStatus.audioPacketCount}
          });
        }
      `).catch(() => {});
    }
  }

  /**
   * Инжектит перехватчик getDisplayMedia для добавления нативного аудио в screen share
   * Это должно быть вызвано ДО начала screen share, чтобы перехватить создание стрима
   */
  private async injectNativeAudioBridge(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (async function() {
          if (window.nativeAudioBridge) {
            console.log('[NATIVE-AUDIO] Bridge already initialized');
            return { success: true, status: 'already_initialized' };
          }

          console.log('[NATIVE-AUDIO] Initializing native audio bridge with getDisplayMedia interception...');

          // Load IPC renderer
          let ipcRenderer;
          try {
            ipcRenderer = require('electron').ipcRenderer;
            console.log('[NATIVE-AUDIO] ipcRenderer loaded');
          } catch (e) {
            try {
              ipcRenderer = window.require('electron').ipcRenderer;
              console.log('[NATIVE-AUDIO] ipcRenderer loaded via window.require');
            } catch (e2) {
              console.error('[NATIVE-AUDIO] Failed to load ipcRenderer:', e2.message);
              return { success: false, error: 'ipcRenderer not available' };
            }
          }

          // Create audio context - check actual sample rate!
          const audioContext = new AudioContext({ sampleRate: 48000 });
          const actualSampleRate = audioContext.sampleRate;
          const inputSampleRate = 48000; // Native capture always sends 48kHz
          const resampleRatio = inputSampleRate / actualSampleRate;
          const needsResample = Math.abs(resampleRatio - 1.0) > 0.01;

          console.log('[NATIVE-AUDIO] AudioContext created, state:', audioContext.state);
          console.log('[NATIVE-AUDIO] Requested sampleRate: 48000, actual:', actualSampleRate);
          console.log('[NATIVE-AUDIO] Resample ratio:', resampleRatio.toFixed(4), 'needs resample:', needsResample);

          // Ring buffer for native audio (sized for actual sample rate)
          const BUFFER_SECONDS = 2;
          const BUFFER_SIZE = Math.ceil(actualSampleRate * 2 * BUFFER_SECONDS); // stereo
          const ringBuffer = new Float32Array(BUFFER_SIZE);
          let writePos = 0;
          let readPos = 0;
          let available = 0;
          let packetsReceived = 0;
          let lastLogTime = 0;

          // Resampling state (linear interpolation)
          let resampleAccumulator = 0;
          let lastSampleL = 0;
          let lastSampleR = 0;

          // Function to push audio data to ring buffer
          // ScreenCaptureKit sends PLANAR format: [L0 L1 L2...L959] [R0 R1 R2...R959]
          // We need to convert to INTERLEAVED: [L0 R0 L1 R1 L2 R2...]
          function pushAudioData(float32Array) {
            packetsReceived++;
            const totalSamples = float32Array.length;
            const samplesPerChannel = totalSamples / 2; // 960 samples per channel

            // Convert from planar to interleaved and write to ring buffer
            for (let i = 0; i < samplesPerChannel; i++) {
              const leftSample = float32Array[i];                        // First half is left channel
              const rightSample = float32Array[samplesPerChannel + i];   // Second half is right channel

              // Clamp and write interleaved
              ringBuffer[writePos] = Math.max(-1, Math.min(1, leftSample));
              ringBuffer[(writePos + 1) % BUFFER_SIZE] = Math.max(-1, Math.min(1, rightSample));
              writePos = (writePos + 2) % BUFFER_SIZE;
            }
            available += totalSamples; // totalSamples = samplesPerChannel * 2

            // Overflow prevention - keep buffer at ~200ms max
            const MAX_BUFFER = Math.ceil(actualSampleRate * 2 * 0.2); // 200ms stereo
            if (available > MAX_BUFFER) {
              const skip = available - MAX_BUFFER;
              readPos = (readPos + skip) % BUFFER_SIZE;
              available -= skip;
            }

            const now = Date.now();
            if (now - lastLogTime > 5000) {
              const latencyMs = Math.round(available / (actualSampleRate * 2) * 1000);
              console.log('[NATIVE-AUDIO] Packets:', packetsReceived, 'buffer:', available, 'latency:', latencyMs + 'ms');
              lastLogTime = now;
            }
          }

          // Register IPC listener for audio data (Float32)
          ipcRenderer.on('native-audio-data', (event, audioArrayBuffer) => {
            try {
              pushAudioData(new Float32Array(audioArrayBuffer));
            } catch (err) {
              console.error('[NATIVE-AUDIO] Error processing audio:', err);
            }
          });
          console.log('[NATIVE-AUDIO] IPC listener registered (Float32 mode)');

          // Create ScriptProcessor that reads from ring buffer
          function createNativeAudioTrack() {
            const scriptNode = audioContext.createScriptProcessor(2048, 0, 2); // Smaller buffer for lower latency

            // Pre-buffering: wait until we have enough data before starting playback
            // Use actual sample rate for calculation
            const MIN_BUFFER_SAMPLES = Math.ceil(actualSampleRate * 2 * 0.1); // 100ms stereo
            let playbackStarted = false;
            let lastOutputL = 0;
            let lastOutputR = 0;

            console.log('[NATIVE-AUDIO] ScriptProcessor created, MIN_BUFFER_SAMPLES:', MIN_BUFFER_SAMPLES);

            scriptNode.onaudioprocess = function(e) {
              const left = e.outputBuffer.getChannelData(0);
              const right = e.outputBuffer.getChannelData(1);
              const frameSamples = left.length;

              // Wait for pre-buffer before starting playback
              if (!playbackStarted) {
                if (available >= MIN_BUFFER_SAMPLES) {
                  playbackStarted = true;
                  console.log('[NATIVE-AUDIO] Pre-buffer filled, starting playback. Available:', available);
                } else {
                  // Output silence while waiting
                  for (let i = 0; i < frameSamples; i++) {
                    left[i] = 0;
                    right[i] = 0;
                  }
                  return;
                }
              }

              // Read from ring buffer
              for (let i = 0; i < frameSamples; i++) {
                if (available >= 2) {
                  lastOutputL = ringBuffer[readPos];
                  lastOutputR = ringBuffer[(readPos + 1) % BUFFER_SIZE];
                  left[i] = lastOutputL;
                  right[i] = lastOutputR;
                  readPos = (readPos + 2) % BUFFER_SIZE;
                  available -= 2;
                } else {
                  // Buffer underrun - fade out to avoid clicks
                  left[i] = lastOutputL * 0.9;
                  right[i] = lastOutputR * 0.9;
                  lastOutputL *= 0.9;
                  lastOutputR *= 0.9;
                }
              }
            };

            const dest = audioContext.createMediaStreamDestination();
            scriptNode.connect(dest);

            console.log('[NATIVE-AUDIO] Created audio track from ScriptProcessor');
            return {
              track: dest.stream.getAudioTracks()[0],
              stream: dest.stream,
              scriptNode: scriptNode
            };
          }

          // Store reference to the hybrid stream for interception
          window.nativeHybridStream = null;
          window.nativeAudioNodes = null;

          // Save original getDisplayMedia
          const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

          // Override getDisplayMedia to inject native audio
          navigator.mediaDevices.getDisplayMedia = async function(constraints) {
            console.log('[NATIVE-AUDIO] getDisplayMedia intercepted!', constraints);

            // Get original display stream (video only from Electron)
            const displayStream = await originalGetDisplayMedia(constraints);
            console.log('[NATIVE-AUDIO] Original displayStream tracks:', displayStream.getTracks().map(t => t.kind + ':' + t.label).join(', '));

            // Check if native capture is active
            if (!window.nativeCaptureActive) {
              console.log('[NATIVE-AUDIO] Native capture not active, returning original stream');
              return displayStream;
            }

            // Create native audio track
            const audioNodes = createNativeAudioTrack();
            window.nativeAudioNodes = audioNodes;

            // Create hybrid stream with video from display + audio from native
            const hybridStream = new MediaStream();

            // Add video tracks from original stream
            displayStream.getVideoTracks().forEach(track => {
              hybridStream.addTrack(track);
              console.log('[NATIVE-AUDIO] Added video track to hybrid stream:', track.label);
            });

            // Remove any existing audio tracks from display stream (we'll use native instead)
            // Don't add original audio tracks

            // Add native audio track
            hybridStream.addTrack(audioNodes.track);
            console.log('[NATIVE-AUDIO] Added native audio track to hybrid stream');

            window.nativeHybridStream = hybridStream;

            console.log('[NATIVE-AUDIO] Returning hybrid stream with', hybridStream.getTracks().length, 'tracks:',
              hybridStream.getTracks().map(t => t.kind + ':' + t.label).join(', '));

            return hybridStream;
          };

          console.log('[NATIVE-AUDIO] getDisplayMedia overridden');

          // Override JitsiMeetJS.createLocalTracks to inject native audio for desktop sharing
          const waitForJitsi = setInterval(() => {
            if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
              clearInterval(waitForJitsi);

              const originalCreateLocalTracks = window.JitsiMeetJS.createLocalTracks.bind(window.JitsiMeetJS);

              window.JitsiMeetJS.createLocalTracks = async function(options) {
                console.log('[NATIVE-AUDIO] JitsiMeetJS.createLocalTracks intercepted:', JSON.stringify(options));

                // Check if this is for desktop/screen share
                const isDesktop = options && options.devices && options.devices.includes('desktop');

                // Call original FIRST - this will show picker and WAIT for user selection
                // During this wait, our handleScreenPickerRequest will activate the bridge
                const tracks = await originalCreateLocalTracks(options);
                console.log('[NATIVE-AUDIO] Original createLocalTracks returned', tracks.length, 'tracks');

                // NOW check if native capture became active (activated during picker selection)
                if (isDesktop && window.nativeCaptureActive) {
                  console.log('[NATIVE-AUDIO] Desktop tracks returned AND native capture is ACTIVE! Injecting audio...');

                  // Find the desktop video track
                  const desktopTrack = tracks.find(t => t.getType() === 'video' && t.videoType === 'desktop');

                  if (desktopTrack) {
                    console.log('[NATIVE-AUDIO] Found desktop video track, injecting native audio...');

                    // Create audio nodes if not already created
                    if (!window.nativeAudioNodes) {
                      window.nativeAudioNodes = createNativeAudioTrack();
                    }

                    // Get the original stream and add our audio track
                    const originalStream = desktopTrack.stream;
                    if (originalStream) {
                      console.log('[NATIVE-AUDIO] Original stream tracks:', originalStream.getTracks().map(t => t.kind + ':' + t.label).join(', '));

                      // Now we need to create a JitsiLocalTrack for the audio
                      // Use createLocalTracksFromMediaStreams if available
                      if (window.JitsiMeetJS.createLocalTracksFromMediaStreams) {
                        try {
                          console.log('[NATIVE-AUDIO] Creating JitsiLocalTrack for native audio...');
                          const audioTracks = await window.JitsiMeetJS.createLocalTracksFromMediaStreams([{
                            stream: window.nativeAudioNodes.stream,
                            sourceType: 'screen',
                            mediaType: 'audio',
                            videoType: 'desktop'
                          }]);

                          if (audioTracks && audioTracks.length > 0) {
                            console.log('[NATIVE-AUDIO] Created audio JitsiLocalTrack, adding to result');
                            tracks.push(audioTracks[0]);
                            console.log('[NATIVE-AUDIO] Now returning', tracks.length, 'tracks (video + audio)');
                          }
                        } catch (audioErr) {
                          console.error('[NATIVE-AUDIO] Failed to create audio track:', audioErr.message);

                          // Fallback: try to add audio directly to the video track's stream
                          try {
                            desktopTrack.stream.addTrack(window.nativeAudioNodes.track);
                            console.log('[NATIVE-AUDIO] Fallback: added audio to desktop track stream');
                          } catch (e) {
                            console.error('[NATIVE-AUDIO] Fallback also failed:', e.message);
                          }
                        }
                      } else {
                        // Fallback: add audio directly to the video track's stream
                        try {
                          desktopTrack.stream.addTrack(window.nativeAudioNodes.track);
                          console.log('[NATIVE-AUDIO] Added audio directly to desktop track stream (no createLocalTracksFromMediaStreams)');
                        } catch (e) {
                          console.error('[NATIVE-AUDIO] Failed to add audio to stream:', e.message);
                        }
                      }
                    }
                  } else {
                    console.log('[NATIVE-AUDIO] Desktop track not found in returned tracks');
                  }
                }

                return tracks;
              };

              console.log('[NATIVE-AUDIO] JitsiMeetJS.createLocalTracks overridden');
            }
          }, 100);

          setTimeout(() => clearInterval(waitForJitsi), 10000);

          // Resume audio context
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
            console.log('[NATIVE-AUDIO] AudioContext resumed');
          }

          // Store bridge reference
          window.nativeAudioBridge = {
            audioContext: audioContext,
            packetsReceived: () => packetsReceived,

            // Called when native capture starts
            activate: function() {
              window.nativeCaptureActive = true;
              console.log('[NATIVE-AUDIO] Native capture activated');
            },

            // Called when native capture stops
            deactivate: function() {
              window.nativeCaptureActive = false;
              if (window.nativeAudioNodes) {
                window.nativeAudioNodes.scriptNode.disconnect();
                window.nativeAudioNodes = null;
              }
              window.nativeHybridStream = null;
              console.log('[NATIVE-AUDIO] Native capture deactivated');
            },

            destroy: function() {
              ipcRenderer.removeAllListeners('native-audio-data');
              this.deactivate();
              audioContext.close();
              // Restore original getDisplayMedia
              navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
              window.nativeAudioBridge = null;
              console.log('[NATIVE-AUDIO] Bridge destroyed');
            }
          };

          console.log('[NATIVE-AUDIO] Bridge initialized successfully');
          return { success: true, status: 'initialized' };
        })();
      `);

      log.info(`[JITSI-SDK] Native audio bridge injection result: ${JSON.stringify(result)}`);
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject audio bridge: ${error.message}`);
    }
  }

  // Счетчик отправленных аудио пакетов
  private audioPacketsSent = 0;
  private lastAudioLogTime = 0;

  /**
   * Отправляет аудио данные в Jitsi окно через IPC (эффективнее чем executeJavaScript)
   */
  sendNativeAudioToJitsi(audioData: ArrayBuffer): void {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      // Отправляем через IPC - намного эффективнее чем executeJavaScript
      this.state.window.webContents.send('native-audio-data', audioData);
      this.audioPacketsSent++;

      // Логируем каждые 5 секунд
      const now = Date.now();
      if (now - this.lastAudioLogTime > 5000) {
        log.info(`[JITSI-SDK] Audio packets sent to Jitsi: ${this.audioPacketsSent}`);
        this.lastAudioLogTime = now;
      }
    } catch (error: any) {
      // Log only occasionally to avoid spam
      if (this.audioPacketsSent % 1000 === 0) {
        log.warn(`[JITSI-SDK] Error sending audio to Jitsi: ${error.message}`);
      }
    }
  }

  private startAudioMuteButtonPolling(): void {
    if (!this.state.window) return;

    const poll = async () => {
      if (!this.state.window || this.state.window.isDestroyed()) return;

      try {
        const muted = await this.state.window.webContents.executeJavaScript(`
          (window.electronRequestAudioMute !== undefined) ? window.electronRequestAudioMute : null
        `);

        if (typeof muted === "boolean") {
          await this.setLocalAudioMuted(muted);
          await this.state.window.webContents.executeJavaScript(`
            window.electronRequestAudioMute = undefined;
          `);
        }
      } catch {
        // Игнор
      }

      setTimeout(poll, 300);
    };

    poll();
  }

  private registerHandlers(): void {
    ipcMain.handle(
      "jitsi-sdk:create-window",
      async (event, options: JitsiOptions) => this.createWindow(options),
    );

    ipcMain.handle("focus_stream", (event, token: string) => {
      this.state.window?.show();
      this.state.window?.focus();
      this.state.window?.setAlwaysOnTop(true);
      this.state.window?.setAlwaysOnTop(false);
    });

    ipcMain.handle("jitsi-sdk:close", async () => this.closeWindow());

    ipcMain.handle("jitsi-sdk:get-status", async () => ({
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isConnected: this.state.isConnected,
      useVirtualCable: this.useVirtualCableMode,
    }));

    // Virtual Cable handlers
    ipcMain.handle("jitsi:set-virtual-cable-mode", async (event, enable: boolean) => {
      this.enableVirtualCableMode(enable);
    });

    ipcMain.handle("jitsi:get-virtual-cable-status", async () => {
      return this.isVirtualCableMode();
    });

    ipcMain.handle("jitsi:route-app-audio-to-cable", async (event, processPath: string) => {
      return this.routeAppAudioToCable(processPath);
    });

    ipcMain.handle("jitsi:restore-app-audio", async (event, processPath: string) => {
      return this.restoreAppAudio(processPath);
    });

    ipcMain.handle("jitsi:get-audio-sessions", async () => {
      try {
        const sessions = await this.audioSessionService.getAudioSessions();
        log.info(`[VC-MODE] Got ${sessions.length} audio sessions for picker`);
        // Фильтруем Electron
        return sessions.filter(s => !s.processName.toLowerCase().includes("electron"));
      } catch (error: any) {
        log.error(`[VC-MODE] Error getting audio sessions: ${error.message}`);
        return [];
      }
    });
  }

  async createWindow(
    options: JitsiOptions,
  ): Promise<{success: boolean; error?: string}> {
    try {
      const roomName = options.roomName.replaceAll(/[^\w-]/g, "");

      if (this.currentRoomName === roomName) {
        log.info(
          `[JITSI-SDK] Window already exists for room: ${roomName}, focusing existing window`,
        );
        this.state.window?.focus();
        return {success: false};
      }

      if (this.currentRoomName != "" && this.currentRoomName != roomName) {
        log.info(`[JITSI-SDK] Closing previous window for different room`);
        await this.closeWindow();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      this.currentRoomName = roomName;

      if (options.enableScreenPicker) {
        log.info(`[JITSI-SDK] Screen picker enabled, getting sources....`);

        try {
          const sources = await this.sourcePicker.getSources();
          log.info(
            `[JITSI-SDK] Got ${sources.length} sources for screen picker`,
          );

          if (sources.length === 0) {
            log.warn(`[JITSI-SDK] No sources available for screen sharing`);
          } else {
            for (const [i, s] of sources.slice(0, 3).entries()) {
              log.info(
                `[JITSI-SDK] Source ${i}: ${s.name} (${s.id}, type: ${s.type})`,
              );
            }

            log.info(`[JITSI-SDK] Opening picker dialog...`);
            const selectedSource = await this.sourcePicker.showPicker(sources);

            if (selectedSource) {
              log.info(
                `[JITSI-SDK] User selected source: ${selectedSource.name} (${selectedSource.id})`,
              );
              options.selectedSourceId = selectedSource.id;
            } else {
              log.info(
                `[JITSI-SDK] User cancelled screen selection or dialog closed`,
              );
            }
          }
        } catch (error: any) {
          log.error(`[JITSI-SDK] Error in screen picker: ${error.message}`);
        }
      }

      const server = options.serverUrl || "https://meet.jit.si";
      const displayName = options.displayName || "Guest";
      const topic = options.topic || "";
      const stream = options.stream || "";

      log.info(`[JITSI-SDK] Creating window for room: ${roomName}`);

      this.state.window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: `Трансляция: ${stream} - ${topic}`,
        icon: this.iconPath,
        center: true,
        show: false,
        backgroundColor: "#1a1a2e",
        webPreferences: {
          nodeIntegration: true, // Включаем для работы IPC при передаче аудио
          contextIsolation: false,
          sandbox: false,
          webSecurity: false,
          preload: this.getSDKPreloadPath(),
        },
      });

      this.setupWindowHandlers();
      this.initializeSDKScreenSharing();
      this.setupJitsiIPC();

      const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
      this.state.conferenceUrl = conferenceUrl;

      this.state.window.show();

      log.info(`[JITSI-SDK] Loading conference URL: ${conferenceUrl}`);

      await this.state.window.loadURL(conferenceUrl);
      await this.waitForConference();
      await this.injectConferenceHandlers();
      await this.injectAudioMuteIndicatorButton();

      // Инжектим индикатор статуса нативного плагина (macOS = true, другие платформы проверяем)
      const nativeAvailable = process.platform === "darwin"; // На macOS нативный плагин доступен
      await this.injectNativeStatusIndicator(nativeAvailable);

      // ВАЖНО: Инжектим audio bridge сразу после загрузки конференции
      // Это нужно сделать ДО начала screen share, чтобы перехватчик getDisplayMedia был готов
      if (process.platform === "darwin" && this.nativeCaptureManager) {
        log.info("[JITSI-SDK] Injecting native audio bridge for macOS...");
        await this.injectNativeAudioBridge();
      }

      this.startAudioMuteButtonPolling();

      log.info("[JITSI-SDK] Conference window created successfully");
      this.state.isConnected = true;

      return {success: true};
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to create window: ${error.message}`);

      this.currentRoomName = "";

      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.close();
        this.state.window = null;
      }

      return {success: false, error: error.message};
    }
  }

  async setLocalAudioMuted(muted: boolean): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot set audio muted - no window");
      return false;
    }

    try {
      this.state.window.webContents.setAudioMuted(muted);

      await this.state.window.webContents.executeJavaScript(`
      (function() {
        window.electronAudioMuted = ${muted};
        const btn = document.getElementById('electron-audio-mute-indicator-btn');
        if (btn) {
          btn.textContent = ${muted ? "'🔕'" : "'🔔'"};
        }
        console.log('[ELECTRON-AUDIO] Audio output ${muted ? "muted" : "unmuted"} via setLocalAudioMuted');
      })();
    `);

      log.info(`[JITSI-SDK] Audio output ${muted ? "muted" : "unmuted"}`);
      return true;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to mute audio: ${error.message}`);
      return false;
    }
  }

  async setLocalMicMuted(muted: boolean): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot set local audio input muted - no window");
      return false;
    }

    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (function(targetMuted) {
          try {
            if (window.APP?.conference?.toggleAudioMuted && typeof window.APP.conference.toggleAudioMuted === 'function') {
              const isCurrentlyMuted = window.APP.conference.isLocalAudioMuted?.();
              if (isCurrentlyMuted !== targetMuted) {
                console.log('[JITSI] Using toggleAudioMuted to ' + (targetMuted ? 'mute' : 'unmute'));
                window.APP.conference.toggleAudioMuted();
              }
              return true;
            }

            console.error('[JITSI] No method found to mute/unmute microphone');
            return false;
          } catch (e) {
            console.error('[JITSI] Error in set mic muted:', e);
            return false;
          }
        })(${muted});
      `);

      log.info(
        `[JITSI-SDK] Microphone ${muted ? "muted" : "unmuted"}: ${result}`,
      );
      return result;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to set microphone muted: ${error.message}`);
      return false;
    }
  }

  private getSDKPreloadPath(): string | undefined {
    try {
      const sdkPath = require.resolve("@jitsi/electron-sdk");
      const preloadPath = path.join(path.dirname(sdkPath), "preload.js");

      const fs = require("node:fs");
      if (fs.existsSync(preloadPath)) {
        log.info(`[JITSI-SDK] Found SDK preload at: ${preloadPath}`);
        return preloadPath;
      }
    } catch {
      // SDK preload не найден
    }

    return undefined;
  }

  private setupWindowHandlers(): void {
    if (!this.state.window) return;

    let closeHandled = false;

    // ВАЖНО: Обработчик close для корректного выхода из конференции
    this.state.window.on("close", async (event) => {
      if (closeHandled) {
        return;
      }

      closeHandled = true;

      event.preventDefault();

      log.info("[JITSI-SDK] Window close requested - performing cleanup");

      // Выполняем корректный выход из конференции
      await this.performConferenceCleanup();

      // Показываем экран закрытия
      await this.showClosingScreen();

      // Закрываем окно через небольшую задержку
      setTimeout(() => {
        this.closeWindow();
      }, 2000);
    });

    this.state.window.on("closed", () => {
      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;
    });

    this.state.window.on("page-title-updated", (event) => {
      event.preventDefault();
    });

    this.state.window.webContents.on(
      "page-title-updated",
      async (event, title) => {
        if (title === "__SHOW_CUSTOM_PICKER__") {
          event.preventDefault();
          log.info(`[JITSI-SDK] Custom picker requested via title change`);
          await this.handleScreenPickerRequest();
        }
      },
    );

    // Блокируем навигацию на главную страницу после выхода
    this.state.window.webContents.on("will-navigate", (event, url) => {
      log.info(`[JITSI-SDK] Navigation attempt to: ${url}`);

      // Если это попытка перейти на главную страницу после выхода - блокируем
      if (
        this.state.conferenceUrl &&
        !url.includes(this.currentRoomName || "")
      ) {
        log.info("[JITSI-SDK] Blocking navigation to different page");
        event.preventDefault();

        // Выполняем cleanup если еще не выполнен
        this.performConferenceCleanup();
        this.showPermanentClosingScreen();

        setTimeout(() => {
          this.closeWindow();
        }, 2000);
      }
    });

    this.state.window.webContents.on("dom-ready", () => {
      log.info("[JITSI-SDK] DOM ready");
      this.injectLoadingOverlay();
    });

    this.state.window.webContents.on("did-finish-load", () => {
      log.info("[JITSI-SDK] Page loaded");

      const micHotkey = store.get("currentMicHotkey", "");
      if (micHotkey != null && micHotkey != "") {
        this.setLocalMicMuted(true);
      }

      setTimeout(() => {
        this.hideLoadingOverlay();
      }, 1000);
    });

    this.state.window.webContents.on(
      "console-message",
      (event, level, message) => {
        if (message.includes("[JITSI]") || message.includes("conference") || message.includes("[NATIVE-AUDIO]")) {
          log.info(`Jitsi Console: ${message}`);
        }
      },
    );
  }

  // Новый метод для корректного выхода из конференции
  private async performConferenceCleanup(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      log.info("[JITSI-SDK] Performing conference cleanup");

      await this.state.window.webContents.executeJavaScript(`
        (async function() {
          console.log('[JITSI] Starting conference cleanup');
          
          try {
            // Попытка 1: Через API конференции
            if (window.APP && window.APP.conference) {
              console.log('[JITSI] Found APP.conference, attempting cleanup');
              
              // Отключаем все медиа-треки
              if (window.APP.conference.getLocalTracks) {
                const localTracks = window.APP.conference.getLocalTracks();
                console.log('[JITSI] Stopping ' + localTracks.length + ' local tracks');
                for (const track of localTracks) {
                  try {
                    await track.dispose();
                  } catch(e) {
                    console.error('[JITSI] Error disposing track:', e);
                  }
                }
              }
              
              // Выходим из конференции
              if (window.APP.conference.room) {
                console.log('[JITSI] Leaving room');
                try {
                  await window.APP.conference.room.leave();
                } catch(e) {
                  console.error('[JITSI] Error leaving room:', e);
                }
              }
              
              // Вызываем hangup
              if (window.APP.conference.hangup) {
                console.log('[JITSI] Calling hangup');
                try {
                  await window.APP.conference.hangup();
                } catch(e) {
                  console.error('[JITSI] Error in hangup:', e);
                }
              }
            }
            
            // Попытка 2: Через JitsiMeetExternalAPI если доступен
            if (window.JitsiMeetExternalAPI && window.api) {
              console.log('[JITSI] Found JitsiMeetExternalAPI, disposing');
              try {
                window.api.dispose();
              } catch(e) {
                console.error('[JITSI] Error disposing API:', e);
              }
            }
            
            // Попытка 3: Через глобальный объект JitsiConference
            if (window.JitsiConference) {
              console.log('[JITSI] Found JitsiConference, attempting leave');
              try {
                if (window.JitsiConference.leave) {
                  await window.JitsiConference.leave();
                }
              } catch(e) {
                console.error('[JITSI] Error leaving via JitsiConference:', e);
              }
            }
            
            // Останавливаем все медиа-потоки
            if (navigator.mediaDevices) {
              const streams = await navigator.mediaDevices.enumerateDevices();
              console.log('[JITSI] Stopping all media streams');
              
              // Получаем все активные потоки через getUserMedia
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: false });
                stream.getTracks().forEach(track => {
                  track.stop();
                });
              } catch(e) {
                // Игнорируем ошибки
              }
            }
            
            console.log('[JITSI] Cleanup completed');
            
          } catch(error) {
            console.error('[JITSI] Error during cleanup:', error);
          }
          
          return true;
        })();
      `);

      // Даем время на завершение cleanup
      await new Promise((resolve) => setTimeout(resolve, 500));

      log.info("[JITSI-SDK] Conference cleanup completed");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to perform cleanup: ${error.message}`);
    }
  }

  private async showPermanentClosingScreen(): Promise<void> {
    if (!this.state.window || this.state.window.isDestroyed()) return;

    try {
      await this.state.window.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('electron-permanent-closing')) return;
          
          document.body.innerHTML = '';
          
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
          
          const blockAll = function(e) {
            e.stopImmediatePropagation();
            e.preventDefault();
            return false;
          };
          
          window.addEventListener('beforeunload', blockAll, true);
          window.addEventListener('unload', blockAll, true);
          document.addEventListener('DOMContentLoaded', blockAll, true);
          
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

      log.info("[JITSI-SDK] Permanent closing screen shown");
    } catch (error: any) {
      log.error(
        `[JITSI-SDK] Failed to show permanent closing screen: ${error.message}`,
      );
    }
  }

  private buildConferenceUrl(
    server: string,
    roomName: string,
    options: JitsiOptions,
  ): string {
    let url = `${server}/${roomName}`;

    const queryParameters = new URLSearchParams();
    if (options.jwt) {
      queryParameters.append("jwt", options.jwt);
    }

    if (queryParameters.toString()) {
      url += "?" + queryParameters.toString();
    }

    const hashParameters = new URLSearchParams();

    hashParameters.append("config.disableDeepLinking", "true");
    hashParameters.append("config.prejoinPageEnabled", "false");
    hashParameters.append("config.startWithAudioMuted", "false");
    hashParameters.append("config.startWithVideoMuted", "true");
    hashParameters.append("config.enableWelcomePage", "false");
    hashParameters.append("config.enableClosePage", "false");

    hashParameters.append("config.resolution", "720");
    hashParameters.append("config.disableInitialGUM", "false");
    hashParameters.append("config.enableLayerSuspension", "true");

    hashParameters.append("config.p2p.enabled", "true");
    hashParameters.append("config.p2p.preferH264", "true");

    hashParameters.append("interfaceConfig.SHOW_JITSI_WATERMARK", "false");
    hashParameters.append("interfaceConfig.SHOW_WATERMARK_FOR_GUESTS", "false");
    hashParameters.append("interfaceConfig.SHOW_BRAND_WATERMARK", "false");
    hashParameters.append("interfaceConfig.HIDE_INVITE_MORE_HEADER", "true");
    hashParameters.append("interfaceConfig.MOBILE_APP_PROMO", "false");

    hashParameters.append("interfaceConfig.SHOW_MEETING_NAME", "false");
    hashParameters.append(
      "interfaceConfig.DISPLAY_WELCOME_PAGE_CONTENT",
      "false",
    );
    hashParameters.append(
      "interfaceConfig.APP_NAME",
      options.topic || "Конференция",
    );
    hashParameters.append(
      "interfaceConfig.NATIVE_APP_NAME",
      options.topic || "Конференция",
    );

    hashParameters.append("config.requireDisplayName", "false");
    hashParameters.append("config.hideConferenceSubject", "true");
    hashParameters.append("config.hideConferenceTimer", "false");
    hashParameters.append("config.hideDominantSpeakerBadge", "false");

    // Отключаем отображение темы
    hashParameters.append("interfaceConfig.SHOW_CONFERENCE_SUBJECT", "false");
    hashParameters.append("interfaceConfig.HIDE_CONFERENCE_SUBJECT", "true");

    // Пустая тема вместо названия комнаты
    hashParameters.append("config.subject", " "); // Пробел вместо пустой строки

    const toolbarButtons = [
      "camera",
      "desktop",
      "microphone",
      "participants",
      "settings",
      "fullscreen",
      "hangup",
    ];
    hashParameters.append(
      "interfaceConfig.TOOLBAR_BUTTONS",
      JSON.stringify(toolbarButtons),
    );

    if (options.displayName) {
      hashParameters.append("userInfo.displayName", options.displayName);
    }

    if (options.email) {
      hashParameters.append("userInfo.email", options.email);
    }

    if (options.topic) {
      hashParameters.append("config.subject", options.topic);
    }

    if (options.avatarUrl) {
      hashParameters.append("userInfo.avatarURL", options.avatarUrl);
      hashParameters.append("config.gravatar.disabled", "true");
    }

    if (hashParameters.toString()) {
      url += "#" + hashParameters.toString();
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
            if (window.APP && window.APP.conference) {
              return true;
            }
            if (window.JitsiMeetJS) {
              return true;
            }
            return document.readyState === 'complete';
          })();
        `);

        if (isReady) {
          log.info("[JITSI-SDK] Conference ready");
          return;
        }
      } catch {
        // Игнорируем ошибки
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    log.warn("[JITSI-SDK] Conference ready timeout - proceeding anyway");
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

      log.info("[JITSI-SDK] Loading overlay shown");
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

      log.info("[JITSI-SDK] Loading overlay hidden");
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
          
          const others = document.querySelectorAll('body > *:not(#electron-closing-overlay)');
          others.forEach(el => { el.style.display = 'none'; });
        })();
      `);

      log.info("[JITSI-SDK] Closing screen shown");
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
          
          // Перехват screen picker для Jitsi
          const waitForScreenObtainer = setInterval(() => {
            if (window.JitsiMeetScreenObtainer) {
              clearInterval(waitForScreenObtainer);
              
              console.log('[JITSI] Found JitsiMeetScreenObtainer, overriding openDesktopPicker');
              
              window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, onSourceChoose) {
                console.log('[JITSI] openDesktopPicker intercepted, showing custom picker');
                
                const originalTitle = document.title;
                document.title = '__SHOW_CUSTOM_PICKER__';
                
                window.desktopPickerCallback = onSourceChoose;
                
                setTimeout(() => {
                  document.title = originalTitle;
                }, 100);
                
                const checkForSelection = setInterval(() => {
                  if (window.selectedSourceId) {
                    clearInterval(checkForSelection);
                    
                    const sourceId = window.selectedSourceId;
                    window.selectedSourceId = null;
                    
                    console.log('[JITSI] Source selected:', sourceId);
                    
                    if (window.desktopPickerCallback) {
                      window.desktopPickerCallback(sourceId, 'desktop');
                      window.desktopPickerCallback = null;
                    }
                  }
                  
                  if (window.pickerCancelled) {
                    clearInterval(checkForSelection);
                    window.pickerCancelled = false;
                    
                    console.log('[JITSI] Picker cancelled');
                    
                    if (window.desktopPickerCallback) {
                      window.desktopPickerCallback(null);
                      window.desktopPickerCallback = null;
                    }
                  }
                }, 100);
                
                setTimeout(() => {
                  clearInterval(checkForSelection);
                  if (window.desktopPickerCallback) {
                    window.desktopPickerCallback(null);
                    window.desktopPickerCallback = null;
                  }
                }, 30000);
              };
              
              window.JitsiMeetScreenObtainer.isSupported = function() {
                return true;
              };
            }
          }, 100);
          
          setTimeout(() => clearInterval(waitForScreenObtainer), 5000);
          
          // Перехват кнопки выхода для корректного cleanup
          let isClosing = false;
          
          function showClosingAndExit() {
            if (isClosing) return;
            isClosing = true;
            
            console.log('[JITSI] Initiating conference close');
            
            // Сигнализируем Electron о необходимости cleanup
            window.close();
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
          
          console.log('[JITSI] Conference handlers installed');
        })();
      `);

      log.info("[JITSI-SDK] Conference handlers injected");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to inject handlers: ${error.message}`);
    }
  }

  // ==================== Virtual Cable Methods ====================

  /**
   * Включает/выключает режим Virtual Cable
   */
  enableVirtualCableMode(enable: boolean): void {
    this.useVirtualCableMode = enable;
    log.info(`[JITSI-SDK] Virtual Cable mode: ${enable ? "ENABLED" : "DISABLED"}`);
  }

  /**
   * Проверяет, включён ли режим Virtual Cable
   */
  isVirtualCableMode(): boolean {
    return this.useVirtualCableMode;
  }

  /**
   * Перенаправляет звук приложения на Virtual Cable
   */
  async routeAppAudioToCable(processPath: string): Promise<{success: boolean; error?: string; deviceName?: string}> {
    if (process.platform !== "win32") {
      return {success: false, error: "Virtual Cable is only supported on Windows"};
    }

    try {
      log.info(`[VC-MODE] Routing audio for: ${processPath}`);

      // Получаем имя VB-Cable устройства
      const vbCableName = await this.audioSessionService.getVBCableDeviceName();
      if (!vbCableName) {
        return {success: false, error: "VB-Cable not found. Please install VB-Audio Virtual Cable."};
      }

      // Перенаправляем звук приложения на VB-Cable
      const result = await this.audioSessionService.setAppAudioDevice(processPath, vbCableName);

      if (result) {
        this.routedProcessPath = processPath;
        log.info(`[VC-MODE] Successfully routed "${processPath}" to "${vbCableName}"`);
        return {success: true, deviceName: vbCableName};
      }

      return {success: false, error: "Failed to route audio"};
    } catch (error: any) {
      log.error(`[VC-MODE] Error routing audio: ${error.message}`);
      return {success: false, error: error.message};
    }
  }

  /**
   * Восстанавливает звук приложения на устройство по умолчанию
   */
  async restoreAppAudio(processPath: string): Promise<{success: boolean; error?: string}> {
    if (process.platform !== "win32") {
      return {success: false, error: "Virtual Cable is only supported on Windows"};
    }

    try {
      log.info(`[VC-MODE] Restoring audio for: ${processPath}`);

      const result = await this.audioSessionService.restoreDefaultDevice(processPath);

      if (result) {
        if (this.routedProcessPath === processPath) {
          this.routedProcessPath = null;
        }

        log.info(`[VC-MODE] Successfully restored audio for "${processPath}"`);
        return {success: true};
      }

      return {success: false, error: "Failed to restore audio"};
    } catch (error: any) {
      log.error(`[VC-MODE] Error restoring audio: ${error.message}`);
      return {success: false, error: error.message};
    }
  }

  /**
   * Восстанавливает аудио при выходе из конференции
   */
  private async restoreRoutedAudio(): Promise<void> {
    if (this.routedProcessPath) {
      log.info(`[VC-MODE] Restoring routed audio on conference exit`);
      await this.restoreAppAudio(this.routedProcessPath);
      this.routedProcessPath = null;
    }
  }

  // ==================== End Virtual Cable Methods ====================

  async closeWindow(): Promise<void> {
    if (this.currentRoomName != "") {
      this.closureFunction(this.currentRoomName);
      this.currentRoomName = "";
    }

    // Восстанавливаем аудио при закрытии
    await this.restoreRoutedAudio();

    // Останавливаем нативный захват на macOS и деактивируем bridge
    if (process.platform === "darwin" && this.nativeCaptureManager) {
      try {
        log.info("[JITSI-SDK] Stopping native capture on window close");

        // Деактивируем audio bridge в Jitsi окне
        if (this.state.window && !this.state.window.isDestroyed()) {
          await this.state.window.webContents.executeJavaScript(`
            if (window.nativeAudioBridge && window.nativeAudioBridge.deactivate) {
              window.nativeAudioBridge.deactivate();
              console.log('[NATIVE-AUDIO] Bridge deactivated on window close');
            }
          `).catch(() => {});
        }

        await this.nativeCaptureManager.stopCapture();
        this.updateAudioStatus(false, 0);
      } catch (error: any) {
        log.warn(`[JITSI-SDK] Error stopping native capture: ${error.message}`);
      }
    }

    if (!this.state.window || this.state.window.isDestroyed()) {
      log.info("[JITSI-SDK] Window already closed");
      return;
    }

    log.info("[JITSI-SDK] Closing conference window");

    try {
      // Выполняем cleanup перед закрытием
      await this.performConferenceCleanup();

      const windowToClose = this.state.window;

      this.state.window = null;
      this.state.isConnected = false;
      this.state.conferenceUrl = null;

      windowToClose.webContents?.removeAllListeners();
      windowToClose.removeAllListeners();
      windowToClose.destroy();

      log.info("[JITSI-SDK] Window closed successfully");
    } catch (error: any) {
      log.error(`[JITSI-SDK] Error closing window: ${error.message}`);

      if (this.state.window && !this.state.window.isDestroyed()) {
        this.state.window.destroy();
      }

      this.state.window = null;
      this.state.isConnected = false;
      this.currentRoomName = "";
    }
  }

  async getStatus(): Promise<any> {
    return {
      hasWindow:
        Boolean(this.state.window) && !this.state.window?.isDestroyed(),
      isConnected: this.state.isConnected,
      conferenceUrl: this.state.conferenceUrl,
    };
  }

  async startScreenShare(sourceId?: string): Promise<boolean> {
    if (!this.state.window || this.state.window.isDestroyed()) {
      log.warn("[JITSI-SDK] Cannot start screen share - no window");
      return false;
    }

    try {
      const result = await this.state.window.webContents.executeJavaScript(`
        (function() {
          try {
            const desktopButton = document.querySelector('[aria-label*="desktop"], [aria-label*="screen"], [data-testid*="desktop"], .toolbox-button-desktop');
            if (desktopButton) {
              desktopButton.click();
              console.log('[JITSI-SDK] Screen share button clicked');
              return true;
            }
            
            if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
              window.APP.conference.toggleScreenSharing();
              console.log('[JITSI-SDK] Screen sharing toggled via API');
              return true;
            }
            
            return false;
          } catch (error) {
            console.error('[JITSI-SDK] Error starting screen share:', error);
            return false;
          }
        })();
      `);

      log.info(`[JITSI-SDK] Screen share start result: ${result}`);
      return result;
    } catch (error: any) {
      log.error(`[JITSI-SDK] Failed to start screen share: ${error.message}`);
      return false;
    }
  }
}

export default JitsiSDKManager;
