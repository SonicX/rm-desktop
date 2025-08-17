#!/bin/bash

echo "🔧 Rebuilding native addon for Electron..."

# Переходим в директорию native-addon
cd native-addon

# Определяем версию Electron из родительского проекта
ELECTRON_VERSION=$(cd .. && npm list electron --depth=0 2>/dev/null | grep electron@ | cut -d@ -f2 | cut -d' ' -f1)

if [ -z "$ELECTRON_VERSION" ]; then
    echo "⚠️ Could not detect Electron version, using 32.3.0"
    ELECTRON_VERSION="32.3.0"
fi

echo "📦 Target Electron version: $ELECTRON_VERSION"

# Чистим старые сборки
echo "🧹 Cleaning old builds..."
rm -rf build/
rm -f addon.node

# Пересобираем с правильными headers
echo "🔨 Building with electron-rebuild..."
npx electron-rebuild --version=$ELECTRON_VERSION --arch=$(uname -m | sed 's/x86_64/x64/') --force

# Если electron-rebuild не сработал, собираем вручную
if [ ! -f "addon.node" ] && [ ! -f "build/Release/screen_capture_webrtc.node" ]; then
    echo "⚠️ electron-rebuild failed, trying manual build..."
    
    # Скачиваем Electron headers
    npm install --save-dev electron@$ELECTRON_VERSION
    
    # Собираем вручную
    ./build-direct.sh
fi

# Проверяем результат
if [ -f "addon.node" ]; then
    ADDON_FILE="addon.node"
elif [ -f "build/Release/screen_capture_webrtc.node" ]; then
    ADDON_FILE="build/Release/screen_capture_webrtc.node"
    cp "$ADDON_FILE" addon.node
    ADDON_FILE="addon.node"
else
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build successful!"

# Копируем в dist-electron
echo "📦 Copying to dist-electron..."
cp addon.node ../dist-electron/native-addon.node

echo "✨ Done! Addon rebuilt for Electron $ELECTRON_VERSION"