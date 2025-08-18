#!/bin/bash

echo "🚀 Building TRUE Universal Binary for Intel + Apple Silicon"
echo "📱 Current machine: $(uname -m)"

cd native-addon 2>/dev/null || cd .

# Очистка
echo "🧹 Cleaning..."
rm -rf build/
rm -f addon.node addon-*.node
rm -f *.o

# Проверяем исходники
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
    exit 1
fi

echo "📋 Sources found:"
echo "  Swift: $SWIFT_FILE"
echo "  C++: $CPP_FILE"

# Настройки Node
NODE_MODULES_PATH="node_modules"
if [ ! -d "$NODE_MODULES_PATH" ]; then
    NODE_MODULES_PATH="../node_modules"
fi

NODE_ADDON_API="$NODE_MODULES_PATH/node-addon-api"
if [ ! -d "$NODE_ADDON_API" ]; then
    echo "❌ node-addon-api not found"
    exit 1
fi

# ========== КОМПИЛЯЦИЯ ДЛЯ INTEL (x86_64) ==========
echo ""
echo "🖥️  === Building for INTEL (x86_64) ==="

# Swift для Intel
echo "🔨 Compiling Swift for x86_64..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -target x86_64-apple-macos13.0 \
    -o CaptureModule-x86_64.o \
    "$SWIFT_FILE" 2>&1 | grep -v "warning"

if [ ! -f "CaptureModule-x86_64.o" ]; then
    echo "❌ Swift x86_64 compilation failed"
    exit 1
fi

# C++ для Intel
echo "🔨 Compiling C++ for x86_64..."
clang++ -c \
    -arch x86_64 \
    -target x86_64-apple-macos13.0 \
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
    -o webrtc_wrapper-x86_64.o \
    "$CPP_FILE"

if [ ! -f "webrtc_wrapper-x86_64.o" ]; then
    echo "❌ C++ x86_64 compilation failed"
    exit 1
fi

# Линковка для Intel
echo "🔗 Linking for x86_64..."
clang++ \
    -arch x86_64 \
    -target x86_64-apple-macos13.0 \
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

if [ ! -f "addon-x86_64.node" ]; then
    echo "❌ x86_64 linking failed"
    exit 1
fi

echo "✅ Intel (x86_64) build complete"

# ========== КОМПИЛЯЦИЯ ДЛЯ APPLE SILICON (arm64) ==========
echo ""
echo "🖥️  === Building for APPLE SILICON (arm64) ==="

# Swift для ARM
echo "🔨 Compiling Swift for arm64..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -target arm64-apple-macos13.0 \
    -o CaptureModule-arm64.o \
    "$SWIFT_FILE" 2>&1 | grep -v "warning"

if [ ! -f "CaptureModule-arm64.o" ]; then
    echo "❌ Swift arm64 compilation failed"
    # Попробуем без явного target
    swiftc -emit-object \
        -module-name CaptureModule \
        -arch arm64 \
        -o CaptureModule-arm64.o \
        "$SWIFT_FILE" 2>&1 | grep -v "warning"
fi

if [ ! -f "CaptureModule-arm64.o" ]; then
    echo "⚠️ Swift arm64 compilation failed, Universal Binary will be Intel-only"
    HAVE_ARM64=false
else
    HAVE_ARM64=true
fi

if [ "$HAVE_ARM64" = true ]; then
    # C++ для ARM
    echo "🔨 Compiling C++ for arm64..."
    clang++ -c \
        -arch arm64 \
        -target arm64-apple-macos13.0 \
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
        -o webrtc_wrapper-arm64.o \
        "$CPP_FILE"
    
    if [ ! -f "webrtc_wrapper-arm64.o" ]; then
        echo "⚠️ C++ arm64 compilation failed"
        HAVE_ARM64=false
    fi
fi

if [ "$HAVE_ARM64" = true ]; then
    # Линковка для ARM
    echo "🔗 Linking for arm64..."
    clang++ \
        -arch arm64 \
        -target arm64-apple-macos13.0 \
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
    
    if [ ! -f "addon-arm64.node" ]; then
        echo "⚠️ arm64 linking failed"
        HAVE_ARM64=false
    else
        echo "✅ Apple Silicon (arm64) build complete"
    fi
fi

# ========== СОЗДАНИЕ UNIVERSAL BINARY ==========
echo ""
echo "🎯 Creating Universal Binary..."

if [ "$HAVE_ARM64" = true ] && [ -f "addon-arm64.node" ] && [ -f "addon-x86_64.node" ]; then
    lipo -create addon-x86_64.node addon-arm64.node -output addon.node
    
    if [ -f "addon.node" ]; then
        echo "✅ UNIVERSAL BINARY CREATED!"
        echo ""
        echo "📋 Architecture info:"
        lipo -info addon.node
        
        # Должно показать: "Architectures in the fat file: addon.node are: x86_64 arm64"
        
        # Детальная информация
        echo ""
        echo "📊 Detailed info:"
        lipo -detailed_info addon.node | head -20
        
        echo ""
        echo "📦 File size:"
        ls -lh addon.node
        
        # Проверка символов
        echo ""
        echo "🔍 Checking symbols:"
        nm -gU addon.node | grep -E "(Init|_napi_register_module)" | head -3
    else
        echo "❌ Failed to create Universal Binary"
        exit 1
    fi
else
    echo "⚠️ Only Intel version available"
    cp addon-x86_64.node addon.node
    echo "📋 Created Intel-only addon"
    lipo -info addon.node
fi

# Очистка
echo ""
echo "🧹 Cleaning temporary files..."
rm -f *.o
rm -f addon-*.node
rm -f *.swiftmodule *.swiftdoc *.swiftsourceinfo

# Копирование в dist-electron
if [ -f "../dist-electron" ]; then
    echo "📦 Copying to dist-electron..."
    cp addon.node ../dist-electron/native-addon.node
fi

echo ""
echo "✨ BUILD COMPLETE!"
echo ""

# Финальная проверка
if lipo -info addon.node 2>/dev/null | grep -q "x86_64 arm64"; then
    echo "🎉 SUCCESS: Universal Binary created (Intel + Apple Silicon)"
    echo "📱 This addon will work on BOTH Intel and ARM Macs!"
else
    echo "⚠️ WARNING: This is NOT a Universal Binary"
    echo "📱 Architecture: $(lipo -info addon.node 2>/dev/null || file addon.node)"
fi