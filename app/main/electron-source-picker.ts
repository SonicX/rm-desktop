// electron-source-picker.ts - Модуль для выбора источников экрана
import { desktopCapturer, BrowserWindow, ipcMain } from "electron";
import log from "electron-log";

export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  display_id?: string;
  type: 'screen' | 'window';
}

export class ElectronSourcePicker {
  private pickerWindow: BrowserWindow | null = null;

  constructor() {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Обработчики оставляем как были
  }

  async getSources(): Promise<DesktopSource[]> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 400, height: 300 }  // Увеличили размер для лучшего качества
      });

      return sources.map(source => {
        // Для экранов используем меньшее качество для ускорения загрузки
        const quality = source.id.startsWith('screen:') ? 0.5 : 0.7;
        
        return {
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL('image/jpeg', quality),
          display_id: source.display_id,
          type: source.id.startsWith('screen:') ? 'screen' : 'window'
        };
      });
    } catch (error: any) {
      log.error(`[SOURCE-PICKER] Error getting sources: ${error.message}`);
      return [];
    }
  }

  async showPicker(sources: DesktopSource[]): Promise<DesktopSource | null> {
    return new Promise((resolve) => {
      // Создаем окно для выбора источника - увеличиваем высоту на 10%
      this.pickerWindow = new BrowserWindow({
        width: 900,
        height: 660,  // Было 600, увеличили на 10%
        modal: false,
        alwaysOnTop: true,
        center: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        },
        backgroundColor: '#ffffff',
        title: 'Выберите экран или окно для демонстрации',
        show: false  // Не показываем сразу
      });

      // HTML для окна выбора
      const html = this.generatePickerHTML(sources);
      this.pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Показываем окно после загрузки контента
      this.pickerWindow.once('ready-to-show', () => {
        // Даем небольшую задержку для загрузки изображений
        setTimeout(() => {
          if (this.pickerWindow && !this.pickerWindow.isDestroyed()) {
            this.pickerWindow.show();
          }
        }, 100);
      });

      // Обработчик закрытия окна
      this.pickerWindow.on('closed', () => {
        this.pickerWindow = null;
        resolve(null);
      });

      // Обработчик выбора источника (через веб-содержимое)
      this.pickerWindow.webContents.on('ipc-message', (event, channel, ...args) => {
        if (channel === 'source-selected') {
          const sourceId = args[0];
          const selectedSource = sources.find(s => s.id === sourceId);
          if (this.pickerWindow && !this.pickerWindow.isDestroyed()) {
            this.pickerWindow.close();
          }
          resolve(selectedSource || null);
        } else if (channel === 'cancel-selection') {
          if (this.pickerWindow && !this.pickerWindow.isDestroyed()) {
            this.pickerWindow.close();
          }
          resolve(null);
        }
      });
    });
  }

  private generatePickerHTML(sources: DesktopSource[]): string {
    // Группируем источники по типу
    const screens = sources.filter(s => s.type === 'screen');
    const windows = sources.filter(s => s.type === 'window');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: #f5f5f5;
            margin: 0;
            padding: 0;
            user-select: none;
            height: 100vh;
            overflow: hidden;
          }
          
          .main-container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 20px;
          }
          
          h1 {
            color: #333;
            font-size: 24px;
            margin: 0 0 20px 0;
            text-align: center;
            flex-shrink: 0;
          }
          
          .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #e0e0e0;
            flex-shrink: 0;
          }
          
          .tab {
            padding: 10px 20px;
            background: none;
            border: none;
            font-size: 16px;
            color: #666;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            margin-bottom: -2px;
            transition: all 0.3s;
          }
          
          .tab:hover {
            color: #333;
          }
          
          .tab.active {
            color: #2196F3;
            border-bottom-color: #2196F3;
          }
          
          .content-area {
            flex: 1;
            overflow: hidden;
            min-height: 0;
          }
          
          .tab-content {
            display: none;
            height: 100%;
          }
          
          .tab-content.active {
            display: block;
            animation: fadeIn 0.3s;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          
          .sources-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 20px;
            height: 100%;
            overflow-y: auto;
            padding-bottom: 10px;
          }
          
          .source-item {
            background: white;
            border: 3px solid transparent;
            border-radius: 12px;
            padding: 12px;
            cursor: pointer;
            transition: all 0.3s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          
          .source-item:hover {
            border-color: #2196F3;
            box-shadow: 0 4px 12px rgba(33, 150, 243, 0.3);
            transform: translateY(-2px);
          }
          
          .source-item.selected {
            border-color: #4CAF50;
            background: #f0f9ff;
          }
          
          .source-thumbnail {
            width: 100%;
            height: 140px;
            border-radius: 8px;
            background: #f5f5f5;
            margin-bottom: 8px;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            background-size: contain;
            background-repeat: no-repeat;
            background-position: center;
          }
          
          .source-thumbnail.loading {
            background: #f5f5f5;
          }
          
          .loading-spinner {
            width: 30px;
            height: 30px;
            border: 3px solid #e0e0e0;
            border-top-color: #2196F3;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          .source-thumbnail:not(.loading) .loading-spinner {
            display: none;
          }
          
          .source-name {
            font-size: 13px;
            color: #333;
            text-align: center;
            line-height: 1.3;
            min-height: 32px;  /* Добавили минимальную высоту для двух строк */
            display: flex;
            align-items: center;
            justify-content: center;
            word-break: break-word;  /* Разрешаем перенос длинных слов */
            padding: 0 4px;
          }
          
          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            flex-shrink: 0;
          }
          
          button {
            padding: 10px 24px;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s;
          }
          
          .btn-cancel {
            background: #f5f5f5;
            color: #666;
          }
          
          .btn-cancel:hover {
            background: #e0e0e0;
          }
          
          .btn-share {
            background: #2196F3;
            color: white;
          }
          
          .btn-share:hover {
            background: #1976D2;
          }
          
          .btn-share:disabled {
            background: #ccc;
            cursor: not-allowed;
          }
          
          ::-webkit-scrollbar {
            width: 8px;
          }
          
          ::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 4px;
          }
          
          ::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 4px;
          }
          
          ::-webkit-scrollbar-thumb:hover {
            background: #555;
          }
        </style>
      </head>
      <body>
        <div class="main-container">
          <h1>Выберите экран или окно для демонстрации</h1>
          
          <div class="tabs">
            <button class="tab active" onclick="switchTab('screens')">
              Экраны (${screens.length})
            </button>
            <button class="tab" onclick="switchTab('windows')">
              Окна (${windows.length})
            </button>
          </div>
          
          <div class="content-area">
            <div id="screens-tab" class="tab-content active">
              <div class="sources-grid">
                ${screens.map(source => `
                  <div class="source-item" onclick="selectSource('${source.id}')" data-source-id="${source.id}">
                    <img class="source-thumbnail" src="${source.thumbnail}" alt="${source.name}">
                    <div class="source-name" title="${source.name}">${source.name}</div>
                  </div>
                `).join('')}
              </div>
            </div>
            
            <div id="windows-tab" class="tab-content">
              <div class="sources-grid">
                ${windows.map(source => `
                  <div class="source-item" onclick="selectSource('${source.id}')" data-source-id="${source.id}">
                    <img class="source-thumbnail" src="${source.thumbnail}" alt="${source.name}">
                    <div class="source-name" title="${source.name}">${source.name}</div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
          
          <div class="actions">
            <button class="btn-cancel" onclick="cancelSelection()">Отмена</button>
            <button class="btn-share" id="share-btn" disabled onclick="confirmSelection()">
              Поделиться
            </button>
          </div>
        </div>
        
        <script>
          const { ipcRenderer } = require('electron');
          let selectedSourceId = null;
          
          // Функция для загрузки изображений с задержкой для экранов
          function loadThumbnails() {
            const thumbnails = document.querySelectorAll('.source-thumbnail[data-src]');
            
            // Сначала загружаем окна (они обычно быстрее)
            thumbnails.forEach(thumb => {
              if (thumb.dataset.sourceType === 'window') {
                const src = thumb.dataset.src;
                thumb.style.backgroundImage = 'url("' + src + '")';
                thumb.classList.remove('loading');
              }
            });
            
            // Затем загружаем экраны с небольшой задержкой
            setTimeout(() => {
              thumbnails.forEach(thumb => {
                if (thumb.dataset.sourceType === 'screen') {
                  const src = thumb.dataset.src;
                  // Создаем новый Image для предзагрузки
                  const img = new Image();
                  img.onload = () => {
                    thumb.style.backgroundImage = 'url("' + src + '")';
                    thumb.classList.remove('loading');
                  };
                  img.onerror = () => {
                    thumb.innerHTML = '<div style="color:#999;font-size:12px;">Ошибка загрузки</div>';
                    thumb.classList.remove('loading');
                  };
                  img.src = src;
                }
              });
            }, 50); // Небольшая задержка для экранов
          }
          
          // Загружаем изображения при готовности DOM
          window.addEventListener('DOMContentLoaded', () => {
            // Даем время на полную инициализацию DOM
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                loadThumbnails();
              });
            });
          });
          
          function switchTab(tabName) {
            // Переключаем вкладки
            document.querySelectorAll('.tab').forEach(tab => {
              tab.classList.remove('active');
            });
            document.querySelectorAll('.tab-content').forEach(content => {
              content.classList.remove('active');
            });
            
            if (tabName === 'screens') {
              document.querySelector('.tab:nth-child(1)').classList.add('active');
              document.getElementById('screens-tab').classList.add('active');
            } else {
              document.querySelector('.tab:nth-child(2)').classList.add('active');
              document.getElementById('windows-tab').classList.add('active');
            }
          }
          
          function selectSource(sourceId) {
            // Убираем предыдущее выделение
            document.querySelectorAll('.source-item').forEach(item => {
              item.classList.remove('selected');
            });
            
            // Выделяем новый источник
            const selectedItem = document.querySelector('[data-source-id="' + sourceId + '"]');
            if (selectedItem) {
              selectedItem.classList.add('selected');
              selectedSourceId = sourceId;
              document.getElementById('share-btn').disabled = false;
            }
          }
          
          function confirmSelection() {
            if (selectedSourceId) {
              ipcRenderer.send('source-selected', selectedSourceId);
            }
          }
          
          function cancelSelection() {
            ipcRenderer.send('cancel-selection');
          }
          
          // Обработка двойного клика для быстрого выбора
          document.addEventListener('dblclick', (e) => {
            const sourceItem = e.target.closest('.source-item');
            if (sourceItem) {
              const sourceId = sourceItem.dataset.sourceId;
              selectSource(sourceId);
              confirmSelection();
            }
          });
          
          // Обработка клавиш
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              cancelSelection();
            } else if (e.key === 'Enter' && selectedSourceId) {
              confirmSelection();
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    if (this.pickerWindow && !this.pickerWindow.isDestroyed()) {
      this.pickerWindow.close();
      this.pickerWindow = null;
    }
  }
}

export default ElectronSourcePicker;