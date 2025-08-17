#!/bin/bash

echo "🚀 Direct Universal Binary Build for macOS"

# Очистка
echo "🧹 Cleaning..."
rm -rf build/
rm -f addon.node
rm -f *.o

# Создаем директории
mkdir -p build

# Находим исходники
SWIFT_FILE=""
CPP_FILE=""

if [ -f "src/ScreenCaptureManager.swift" ]; then
    SWIFT_FILE="src/ScreenCaptureManager.swift"
elif [ -f "ScreenCaptureManager.swift" ]; then
    SWIFT_FILE="ScreenCaptureManager.swift"
fi

if [ -f "src/webrtc_wrapper.mm" ]; then
    CPP_FILE="src/webrtc_wrapper.mm"
elif [ -f "webrtc_wrapper.mm" ]; then
    CPP_FILE="webrtc_wrapper.mm"
fi

if [ -z "$SWIFT_FILE" ] || [ -z "$CPP_FILE" ]; then
    echo "❌ Source files not found"
    echo "Looking for:"
    echo "  - ScreenCaptureManager.swift"
    echo "  - webrtc_wrapper.mm"
    exit 1
fi

echo "📋 Found sources:"
echo "  Swift: $SWIFT_FILE"
echo "  C++: $CPP_FILE"

# Компилируем Swift
echo "🔨 Compiling Swift..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -o CaptureModule.o \
    "$SWIFT_FILE"

if [ ! -f "CaptureModule.o" ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

# Находим Node headers
NODE_MODULES_PATH="node_modules"
if [ ! -d "$NODE_MODULES_PATH" ]; then
    NODE_MODULES_PATH="../node_modules"
fi

NODE_ADDON_API="$NODE_MODULES_PATH/node-addon-api"
if [ ! -d "$NODE_ADDON_API" ]; then
    echo "❌ node-addon-api not found. Run: npm install"
    exit 1
fi

# Компилируем C++
echo "🔨 Compiling C++..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -I"$NODE_ADDON_API" \
    -I/usr/local/include/node \
    -I"$(node -p 'require("path").dirname(process.execPath) + "/../include/node"')" \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -o webrtc_wrapper.o \
    "$CPP_FILE"

if [ ! -f "webrtc_wrapper.o" ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

# Линкуем
echo "🔗 Linking..."
clang++ \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -o addon.node \
    webrtc_wrapper.o \
    CaptureModule.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

if [ -f "addon.node" ]; then
    echo "✅ Build successful!"
    echo "📋 File info:"
    file addon.node
    ls -lh addon.node
    
    # Проверяем символы
    echo "🔍 Checking symbols..."
    nm -gU addon.node | grep -E "(Init|_napi_register_module)" | head -3
else
    echo "❌ Build failed"
    exit 1
fi

# Очистка временных файлов
rm -f *.o
rm -f *.swiftmodule *.swiftdoc *.swiftsourceinfo

echo "✨ Done!"