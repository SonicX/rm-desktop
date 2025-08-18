// jitsi-screen-share-monitor.ts
import log from "electron-log";

export class JitsiScreenShareMonitor {
    private monitoringCode = `
    (function() {
        // ÐŸÑ€ÐµÐ´Ð¾Ñ‚Ð²Ñ€Ð°Ñ‰Ð°ÐµÐ¼ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð½ÑƒÑŽ Ð¸Ð½Ð¸Ñ†Ð¸Ð°Ð»Ð¸Ð·Ð°Ñ†Ð¸ÑŽ
        if (window.__screenShareMonitor) {
            console.log('[ScreenShareMonitor] Already initialized');
            return;
        }

        console.log('[ScreenShareMonitor] Initializing comprehensive monitoring...');
        
        window.__screenShareMonitor = {
            isSharing: false,
            lastCheckTime: Date.now(),
            checkInterval: null,
            mutationObserver: null,
            originalFunctions: {},
            stopCallbacks: new Set(),
            startCallbacks: new Set()
        };

        const monitor = window.__screenShareMonitor;

        // ===== ÐœÐ•Ð¢ÐžÐ” 1: ÐŸÐµÑ€ÐµÑ…Ð²Ð°Ñ‚ Redux Actions =====
        function interceptReduxStore() {
            if (!window.APP?.store) {
                console.log('[ScreenShareMonitor] Redux store not ready');
                return false;
            }

            const originalDispatch = window.APP.store.dispatch;
            window.APP.store.dispatch = function(action) {
                // Ð›Ð¾Ð³Ð¸Ñ€ÑƒÐµÐ¼ Ð²ÑÐµ ÑÐºÑˆÐµÐ½Ñ‹ ÑÐ²ÑÐ·Ð°Ð½Ð½Ñ‹Ðµ Ñ screen sharing
                if (action.type && (
                    action.type.includes('SCREEN') ||
                    action.type.includes('DESKTOP') ||
                    action.type === 'TOGGLE_SCREENSHARING' ||
                    action.type === 'SET_SCREENSHARING' ||
                    action.type === 'TRACK_REMOVED' ||
                    action.type === 'TRACK_ADDED'
                )) {
                    console.log('[ScreenShareMonitor] Redux action:', action.type, action);
                    
                    // ÐŸÑ€Ð¾Ð²ÐµÑ€ÑÐµÐ¼ ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ Ð¿Ð¾ÑÐ»Ðµ Ð´Ð¸ÑÐ¿Ð°Ñ‚Ñ‡Ð°
                    setTimeout(() => {
                        checkScreenShareState('redux-action');
                    }, 100);
                }
                
                return originalDispatch.call(this, action);
            };
            
            console.log('[ScreenShareMonitor] Redux store intercepted');
            return true;
        }

        // ===== ÐœÐ•Ð¢ÐžÐ” 2: ÐœÐ¾Ð½Ð¸Ñ‚Ð¾Ñ€Ð¸Ð½Ð³ DOM ÐºÐ½Ð¾Ð¿ÐºÐ¸ =====
        function monitorScreenShareButton() {
            if (monitor.mutationObserver) {
                monitor.mutationObserver.disconnect();
            }

            monitor.mutationObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes') {
                        const target = mutation.target;
                        
                        // ÐŸÑ€Ð¾Ð²ÐµÑ€ÑÐµÐ¼ ÐºÐ½Ð¾Ð¿ÐºÑƒ Ð´ÐµÐ¼Ð¾Ð½ÑÑ‚Ñ€Ð°Ñ†Ð¸Ð¸ ÑÐºÑ€Ð°Ð½Ð°
                        if (target.matches && (
                            target.matches('[aria-label*="screen" i]') ||
                            target.matches('[aria-label*="share" i]') ||
                            target.matches('[aria-label*="desktop" i]') ||
                            target.matches('.toolbox-button')
                        )) {
                            const wasPressed = mutation.oldValue?.includes('true');
                            const isPressed = target.getAttribute('aria-pressed') === 'true';
                            
                            if (wasPressed !== isPressed) {
                                console.log('[ScreenShareMonitor] Button state changed:', 
                                    wasPressed, '->', isPressed);
                                
                                if (wasPressed && !isPressed) {
                                    // ÐžÑÑ‚Ð°Ð½Ð¾Ð²ÐºÐ° Ð´ÐµÐ¼Ð¾Ð½ÑÑ‚Ñ€Ð°Ñ†Ð¸Ð¸
                                    handleScreenShareStopped('button-change');
                                } else if (!wasPressed && isPressed) {
                                    // ÐÐ°Ñ‡Ð°Ð»Ð¾ Ð´ÐµÐ¼Ð¾Ð½ÑÑ‚Ñ€Ð°Ñ†Ð¸Ð¸  
                                    handleScreenShareStarted('button-change');
                                }
                            }
                        }
                    }
                    
                    // Ð¢Ð°ÐºÐ¶Ðµ Ð¾Ñ‚ÑÐ»ÐµÐ¶Ð¸Ð²Ð°ÐµÐ¼ Ð¸Ð·Ð¼ÐµÐ½ÐµÐ½Ð¸Ñ ÐºÐ»Ð°ÑÑÐ¾Ð²
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        const target = mutation.target;
                        if (target.classList && (
                            target.classList.contains('toolbox-button') ||
                            target.querySelector?.('[aria-label*="screen" i]')
                        )) {
                            const wasToggled = mutation.oldValue?.includes('toggled');
                            const isToggled = target.classList.contains('toggled');
                            
                            if (wasToggled !== isToggled) {
                                console.log('[ScreenShareMonitor] Button toggled:', 
                                    wasToggled, '->', isToggled);
                                    
                                if (wasToggled && !isToggled) {
                                    handleScreenShareStopped('button-toggle');
                                }
                            }
                        }
                    }
                });
            });

            // ÐÐ°Ð±Ð»ÑŽÐ´Ð°ÐµÐ¼ Ð·Ð° Ð²ÑÐµÐ¼ Ð´Ð¾ÐºÑƒÐ¼ÐµÐ½Ñ‚Ð¾Ð¼
            monitor.mutationObserver.observe(document.body, {
                attributes: true,
                attributeOldValue: true,
                subtree: true,
                attributeFilter: ['aria-pressed', 'class', 'aria-label']
            });
            
            console.log('[ScreenShareMonitor] DOM monitoring started');
        }

        // ===== ÐœÐ•Ð¢ÐžÐ” 3: ÐŸÐµÑ€ÐµÑ…Ð²Ð°Ñ‚ ÐºÐ¾Ð½Ñ„ÐµÑ€ÐµÐ½Ñ†Ð¸Ð¸ API =====
        function interceptConferenceAPI() {
            if (!window.APP?.conference) {
                console.log('[ScreenShareMonitor] Conference not ready');
                return false;
            }

            // ÐŸÐµÑ€ÐµÑ…Ð²Ð°Ñ‚Ñ‹Ð²Ð°ÐµÐ¼ toggleScreenSharing
            if (!monitor.originalFunctions.toggleScreenSharing) {
                monitor.originalFunctions.toggleScreenSharing = 
                    window.APP.conference.toggleScreenSharing;
                    
                window.APP.conference.toggleScreenSharing = async function(...args) {
                    const wasSharing = window.APP.conference.isSharingScreen?.() || false;
                    console.log('[ScreenShareMonitor] toggleScreenSharing called, was sharing:', wasSharing);
                    
                    // Ð’Ñ‹Ð·Ñ‹Ð²Ð°ÐµÐ¼ Ð¾Ñ€Ð¸Ð³Ð¸Ð½Ð°Ð»ÑŒÐ½ÑƒÑŽ Ñ„ÑƒÐ½ÐºÑ†Ð¸ÑŽ
                    const result = await monitor.originalFunctions.toggleScreenSharing.apply(this, args);
                    
                    // ÐŸÑ€Ð¾Ð²ÐµÑ€ÑÐµÐ¼ Ð½Ð¾Ð²Ð¾Ðµ ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ
                    setTimeout(() => {
                        const isSharing = window.APP.conference.isSharingScreen?.() || false;
                        console.log('[ScreenShareMonitor] After toggle, is sharing:', isSharing);
                        
                        if (wasSharing && !isSharing) {
                            handleScreenShareStopped('toggle-api');
                        } else if (!wasSharing && isSharing) {
                            handleScreenShareStarted('toggle-api');
                        }
                    }, 500);
                    
                    return result;
                };
            }

            // ÐŸÐµÑ€ÐµÑ…Ð²Ð°Ñ‚Ñ‹Ð²Ð°ÐµÐ¼ stopScreenSharing ÐµÑÐ»Ð¸ ÐµÑÑ‚ÑŒ
            if (window.APP.conference.stopScreenSharing && 
                !monitor.originalFunctions.stopScreenSharing) {
                monitor.originalFunctions.stopScreenSharing = 
                    window.APP.conference.stopScreenSharing;
                    
                window.APP.conference.stopScreenSharing = async function(...args) {
                    console.log('[ScreenShareMonitor] stopScreenSharing called');
                    const result = await monitor.originalFunctions.stopScreenSharing.apply(this, args);
                    handleScreenShareStopped('stop-api');
                    return result;
                };
            }

            console.log('[ScreenShareMonitor] Conference API intercepted');
            return true;
        }

        // ===== ÐœÐ•Ð¢ÐžÐ” 4: ÐœÐ¾Ð½Ð¸Ñ‚Ð¾Ñ€Ð¸Ð½Ð³ Ñ‚Ñ€ÐµÐºÐ¾Ð² =====
        function monitorTracks() {
            if (!window.APP?.conference?.room) {
                return;
            }

            const room = window.APP.conference.room;
            
            // Ð¡Ð»ÑƒÑˆÐ°ÐµÐ¼ ÑÐ¾Ð±Ñ‹Ñ‚Ð¸Ñ ÑƒÐ´Ð°Ð»ÐµÐ½Ð¸Ñ Ñ‚Ñ€ÐµÐºÐ¾Ð²
            if (room.on && !room.__trackMonitoringEnabled) {
                room.__trackMonitoringEnabled = true;
                
                room.on('track.removed', (track) => {
                    if (track && track.isLocal() && track.getVideoType() === 'desktop') {
                        console.log('[ScreenShareMonitor] Desktop track removed');
                        handleScreenShareStopped('track-removed');
                    }
                });
                
                room.on('track.added', (track) => {
                    if (track && track.isLocal() && track.getVideoType() === 'desktop') {
                        console.log('[ScreenShareMonitor] Desktop track added');
                        handleScreenShareStarted('track-added');
                    }
                });
                
                console.log('[ScreenShareMonitor] Track monitoring enabled');
            }
        }

        // ===== ÐœÐ•Ð¢ÐžÐ” 5: ÐŸÐµÑ€Ð¸Ð¾Ð´Ð¸Ñ‡ÐµÑÐºÐ°Ñ Ð¿Ñ€Ð¾Ð²ÐµÑ€ÐºÐ° ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ñ =====
        function startPolling() {
            if (monitor.checkInterval) {
                clearInterval(monitor.checkInterval);
            }

            monitor.checkInterval = setInterval(() => {
                checkScreenShareState('polling');
            }, 250);
            
            console.log('[ScreenShareMonitor] Polling started');
        }

        // ===== ÐžÑÐ½Ð¾Ð²Ð½Ð°Ñ Ñ„ÑƒÐ½ÐºÑ†Ð¸Ñ Ð¿Ñ€Ð¾Ð²ÐµÑ€ÐºÐ¸ ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ñ =====
        function checkScreenShareState(source) {
            try {
                let isCurrentlySharing = false;
                
                // Ð¡Ð¿Ð¾ÑÐ¾Ð± 1: Ð§ÐµÑ€ÐµÐ· APP.conference
                if (window.APP?.conference?.isSharingScreen) {
                    isCurrentlySharing = window.APP.conference.isSharingScreen();
                }
                
                // Ð¡Ð¿Ð¾ÑÐ¾Ð± 2: Ð§ÐµÑ€ÐµÐ· Redux store
                if (!isCurrentlySharing && window.APP?.store) {
                    const state = window.APP.store.getState();
                    const tracks = state['features/base/tracks'];
                    if (tracks) {
                        isCurrentlySharing = tracks.some(track => 
                            track.local && track.videoType === 'desktop'
                        );
                    }
                }
                
                // Ð¡Ð¿Ð¾ÑÐ¾Ð± 3: Ð§ÐµÑ€ÐµÐ· JitsiConference
                if (!isCurrentlySharing && window.APP?.conference?.room) {
                    const localTracks = window.APP.conference.room.getLocalTracks();
                    isCurrentlySharing = localTracks.some(track => 
                        track.getVideoType && track.getVideoType() === 'desktop'
                    );
                }
                
                // Ð”ÐµÑ‚ÐµÐºÑ‚Ð¸Ñ€ÑƒÐµÐ¼ Ð¸Ð·Ð¼ÐµÐ½ÐµÐ½Ð¸Ðµ ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ñ
                if (monitor.isSharing !== isCurrentlySharing) {
                    console.log('[ScreenShareMonitor] State changed:', 
                        monitor.isSharing, '->', isCurrentlySharing, 
                        'detected by:', source);
                    
                    monitor.isSharing = isCurrentlySharing;
                    
                    if (!isCurrentlySharing) {
                        handleScreenShareStopped(source);
                    } else {
                        handleScreenShareStarted(source);
                    }
                }
                
            } catch (error) {
                console.error('[ScreenShareMonitor] Error checking state:', error);
            }
        }

        // ===== ÐžÐ±Ñ€Ð°Ð±Ð¾Ñ‚Ñ‡Ð¸ÐºÐ¸ ÑÐ¾Ð±Ñ‹Ñ‚Ð¸Ð¹ =====
        function handleScreenShareStarted(source) {
            console.log('[ScreenShareMonitor] ðŸŸ¢ SCREEN SHARE STARTED, source:', source);
            monitor.isSharing = true;
            
            // Ð’Ñ‹Ð·Ñ‹Ð²Ð°ÐµÐ¼ Ð²ÑÐµ ÐºÐ¾Ð»Ð»Ð±ÑÐºÐ¸
            monitor.startCallbacks.forEach(callback => {
                try {
                    callback(source);
                } catch (e) {
                    console.error('[ScreenShareMonitor] Start callback error:', e);
                }
            });
        }

        function handleScreenShareStopped(source) {
            console.log('[ScreenShareMonitor] ðŸ”´ SCREEN SHARE STOPPED, source:', source);
            monitor.isSharing = false;
            
            // ÐšÐ Ð˜Ð¢Ð˜Ð§ÐÐž: ÐžÑÑ‚Ð°Ð½Ð°Ð²Ð»Ð¸Ð²Ð°ÐµÐ¼ Native capture
            stopNativeCapture(source);
            
            // Ð’Ñ‹Ð·Ñ‹Ð²Ð°ÐµÐ¼ Ð²ÑÐµ ÐºÐ¾Ð»Ð»Ð±ÑÐºÐ¸
            monitor.stopCallbacks.forEach(callback => {
                try {
                    callback(source);
                } catch (e) {
                    console.error('[ScreenShareMonitor] Stop callback error:', e);
                }
            });
        }

        // ===== ÐžÑÑ‚Ð°Ð½Ð¾Ð²ÐºÐ° Native Capture =====
        async function stopNativeCapture(source) {
            console.log('[ScreenShareMonitor] ðŸ›‘ Stopping native capture, triggered by:', source);
            
            try {
                // ÐžÑÑ‚Ð°Ð½Ð°Ð²Ð»Ð¸Ð²Ð°ÐµÐ¼ Ð²ÑÐµ Ñ‚Ñ€ÐµÐºÐ¸
                if (window.jitsiNativeMediaStream) {
                    window.jitsiNativeMediaStream.getTracks().forEach(track => {
                        track.stop();
                    });
                    window.jitsiNativeMediaStream = null;
                }
                
                if (window.electronVideoStream) {
                    window.electronVideoStream.getTracks().forEach(track => {
                        track.stop();
                    });
                    window.electronVideoStream = null;
                }
                
                // Ð—Ð°ÐºÑ€Ñ‹Ð²Ð°ÐµÐ¼ audio context
                if (window.nativeAudioContext && window.nativeAudioContext.state !== 'closed') {
                    await window.nativeAudioContext.close();
                    window.nativeAudioContext = null;
                }
                
                // Ð¡Ð±Ñ€Ð°ÑÑ‹Ð²Ð°ÐµÐ¼ Ñ„Ð»Ð°Ð³Ð¸
                window.isNativeActive = false;
                window.isHybridMode = false;
                
                // Ð’Ñ‹Ð·Ñ‹Ð²Ð°ÐµÐ¼ Ð¾ÑÑ‚Ð°Ð½Ð¾Ð²ÐºÑƒ Ð² main Ð¿Ñ€Ð¾Ñ†ÐµÑÑÐµ
                if (window.ipcRenderer) {
                    console.log('[ScreenShareMonitor] Calling jitsi:stop-native-capture...');
                    const result = await window.ipcRenderer.invoke('jitsi:stop-native-capture');
                    console.log('[ScreenShareMonitor] Stop result:', result);
                }
                
            } catch (error) {
                console.error('[ScreenShareMonitor] Error stopping native capture:', error);
            }
        }

        // ===== API Ð´Ð»Ñ Ð´Ð¾Ð±Ð°Ð²Ð»ÐµÐ½Ð¸Ñ ÐºÐ¾Ð»Ð»Ð±ÑÐºÐ¾Ð² =====
        window.__screenShareMonitor.onStop = function(callback) {
            monitor.stopCallbacks.add(callback);
        };
        
        window.__screenShareMonitor.onStart = function(callback) {
            monitor.startCallbacks.add(callback);
        };

        // ===== Ð˜Ð½Ð¸Ñ†Ð¸Ð°Ð»Ð¸Ð·Ð°Ñ†Ð¸Ñ Ð²ÑÐµÑ… Ð¼ÐµÑ‚Ð¾Ð´Ð¾Ð² =====
        function initializeAllMethods() {
            let attempts = 0;
            const maxAttempts = 30;
            
            const initInterval = setInterval(() => {
                attempts++;
                
                const reduxReady = interceptReduxStore();
                const conferenceReady = interceptConferenceAPI();
                
                if (reduxReady && conferenceReady) {
                    clearInterval(initInterval);
                    
                    // Ð—Ð°Ð¿ÑƒÑÐºÐ°ÐµÐ¼ Ð²ÑÐµ Ð¼Ð¾Ð½Ð¸Ñ‚Ð¾Ñ€Ñ‹
                    monitorScreenShareButton();
                    monitorTracks();
                    startPolling();
                    
                    // ÐÐ°Ñ‡Ð°Ð»ÑŒÐ½Ð°Ñ Ð¿Ñ€Ð¾Ð²ÐµÑ€ÐºÐ°
                    checkScreenShareState('initial');
                    
                    console.log('[ScreenShareMonitor] âœ… All monitoring methods initialized');
                    
                } else if (attempts >= maxAttempts) {
                    clearInterval(initInterval);
                    console.warn('[ScreenShareMonitor] Some methods failed to initialize');
                    
                    // Ð—Ð°Ð¿ÑƒÑÐºÐ°ÐµÐ¼ Ñ‡Ñ‚Ð¾ Ð¼Ð¾Ð¶ÐµÐ¼
                    monitorScreenShareButton();
                    startPolling();
                }
            }, 500);
        }

        // Ð—Ð°Ð¿ÑƒÑÐºÐ°ÐµÐ¼ Ð¸Ð½Ð¸Ñ†Ð¸Ð°Ð»Ð¸Ð·Ð°Ñ†Ð¸ÑŽ
        initializeAllMethods();
        
        console.log('[ScreenShareMonitor] âœ… Monitor script injected');
        
        return true;
    })();
    `;

    async injectMonitor(window: any): Promise<boolean> {
        if (!window || window.isDestroyed()) {
            log.error("[ScreenShareMonitor] No window to inject into");
            return false;
        }

        try {
            const result = await window.webContents.executeJavaScript(this.monitoringCode);
            log.info("[ScreenShareMonitor] Monitor injected successfully");
            return result;
        } catch (error: any) {
            log.error(`[ScreenShareMonitor] Injection failed: ${error.message}`);
            return false;
        }
    }

    // Ð”Ð¾Ð±Ð°Ð²Ð¸Ñ‚ÑŒ Ð´Ð¾Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ñ‹Ð¹ ÐºÐ¾Ð»Ð»Ð±ÑÐº Ð´Ð»Ñ Ð¾ÑÑ‚Ð°Ð½Ð¾Ð²ÐºÐ¸
    async addStopCallback(window: any, callback: string): Promise<void> {
        if (!window || window.isDestroyed()) return;

        await window.webContents.executeJavaScript(`
            if (window.__screenShareMonitor) {
                window.__screenShareMonitor.onStop(${callback});
            }
        `);
    }
}