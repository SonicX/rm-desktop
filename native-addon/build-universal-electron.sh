#!/bin/bash

echo "🚀 Building Universal Binary for macOS (Intel + Apple Silicon)"

# Определяем путь к Electron
ELECTRON_VERSION=$(npm list electron --depth=0 | grep electron@ | cut -d@ -f2)
ELECTRON_HEADERS=$(npm config get cache)/_npx/

# Чистим предыдущие сборки
echo "🧹 Cleaning previous builds..."
rm -rf build/
rm -f addon.node
rm -f *.o

# Создаем директорию для исходников в build
mkdir -p build/src
cp src/*.swift src/*.mm src/*.h build/src/ 2>/dev/null || true

# Компилируем Swift для обеих архитектур
echo "🔨 Compiling Swift code for Universal Binary..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -target x86_64-apple-macos13.0 \
    -target arm64-apple-macos13.0 \
    -import-objc-header CaptureModule-Bridging-Header.h \
    -o CaptureModule-x86_64.o \
    src/ScreenCaptureManager.swift

swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -target arm64-apple-macos13.0 \
    -import-objc-header CaptureModule-Bridging-Header.h \
    -o CaptureModule-arm64.o \
    src/ScreenCaptureManager.swift

# Объединяем объектные файлы Swift
echo "🔗 Creating Universal Swift object..."
lipo -create CaptureModule-x86_64.o CaptureModule-arm64.o -output CaptureModule.o

# Проверяем архитектуры
echo "📋 Checking Swift object architectures:"
lipo -info CaptureModule.o

# Получаем пути Node.js
NODE_INCLUDE=$(node -p "require('path').dirname(require.resolve('node-addon-api'))")
NODE_GYP_INCLUDE=$(npm root -g)/node-gyp/addon.node

# Компилируем C++ для x86_64
echo "🔨 Compiling C++ for x86_64..."
clang++ -c \
    -arch x86_64 \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -Wall \
    -I"$NODE_INCLUDE" \
    -I"$NODE_INCLUDE/../../node_modules/node-addon-api" \
    -I/usr/local/include/node \
    -I$(node -p "require('path').dirname(process.execPath) + '/../include/node'") \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit \
    -o webrtc_wrapper-x86_64.o \
    src/webrtc_wrapper.mm

# Компилируем C++ для arm64
echo "🔨 Compiling C++ for arm64..."
clang++ -c \
    -arch arm64 \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -Wall \
    -I"$NODE_INCLUDE" \
    -I"$NODE_INCLUDE/../../node_modules/node-addon-api" \
    -I/usr/local/include/node \
    -I$(node -p "require('path').dirname(process.execPath) + '/../include/node'") \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit \
    -o webrtc_wrapper-arm64.o \
    src/webrtc_wrapper.mm

# Объединяем объектные файлы C++
echo "🔗 Creating Universal C++ object..."
lipo -create webrtc_wrapper-x86_64.o webrtc_wrapper-arm64.o -output webrtc_wrapper.o

# Линкуем финальный addon для x86_64
echo "🔗 Linking addon for x86_64..."
clang++ \
    -arch x86_64 \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -o addon-x86_64.node \
    webrtc_wrapper-x86_64.o \
    CaptureModule-x86_64.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

# Линкуем финальный addon для arm64
echo "🔗 Linking addon for arm64..."
clang++ \
    -arch arm64 \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -o addon-arm64.node \
    webrtc_wrapper-arm64.o \
    CaptureModule-arm64.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

# Создаем Universal Binary
echo "🎯 Creating Universal Binary addon..."
lipo -create addon-x86_64.node addon-arm64.node -output addon.node

# Проверяем результат
echo "✅ Checking final addon architectures:"
lipo -info addon.node

# Проверяем символы
echo "📋 Checking exported symbols:"
nm -gU addon.node | grep -E "(Init|_napi_register_module)" | head -5

# Чистим временные файлы
echo "🧹 Cleaning temporary files..."
rm -f CaptureModule-x86_64.o CaptureModule-arm64.o
rm -f webrtc_wrapper-x86_64.o webrtc_wrapper-arm64.o
rm -f addon-x86_64.node addon-arm64.node

echo "✨ Universal Binary build complete!"
echo "📦 Output: addon.node (Intel + Apple Silicon)"

# Проверяем размер
echo "📊 File size:"
ls -lh addon.node

# Финальная проверка архитектур
echo "🏗️ Architecture details:"
file addon.node