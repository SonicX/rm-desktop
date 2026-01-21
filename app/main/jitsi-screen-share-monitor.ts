// Jitsi-screen-share-monitor.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/class-literal-property-style, @typescript-eslint/no-unsafe-return */
import log from "electron-log/main";

export class JitsiScreenShareMonitor {
  private readonly monitoringCode = `
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
            lastStateChangeTime: Date.now(),
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

            if (window.APP.store.__screenShareMonitorIntercepted) {
                console.log('[ScreenShareMonitor] Redux already intercepted');
                return true;
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

            window.APP.store.__screenShareMonitorIntercepted = true;
            
            console.log('[ScreenShareMonitor] Redux store intercepted');
            return true;
        }

        // ===== ÐœÐ•Ð¢ÐžÐ” 2: ÐœÐ¾Ð½Ð¸Ñ‚Ð¾Ñ€Ð¸Ð½Ð³ DOM ÐºÐ½Ð¾Ð¿ÐºÐ¸ =====
        function monitorScreenShareButton() {
            if (monitor.mutationObserver) {
                monitor.mutationObserver.disconnect();
            }

            const buttonStates = new WeakMap();

            monitor.mutationObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes') {
                        const target = mutation.target;
                        
                        // УЛУЧШЕННАЯ ПРОВЕРКА: Убеждаемся что это именно кнопка screen share
                        const isScreenShareButton = target.matches && (
                            target.matches('[aria-label*="screen" i]:not([aria-label*="full" i])') ||
                            target.matches('[aria-label*="share" i]:not([aria-label*="video" i])') ||
                            target.matches('[aria-label*="desktop" i]')
                        ) && !target.matches('[aria-label*="microphone" i]') 
                        && !target.matches('[aria-label*="audio" i]')
                        && !target.matches('[aria-label*="mute" i]')
                        && !target.matches('[aria-label*="camera" i]')
                        && !target.matches('[aria-label*="video" i]:not([aria-label*="share" i])');
                        
                        if (!isScreenShareButton) {
                            return;
                        }
                        
                        // ДОБАВЛЯЕМ: Получаем сохраненное состояние
                        const savedState = buttonStates.get(target);
                        const currentPressed = target.getAttribute('aria-pressed') === 'true';
                        
                        // Проверяем изменение только если у нас есть предыдущее состояние
                        if (savedState !== undefined && savedState !== currentPressed) {
                            console.log('[ScreenShareMonitor] Screen share button state changed:', 
                                savedState, '->', currentPressed);
                            
                            // ВАЖНО: Проверяем реальное состояние демонстрации
                            const isActuallySharing = checkActualScreenShareState();
                            
                            if (savedState && !currentPressed && isActuallySharing) {
                                // Была нажата, стала не нажата, И демонстрация действительно идет
                                handleScreenShareStopped('button-change');
                            } else if (!savedState && currentPressed && !isActuallySharing) {
                                // Не была нажата, стала нажата, И демонстрации действительно нет
                                handleScreenShareStarted('button-change');
                            } else {
                                console.log('[ScreenShareMonitor] Button state mismatch, actual sharing:', isActuallySharing);
                            }
                        }
                        
                        // Сохраняем новое состояние
                        buttonStates.set(target, currentPressed);
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

        // ДОБАВЛЯЕМ: Вспомогательная функция для проверки реального состояния
        function checkActualScreenShareState() {
            // Способ 1: Через conference API
            if (window.APP?.conference?.isSharingScreen) {
                const sharing = window.APP.conference.isSharingScreen();
                if (sharing) return true;
            }
            
            // Способ 2: Через локальные треки
            if (window.APP?.conference?.room) {
                const localTracks = window.APP.conference.room.getLocalTracks();
                const hasDesktop = localTracks.some(track => 
                    track.getType?.() === 'video' && 
                    track.getVideoType?.() === 'desktop'
                );
                if (hasDesktop) return true;
            }
            
            // Способ 3: Проверяем наличие активного native stream
            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                const tracks = window.jitsiNativeMediaStream.getTracks();
                const hasActiveVideo = tracks.some(t => 
                    t.kind === 'video' && t.readyState === 'live'
                );
                if (hasActiveVideo) return true;
            }
            
            return false;
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
                    console.log('[ScreenShareMonitor] Track removed event, track:', track);
                    console.log('[ScreenShareMonitor] Track details:', {
                        isLocal: track?.isLocal?.(),
                        type: track?.getType?.(),
                        videoType: track?.getVideoType?.(),
                        muted: track?.isMuted?.()
                    });
                    
                    // ИСПРАВЛЕНИЕ: Проверяем что это именно VIDEO трек типа desktop
                    if (track && track.isLocal()) {
                        const trackType = track.getType?.();
                        const videoType = track.getVideoType?.();
                        
                        // Убеждаемся, что это VIDEO трек И он типа desktop
                        if (trackType === 'video' && videoType === 'desktop') {
                            console.log('[ScreenShareMonitor] Desktop VIDEO track removed - triggering stop');
                            handleScreenShareStopped('track-removed');
                        } else if (trackType === 'audio') {
                            console.log('[ScreenShareMonitor] Audio track removed, ignoring for screen share');
                        } else if (trackType === 'video' && videoType !== 'desktop') {
                            console.log('[ScreenShareMonitor] Camera video track removed, ignoring');
                        }
                    }
                });

                room.on('track.added', (track) => {
                    console.log('[ScreenShareMonitor] Track added event, track:', track);
                    console.log('[ScreenShareMonitor] Track details:', {
                        isLocal: track?.isLocal?.(),
                        type: track?.getType?.(),
                        videoType: track?.getVideoType?.(),
                        muted: track?.isMuted?.()
                    });
                    
                    // ИСПРАВЛЕНИЕ: Аналогично для track.added
                    if (track && track.isLocal()) {
                        const trackType = track.getType?.();
                        const videoType = track.getVideoType?.();
                        
                        // Убеждаемся, что это VIDEO трек И он типа desktop
                        if (trackType === 'video' && videoType === 'desktop') {
                            console.log('[ScreenShareMonitor] Desktop VIDEO track added - triggering start');
                            handleScreenShareStarted('track-added');
                        } else if (trackType === 'audio') {
                            console.log('[ScreenShareMonitor] Audio track added, ignoring for screen share');
                        }
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

        // Исправляем функцию checkScreenShareState (примерно строка 293)
        function checkScreenShareState(source) {
            try {
                let isCurrentlySharing = false;
                let detectedBy = null;
                
                // Способ 1: Через локальные треки в conference.room - САМЫЙ НАДЕЖНЫЙ
                if (window.APP?.conference?.room) {
                    const localTracks = window.APP.conference.room.getLocalTracks();
                    const desktopTracks = localTracks.filter(track => 
                        track.getVideoType && track.getVideoType() === 'desktop'
                    );
                    if (desktopTracks.length > 0) {
                        isCurrentlySharing = true;
                        detectedBy = 'room.getLocalTracks';
                        if (source !== 'polling') {
                            console.log('[ScreenShareMonitor] Found desktop tracks in room:', desktopTracks.length);
                        }
                    }
                }
                
                // Способ 2: Через conference.isSharingScreen()
                if (!isCurrentlySharing && window.APP?.conference?.isSharingScreen) {
                    const sharingViaAPI = window.APP.conference.isSharingScreen();
                    if (sharingViaAPI) {
                        isCurrentlySharing = true;
                        detectedBy = 'conference.isSharingScreen';
                    }
                }
                
                // ДОБАВЛЯЕМ: Способ 3: Проверяем native stream
                if (!isCurrentlySharing && window.jitsiNativeMediaStream && window.isNativeActive) {
                    const videoTracks = window.jitsiNativeMediaStream.getVideoTracks();
                    const hasActiveVideo = videoTracks.some(t => t.readyState === 'live');
                    if (hasActiveVideo) {
                        isCurrentlySharing = true;
                        detectedBy = 'native.stream';
                        if (source !== 'polling') {
                            console.log('[ScreenShareMonitor] Active native stream detected');
                        }
                    }
                }
                
                // Способ 4: Через Redux store - только для диагностики
                if (window.APP?.store) {
                    const state = window.APP.store.getState();
                    const tracks = state['features/base/tracks'];
                    if (tracks) {
                        const desktopTracks = tracks.filter(track => 
                            track.local && track.videoType === 'desktop'
                        );
                        
                        const activeDesktopTracks = desktopTracks.filter(track => 
                            !track.muted && track.participantId
                        );
                        
                        // ИЗМЕНЕНО: Проверяем orphaned треки только если:
                        // 1. Есть треки в Redux
                        // 2. НЕТ реального sharing (ни через room, ни через API, ни через native)
                        // 3. НЕТ активного native stream
                        if (activeDesktopTracks.length > 0 && !isCurrentlySharing) {
                            // Дополнительная проверка native stream
                            let hasActiveNativeStream = false;
                            if (window.jitsiNativeMediaStream) {
                                const videoTracks = window.jitsiNativeMediaStream.getVideoTracks();
                                hasActiveNativeStream = videoTracks.some(t => t.readyState === 'live');
                            }
                            
                            // Это действительно orphaned трек только если нет активного stream
                            if (!hasActiveNativeStream) {
                                console.warn('[ScreenShareMonitor] Found TRUE orphaned desktop tracks in Redux:', activeDesktopTracks.length);
                                
                                const now = Date.now();
                                const timeSinceLastChange = now - (monitor.lastStateChangeTime || 0);
                                
                                // Очищаем только после задержки
                                if (timeSinceLastChange > 5000 && !monitor.__cleanupAttempted) {
                                    monitor.__cleanupAttempted = true;
                                    console.log('[ScreenShareMonitor] Scheduling cleanup after', timeSinceLastChange, 'ms');
                                    setTimeout(() => {
                                        // Финальная проверка перед очисткой
                                        if (!checkActualScreenShareState()) {
                                            cleanupOrphanedTracks();
                                        }
                                        setTimeout(() => {
                                            monitor.__cleanupAttempted = false;
                                        }, 5000);
                                    }, 2000);
                                }
                            } else if (source !== 'polling') {
                                // Есть активный stream - это НЕ orphaned, а нормальная работа
                                console.log('[ScreenShareMonitor] Redux tracks present with active native stream - normal operation');
                            }
                        } else if (activeDesktopTracks.length > 0 && isCurrentlySharing && source !== 'polling') {
                            // Треки в Redux соответствуют реальному состоянию
                            console.log('[ScreenShareMonitor] Redux tracks match actual state');
                        }
                        
                        if (desktopTracks.length > 0 && source !== 'polling') {
                            console.log('[ScreenShareMonitor] Desktop tracks in Redux:', desktopTracks.length, 'active:', activeDesktopTracks.length);
                        }
                    }
                }
                
                // Детектируем изменение состояния
                if (monitor.isSharing !== isCurrentlySharing) {
                    console.log('[ScreenShareMonitor] State changed:', 
                        monitor.isSharing, '->', isCurrentlySharing, 
                        'detected by:', detectedBy || source);
                    
                    monitor.isSharing = isCurrentlySharing;
                    monitor.lastStateChangeTime = Date.now();
                    
                    if (!isCurrentlySharing) {
                        handleScreenShareStopped(source);
                    } else {
                        handleScreenShareStarted(source);
                    }
                } else if (source !== 'polling' && source !== 'redux-action') {
                    console.log('[ScreenShareMonitor] State unchanged:', isCurrentlySharing, 'source:', source);
                }
                
            } catch (error) {
                console.error('[ScreenShareMonitor] Error checking state:', error);
            }
        }

        // ===== Функция очистки застрявших треков =====
        function cleanupOrphanedTracks() {
            console.log('[ScreenShareMonitor] Attempting to cleanup orphaned tracks');
            
            try {
                // Проверяем реальное состояние через локальные треки
                let hasRealDesktopTrack = false;
                let localTracks = [];
                
                console.log('[ScreenShareMonitor] Checking for real desktop tracks...');
                
                if (window.APP?.conference?.room) {
                    try {
                        localTracks = window.APP.conference.room.getLocalTracks();
                        console.log('[ScreenShareMonitor] Got local tracks:', localTracks.length);
                        
                        const desktopTracks = localTracks.filter(track => {
                            const videoType = track.getVideoType ? track.getVideoType() : null;
                            console.log('[ScreenShareMonitor] Track videoType:', videoType);
                            return videoType === 'desktop';
                        });
                        
                        hasRealDesktopTrack = desktopTracks.length > 0;
                        console.log('[ScreenShareMonitor] Has real desktop track:', hasRealDesktopTrack);
                    } catch (err) {
                        console.error('[ScreenShareMonitor] Error getting local tracks:', err);
                    }
                }
                
                // ДОБАВЛЯЕМ: Проверяем, используется ли stream в данный момент
                let streamInUse = false;
                if (window.jitsiNativeMediaStream) {
                    const videoTracks = window.jitsiNativeMediaStream.getVideoTracks();
                    streamInUse = videoTracks.some(track => track.readyState === 'live');
                    console.log('[ScreenShareMonitor] Native stream in use:', streamInUse);
                }
                    
                if (!hasRealDesktopTrack && !streamInUse) {  // ИЗМЕНЕНО: добавили проверку !streamInUse
                    // Нет реальных desktop треков И stream не используется
                    console.log('[ScreenShareMonitor] No real desktop tracks and stream not in use, cleaning up');
                    
                    // Принудительно сбрасываем флаги
                    window.isNativeActive = false;
                    window.isHybridMode = false;
                    
                    // Очищаем потоки только если они НЕ используются
                    if (window.jitsiNativeMediaStream) {
                        const videoTracks = window.jitsiNativeMediaStream.getVideoTracks();
                        const hasLiveTracks = videoTracks.some(t => t.readyState === 'live');
                        
                        if (!hasLiveTracks) {
                            console.log('[ScreenShareMonitor] Stopping unused jitsiNativeMediaStream');
                            try {
                                window.jitsiNativeMediaStream.getTracks().forEach(t => {
                                    console.log('[ScreenShareMonitor] Stopping track:', t.kind, t.label);
                                    t.stop();
                                });
                                window.jitsiNativeMediaStream = null;
                            } catch (err) {
                                console.error('[ScreenShareMonitor] Error stopping jitsiNativeMediaStream:', err);
                            }
                        } else {
                            console.log('[ScreenShareMonitor] Keeping live jitsiNativeMediaStream');
                        }
                    }
                    
                    if (window.electronVideoStream) {
                        console.log('[ScreenShareMonitor] Stopping electronVideoStream');
                        try {
                            window.electronVideoStream.getTracks().forEach(t => {
                                console.log('[ScreenShareMonitor] Stopping track:', t.kind, t.label);
                                t.stop();
                            });
                            window.electronVideoStream = null;
                        } catch (err) {
                            console.error('[ScreenShareMonitor] Error stopping electronVideoStream:', err);
                        }
                    }
                    
                    // Очищаем Redux только если нет активных треков
                    if (window.APP?.store?.dispatch) {
                        console.log('[ScreenShareMonitor] Clearing Redux state');
                        try {
                            const state = window.APP.store.getState();
                            const tracks = state['features/base/tracks'];
                            const orphanedTracks = tracks?.filter(track => 
                                track.local && track.videoType === 'desktop'
                            ) || [];
                            
                            if (orphanedTracks.length > 0) {
                                console.log('[ScreenShareMonitor] Removing', orphanedTracks.length, 'orphaned tracks from Redux');
                                
                                // Очищаем Redux
                                window.APP.store.dispatch({
                                    type: 'SET_SCREENSHARING',
                                    screensharing: false
                                });
                                
                                window.APP.store.dispatch({
                                    type: 'TOGGLE_SCREENSHARING',
                                    enabled: false
                                });
                            }
                            
                        } catch (err) {
                            console.error('[ScreenShareMonitor] Error dispatching actions:', err);
                        }
                    }
                    
                    // Сбрасываем состояние монитора только если действительно все очистили
                    monitor.isSharing = false;
                    console.log('[ScreenShareMonitor] Monitor state reset to false');
                    
                } else if (hasRealDesktopTrack) {
                    console.log('[ScreenShareMonitor] Real desktop tracks exist, skipping cleanup');
                } else if (streamInUse) {
                    console.log('[ScreenShareMonitor] Stream in use, skipping cleanup');
                    // ДОБАВЛЯЕМ: Если stream используется, но нет треков в Jitsi, 
                    // возможно демонстрация только запускается
                    monitor.isSharing = true;
                }
            } catch (error) {
                console.error('[ScreenShareMonitor] Error in cleanup:', error);
                console.error('[ScreenShareMonitor] Stack:', error.stack);
                // При ошибке НЕ сбрасываем флаги автоматически
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
            // Дополнительная проверка перед остановкой
            let stillSharing = false;
            
            // Проверяем через API
            if (window.APP?.conference?.isSharingScreen) {
                stillSharing = window.APP.conference.isSharingScreen();
            }
            
            // Проверяем через треки
            if (!stillSharing && window.APP?.conference?.room) {
                const localTracks = window.APP.conference.room.getLocalTracks();
                stillSharing = localTracks.some(track => 
                    track.getVideoType && track.getVideoType() === 'desktop'
                );
            }
            
            if (stillSharing) {
                console.log('[ScreenShareMonitor] ⚠️ Ignoring stop event, still sharing, source:', source);
                return;
            }
        
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
            
            if (source === 'track-removed') {
                // Проверяем, действительно ли остановлена демонстрация экрана
                let stillHasDesktopTrack = false;
                if (window.APP?.conference?.room) {
                    const localTracks = window.APP.conference.room.getLocalTracks();
                    stillHasDesktopTrack = localTracks.some(track => 
                        track.getType?.() === 'video' && 
                        track.getVideoType?.() === 'desktop'
                    );
                }
                
                if (stillHasDesktopTrack) {
                    console.log('[ScreenShareMonitor] Desktop track still exists, skipping cleanup');
                    return;
                }
            }

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
      const result = await window.webContents.executeJavaScript(
        this.monitoringCode,
      );
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
