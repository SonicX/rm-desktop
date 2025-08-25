#!/bin/bash

echo "🚀 Building Universal Binary for Electron"

# Определяем версию Electron
ELECTRON_VERSION=$(npm list electron --depth=0 2>/dev/null | grep electron@ | cut -d@ -f2 | cut -d' ' -f1)
if [ -z "$ELECTRON_VERSION" ]; then
    # Если не нашли в локальных зависимостях, ищем в родительской директории
    ELECTRON_VERSION=$(cd .. && npm list electron --depth=0 2>/dev/null | grep electron@ | cut -d@ -f2 | cut -d' ' -f1)
fi

if [ -z "$ELECTRON_VERSION" ]; then
    echo "⚠️ Warning: Could not detect Electron version, using default 32.3.0"
    ELECTRON_VERSION="32.3.0"
fi

echo "📦 Detected Electron version: $ELECTRON_VERSION"

# Чистим старые сборки
echo "🧹 Cleaning old builds..."
rm -rf build/
rm -f addon.node
rm -f *.o

# Создаем необходимую структуру директорий
echo "📁 Creating directory structure..."
mkdir -p build/Release/obj.target/screen_capture_webrtc/src
mkdir -p src

# Проверяем наличие исходных файлов
if [ ! -f "ScreenCaptureManager.swift" ]; then
    echo "❌ Error: ScreenCaptureManager.swift not found"
    echo "📋 Current directory contents:"
    ls -la
    exit 1
fi

if [ ! -f "webrtc_wrapper.mm" ]; then
    echo "❌ Error: webrtc_wrapper.mm not found"
    exit 1
fi

# Копируем исходные файлы в src директорию если их там нет
if [ ! -f "src/ScreenCaptureManager.swift" ]; then
    echo "📋 Copying source files to src directory..."
    cp ScreenCaptureManager.swift src/
fi

if [ ! -f "src/webrtc_wrapper.mm" ]; then
    cp webrtc_wrapper.mm src/
fi

# Копируем заголовочные файлы если есть
[ -f "CaptureModule-Bridging-Header.h" ] && cp CaptureModule-Bridging-Header.h src/ 2>/dev/null

echo "📋 Source files in src directory:"
ls -la src/

# Компилируем Swift код
echo "🔨 Compiling Swift code..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -target x86_64-apple-macos13.0 \
    -target arm64-apple-macos13.0 \
    -import-objc-header src/CaptureModule-Bridging-Header.h \
    -o build/Release/obj.target/screen_capture_webrtc/src/ScreenCaptureManager.o \
    src/ScreenCaptureManager.swift 2>/dev/null || \
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -o build/Release/obj.target/screen_capture_webrtc/src/ScreenCaptureManager.o \
    src/ScreenCaptureManager.swift

if [ ! -f "build/Release/obj.target/screen_capture_webrtc/src/ScreenCaptureManager.o" ]; then
    echo "⚠️ Swift compilation failed, trying alternative approach..."
    swiftc -c \
        -module-name CaptureModule \
        -emit-module \
        -emit-objc-header \
        -o ScreenCaptureManager.o \
        src/ScreenCaptureManager.swift
    cp ScreenCaptureManager.o build/Release/obj.target/screen_capture_webrtc/src/
fi

# Получаем пути Node.js и Electron
NODE_INCLUDE=$(node -p "require('path').dirname(require.resolve('node-addon-api'))")
ELECTRON_INCLUDE="$HOME/.electron-gyp/$ELECTRON_VERSION/include/node"

# Создаем массив путей include
INCLUDE_PATHS=(
    "-I$NODE_INCLUDE"
    "-I$NODE_INCLUDE/../../node_modules/node-addon-api"
    "-I/usr/local/include/node"
    "-I$ELECTRON_INCLUDE"
)

# Если Electron headers не найдены, используем системные Node headers
if [ ! -d "$ELECTRON_INCLUDE" ]; then
    echo "⚠️ Electron headers not found, using Node headers"
    INCLUDE_PATHS+=("-I$(node -p 'require(\"path\").dirname(process.execPath) + \"/../include/node\"')")
fi

# Компилируем C++ код
echo "🔨 Compiling C++ code..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -Wall \
    "${INCLUDE_PATHS[@]}" \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -o build/Release/obj.target/screen_capture_webrtc/src/webrtc_wrapper.o \
    src/webrtc_wrapper.mm

if [ ! -f "build/Release/obj.target/screen_capture_webrtc/src/webrtc_wrapper.o" ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

echo "📋 Object files created:"
ls -la build/Release/obj.target/screen_capture_webrtc/src/

# Линкуем финальный addon
echo "🔗 Linking addon.node..."
clang++ \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -o addon.node \
    build/Release/obj.target/screen_capture_webrtc/src/webrtc_wrapper.o \
    build/Release/obj.target/screen_capture_webrtc/src/ScreenCaptureManager.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

if [ -f "addon.node" ]; then
    echo "✅ Build successful!"
    
    # Копируем в build/Release для совместимости с node-gyp
    cp addon.node build/Release/screen_capture_webrtc.node
    
    # Проверяем архитектуры
    echo "🏗️ Checking architecture:"
    file addon.node
    
    # Пытаемся сделать Universal Binary если возможно
    if command -v lipo &> /dev/null; then
        echo "🔍 Architecture info:"
        lipo -info addon.node 2>/dev/null || echo "Single architecture build"
    fi
else
    echo "❌ Linking failed"
    exit 1
fi

echo "✨ Build complete!"