// app/renderer/js/native-integration/jitsi-webview-integration.ts

import { MacOSNativeCaptureIntegration } from './macos-native-capture';

declare global {
  interface Window {
    JitsiMeetJS: any;
    APP: any;
    _nativeCaptureIntegration?: MacOSNativeCaptureIntegration;
    _originalGetUserMedia?: any;
  }
}

export function initializeJitsiNativeCapture(): void {
  console.log('[JitsiWebView] Initializing native capture integration...');
  
  // Ждем загрузки Jitsi
  const checkInterval = setInterval(() => {
    if (window.JitsiMeetJS && window.APP) {
      clearInterval(checkInterval);
      setupNativeCapture();
    }
  }, 500);
}

function setupNativeCapture(): void {
  console.log('[JitsiWebView] Setting up native capture...');
  
  // Создаем экземпляр интеграции
  window._nativeCaptureIntegration = new MacOSNativeCaptureIntegration();
  
  // Сохраняем оригинальный getUserMedia
  window._originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  
  // Переопределяем getUserMedia для перехвата desktop capture
  navigator.mediaDevices.getUserMedia = async function(constraints: MediaStreamConstraints) {
    console.log('[JitsiWebView] getUserMedia called with:', constraints);
    
    // Проверяем, запрашивается ли desktop
    if (constraints.video && typeof constraints.video === 'object' && 
        'mandatory' in constraints.video && 
        constraints.video.mandatory?.chromeMediaSource === 'desktop') {
      
      const sourceId = constraints.video.mandatory.chromeMediaSourceId;
      console.log('[JitsiWebView] Desktop capture requested for source:', sourceId);
      
      // Проверяем, выбран ли нативный источник
      if (sourceId && (sourceId === 'native:system-audio' || shouldUseNativeCapture(sourceId))) {
        console.log('[JitsiWebView] Using native capture for source:', sourceId);
        
        try {
          // Проверяем доступность нативного захвата
          const isAvailable = await MacOSNativeCaptureIntegration.isAvailable();
          if (!isAvailable) {
            console.warn('[JitsiWebView] Native capture not available, falling back');
            return window._originalGetUserMedia(constraints);
          }
          
          // Создаем нативный MediaStream
          const nativeStream = await window._nativeCaptureIntegration!.createNativeMediaStream(sourceId);
          console.log('[JitsiWebView] Native stream created successfully');
          
          return nativeStream;
          
        } catch (error) {
          console.error('[JitsiWebView] Native capture failed:', error);
          // Fallback на обычный захват
          return window._originalGetUserMedia(constraints);
        }
      }
    }
    
    // Для всех остальных случаев используем оригинальный метод
    return window._originalGetUserMedia(constraints);
  };
  
  // Добавляем обработчик для остановки демонстрации
  if (window.APP && window.APP.conference) {
    const originalLeave = window.APP.conference.leave;
    window.APP.conference.leave = async function() {
      console.log('[JitsiWebView] Conference leave detected, stopping native capture');
      if (window._nativeCaptureIntegration) {
        await window._nativeCaptureIntegration.stopCapture();
      }
      return originalLeave.apply(this, arguments);
    };
  }
  
  // Модифицируем диалог выбора источника
  modifyDesktopPicker();
  
  console.log('[JitsiWebView] Native capture setup complete');
}

function shouldUseNativeCapture(sourceId: string): boolean {
  // Здесь можно добавить логику для определения, когда использовать нативный захват
  // Например, проверить настройки пользователя
  const useNativeForAll = localStorage.getItem('useNativeCapture') === 'true';
  return useNativeForAll || sourceId.includes('screen:');
}

