#!/bin/bash

echo "🚀 Building native addon specifically for Electron 32.3.3"

cd native-addon

# Очистка
echo "🧹 Cleaning..."
rm -rf build/
rm -f addon.node
rm -f *.o

# Устанавливаем переменные для Electron
export npm_config_target=32.3.3
export npm_config_arch=x64
export npm_config_target_arch=x64
export npm_config_disturl=https://electronjs.org/headers
export npm_config_runtime=electron
export npm_config_cache=$HOME/.npm/electron-cache
export npm_config_build_from_source=true

# Скачиваем Electron headers если их нет
ELECTRON_VERSION="32.3.3"
ELECTRON_HEADERS="$HOME/.electron-gyp/$ELECTRON_VERSION"

if [ ! -d "$ELECTRON_HEADERS" ]; then
    echo "📥 Downloading Electron headers..."
    npx node-gyp install \
        --target=$ELECTRON_VERSION \
        --dist-url=https://electronjs.org/headers \
        --runtime=electron \
        --arch=x64
fi

# Проверяем наличие headers
if [ ! -d "$ELECTRON_HEADERS/include/node" ]; then
    echo "❌ Electron headers not found at $ELECTRON_HEADERS"
    echo "Trying alternative download..."
    
    mkdir -p "$HOME/.electron-gyp"
    cd "$HOME/.electron-gyp"
    
    # Скачиваем headers напрямую
    curl -L "https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz" -o headers.tar.gz
    mkdir -p "$ELECTRON_VERSION"
    tar -xzf headers.tar.gz -C "$ELECTRON_VERSION" --strip-components=1
    rm headers.tar.gz
    
    cd - > /dev/null
fi

echo "📋 Using Electron headers from: $ELECTRON_HEADERS"

# Компилируем Swift
echo "🔨 Compiling Swift..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -o CaptureModule.o \
    src/ScreenCaptureManager.swift 2>&1 | grep -v "warning: value 'filter' was defined but never used"

if [ ! -f "CaptureModule.o" ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

# Компилируем C++ с Electron headers
echo "🔨 Compiling C++ for Electron..."

# Проверяем наличие Xcode Command Line Tools
if ! xcode-select -p &> /dev/null; then
    echo "❌ Xcode Command Line Tools not installed"
    echo "Run: xcode-select --install"
    exit 1
fi

# Находим правильный SDK
SDK_PATH=$(xcrun --show-sdk-path)
echo "📋 Using SDK: $SDK_PATH"

# Компилируем с правильными путями
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -Wall \
    -isysroot "$SDK_PATH" \
    -I"$ELECTRON_HEADERS/include/node" \
    -I"node_modules/node-addon-api" \
    -I"/usr/local/include" \
    -DNAPI_VERSION=9 \
    -DNODE_ADDON_API_DISABLE_DEPRECATED \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -DBUILDING_NODE_EXTENSION \
    -o webrtc_wrapper.o \
    src/webrtc_wrapper.mm

if [ ! -f "webrtc_wrapper.o" ]; then
    echo "❌ C++ compilation failed"
    echo "Trying alternative compilation..."
    
    # Альтернативный метод компиляции
    clang++ -c \
        -std=c++17 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -I"$ELECTRON_HEADERS/include/node" \
        -I"node_modules/node-addon-api" \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -o webrtc_wrapper.o \
        src/webrtc_wrapper.mm
    
    if [ ! -f "webrtc_wrapper.o" ]; then
        echo "❌ Alternative compilation also failed"
        exit 1
    fi
fi

# Линкуем для Electron
echo "🔗 Linking for Electron..."
clang++ \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -isysroot "$SDK_PATH" \
    -o addon.node \
    webrtc_wrapper.o \
    CaptureModule.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

if [ ! -f "addon.node" ]; then
    echo "❌ Linking failed"
    exit 1
fi

echo "✅ Build successful!"

# Проверяем символы
echo "🔍 Checking symbols..."
nm -gU addon.node | grep -E "(napi_register_module|Init)" | head -5

# Копируем в dist-electron
echo "📦 Copying to dist-electron..."
cp addon.node ../dist-electron/native-addon.node

# Очистка
rm -f *.o
rm -f *.swiftmodule *.swiftdoc *.swiftsourceinfo

echo "✨ Build complete for Electron 32.3.3!"
echo ""
echo "📋 Module info:"
file addon.node
ls -lh addon.node

echo ""
echo "🎉 The addon should now work with Electron 32!"