function modifyDesktopPicker(): void {
  console.log('[JitsiWebView] Modifying desktop picker...');
  
  // Наблюдаем за появлением диалога выбора источника
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node instanceof HTMLElement) {
          // Ищем диалог выбора источника по различным признакам
          if (node.classList.contains('desktop-picker') ||
              node.querySelector('.desktop-picker') ||
              node.querySelector('[class*="desktop-source"]') ||
              node.querySelector('[class*="screen-share"]')) {
            
            console.log('[JitsiWebView] Desktop picker detected');
            setTimeout(() => addNativeSourceOption(node), 100);
          }
        }
      }
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function addNativeSourceOption(pickerElement: HTMLElement): void {
  console.log('[JitsiWebView] Adding native source option...');
  
  // Ищем контейнер с источниками
  const sourcesContainer = pickerElement.querySelector('.desktop-picker-sources') ||
                          pickerElement.querySelector('[class*="source-list"]') ||
                          pickerElement.querySelector('[class*="sources"]') ||
                          pickerElement.querySelector('.desktop-picker-source')?.parentElement;
  
  if (!sourcesContainer) {
    console.warn('[JitsiWebView] Sources container not found, trying alternative approach');
    // Пробуем найти первый источник и добавить рядом
    const firstSource = pickerElement.querySelector('.desktop-picker-source');
    if (firstSource && firstSource.parentElement) {
      addNativeOption(firstSource.parentElement);
    }
    return;
  }
  
  addNativeOption(sourcesContainer);
}

function addNativeOption(container: Element): void {
  // Проверяем, не добавлен ли уже
  if (container.querySelector('[data-source-id="native:system-audio"]')) {
    console.log('[JitsiWebView] Native option already added');
    return;
  }
  
  // Создаем элемент для нативного источника
  const nativeOption = document.createElement('div');
  nativeOption.className = 'desktop-picker-source';
  nativeOption.setAttribute('data-source-id', 'native:system-audio');
  nativeOption.style.cssText = `
    cursor: pointer;
    padding: 10px;
    border: 2px solid transparent;
    border-radius: 8px;
    transition: all 0.2s;
  `;
  
  nativeOption.innerHTML = `
    <div class="desktop-source-preview-image-container" style="
      position: relative;
      width: 150px;
      height: 100px;
      margin: 0 auto;
    ">
      <div class="desktop-source-preview-thumbnail" style="
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 48px;
        border-radius: 4px;
      ">
        🎯
      </div>
    </div>
    <div class="desktop-source-preview-label" style="
      text-align: center;
      margin-top: 8px;
      font-weight: bold;
    ">
      Native Capture (System Audio)
    </div>
    <div style="
      text-align: center;
      font-size: 12px;
      color: #666;
      margin-top: 4px;
    ">
      Includes app-specific audio
    </div>
  `;
  
  // Добавляем hover эффект
  nativeOption.addEventListener('mouseenter', () => {
    nativeOption.style.borderColor = '#4CAF50';
    nativeOption.style.background = 'rgba(76, 175, 80, 0.1)';
  });
  
  nativeOption.addEventListener('mouseleave', () => {
    nativeOption.style.borderColor = 'transparent';
    nativeOption.style.background = 'transparent';
  });
  
  // Обработчик клика
  nativeOption.addEventListener('click', () => {
    console.log('[JitsiWebView] Native source selected');
    
    // Эмулируем выбор источника
    const event = new CustomEvent('desktop-source-selected', {
      detail: { sourceId: 'native:system-audio' }
    });
    window.dispatchEvent(event);
    
    // Пытаемся найти и нажать кнопку подтверждения
    const shareButton = document.querySelector('[class*="share-button"]') ||
                       document.querySelector('button[class*="primary"]') ||
                       document.querySelector('button:not([class*="cancel"]):not([class*="close"])');
    
    if (shareButton && shareButton instanceof HTMLElement) {
      shareButton.click();
    }
    
    // Закрываем диалог
    const closeButton = document.querySelector('[class*="close-button"]') ||
                       document.querySelector('[aria-label="Close"]') ||
                       document.querySelector('button[class*="close"]');
    
    if (closeButton && closeButton instanceof HTMLElement) {
      setTimeout(() => closeButton.click(), 100);
    }
  });
  
  // Добавляем в начало списка
  container.insertBefore(nativeOption, container.firstChild);
  console.log('[JitsiWebView] Native option added successfully');
}

// Автоматическая инициализация при загрузке
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeJitsiNativeCapture);
} else {
  initializeJitsiNativeCapture();
}