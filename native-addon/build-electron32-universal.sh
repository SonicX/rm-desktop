#!/bin/bash

echo "🚀 Building Universal Binary for Electron 32 (ABI 128)"
echo "📱 Current machine: $(uname -m)"

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

# Определяем SDK и компилятор
SDK_PATH=$(xcrun --show-sdk-path)
CLANG_PATH=$(xcrun -f clang++)

echo "📋 Using SDK: $SDK_PATH"
echo "📋 Using compiler: $CLANG_PATH"

# Проверяем node-addon-api
NODE_ADDON_API="node_modules/node-addon-api"
if [ ! -d "$NODE_ADDON_API" ]; then
    echo "📦 Installing node-addon-api..."
    npm install node-addon-api
fi

# Создаем минимальный init wrapper для Electron 32
echo "🔨 Creating Electron 32 wrapper..."
cat > electron32_init.cc << 'EOF'
#include <node.h>
#include <v8.h>

// Внешняя Init функция из webrtc_wrapper.mm
extern "C" void Init(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, void* context);

// Обертка для совместимости с Electron 32
namespace {
    void InitAll(v8::Local<v8::Object> exports,
                 v8::Local<v8::Value> module,
                 v8::Local<v8::Context> context) {
        Init(exports, module, static_cast<void*>(*context));
    }
}

// Макрос регистрации модуля
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitAll)

// Дополнительная регистрация для Electron
#ifdef BUILDING_NODE_EXTENSION
extern "C" NODE_MODULE_EXPORT void
NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports,
                        v8::Local<v8::Value> module,
                        v8::Local<v8::Context> context) {
    InitAll(exports, module, context);
}
#endif
EOF

# Функция компиляции для архитектуры
compile_for_arch() {
    local arch=$1
    echo ""
    echo "🖥️  === Building for $arch ==="
    
    # Swift
    echo "🔨 Compiling Swift for $arch..."
    swiftc -emit-object \
        -module-name CaptureModule \
        -emit-module \
        -emit-module-path . \
        -emit-objc-header \
        -emit-objc-header-path CaptureModule-Swift.h \
        -target ${arch}-apple-macos13.0 \
        -o CaptureModule-${arch}.o \
        "$SWIFT_FILE" 2>&1 | grep -v "warning"
    
    if [ ! -f "CaptureModule-${arch}.o" ]; then
        echo "⚠️ Swift compilation failed for $arch, trying without target..."
        swiftc -emit-object \
            -module-name CaptureModule \
            -arch ${arch} \
            -o CaptureModule-${arch}.o \
            "$SWIFT_FILE" 2>&1 | grep -v "warning"
    fi
    
    if [ ! -f "CaptureModule-${arch}.o" ]; then
        echo "❌ Swift compilation failed for $arch"
        return 1
    fi
    
    # C++ основной файл
    echo "🔨 Compiling C++ for $arch..."
    "$CLANG_PATH" -c \
        -arch ${arch} \
        -std=c++20 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -isysroot "$SDK_PATH" \
        -I"$NODE_ADDON_API" \
        -I"/usr/local/include/node" \
        -I"/usr/include" \
        -I"$SDK_PATH/usr/include" \
        -I"$SDK_PATH/usr/include/c++/v1" \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -DBUILDING_NODE_EXTENSION \
        -o webrtc_wrapper-${arch}.o \
        "$CPP_FILE"
    
    if [ ! -f "webrtc_wrapper-${arch}.o" ]; then
        echo "❌ C++ compilation failed for $arch"
        return 1
    fi
    
    # Wrapper для Electron
    echo "🔨 Compiling wrapper for $arch..."
    "$CLANG_PATH" -c \
        -arch ${arch} \
        -std=c++20 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -isysroot "$SDK_PATH" \
        -I"$NODE_ADDON_API" \
        -I"/usr/local/include/node" \
        -DNODE_GYP_MODULE_NAME=screen_capture_webrtc \
        -DBUILDING_NODE_EXTENSION \
        -o electron32_init-${arch}.o \
        electron32_init.cc
    
    if [ ! -f "electron32_init-${arch}.o" ]; then
        echo "⚠️ Wrapper compilation failed for $arch"
    fi
    
    # Линковка
    echo "🔗 Linking for $arch..."
    "$CLANG_PATH" \
        -arch ${arch} \
        -bundle \
        -undefined dynamic_lookup \
        -mmacosx-version-min=13.0 \
        -stdlib=libc++ \
        -isysroot "$SDK_PATH" \
        -o addon-${arch}.node \
        webrtc_wrapper-${arch}.o \
        CaptureModule-${arch}.o \
        electron32_init-${arch}.o \
        -framework Foundation \
        -framework CoreMedia \
        -framework AVFoundation \
        -framework ScreenCaptureKit \
        -framework CoreVideo \
        -framework AppKit
    
    if [ ! -f "addon-${arch}.node" ]; then
        echo "❌ Linking failed for $arch"
        return 1
    fi
    
    echo "✅ Build complete for $arch"
    return 0
}

# Компилируем для текущей архитектуры
CURRENT_ARCH=$(uname -m)
if [ "$CURRENT_ARCH" = "x86_64" ]; then
    compile_for_arch "x86_64"
    HAVE_X86=true
    HAVE_ARM64=false
elif [ "$CURRENT_ARCH" = "arm64" ]; then
    compile_for_arch "arm64"
    HAVE_X86=false
    HAVE_ARM64=true
fi

# Пытаемся собрать для второй архитектуры (может не получиться)
echo ""
echo "🔄 Attempting cross-compilation..."
if [ "$CURRENT_ARCH" = "x86_64" ]; then
    if compile_for_arch "arm64"; then
        HAVE_ARM64=true
    fi
elif [ "$CURRENT_ARCH" = "arm64" ]; then
    if compile_for_arch "x86_64"; then
        HAVE_X86=true
    fi
fi

# Создаем финальный бинарник
echo ""
if [ "$HAVE_X86" = true ] && [ "$HAVE_ARM64" = true ]; then
    echo "🎯 Creating Universal Binary..."
    lipo -create addon-x86_64.node addon-arm64.node -output addon.node
    echo "✅ UNIVERSAL BINARY created!"
    lipo -info addon.node
elif [ "$HAVE_X86" = true ]; then
    echo "📦 Creating Intel-only binary..."
    cp addon-x86_64.node addon.node
elif [ "$HAVE_ARM64" = true ]; then
    echo "📦 Creating ARM-only binary..."
    cp addon-arm64.node addon.node
else
    echo "❌ No successful builds"
    exit 1
fi

# Проверяем символы
echo ""
echo "🔍 Checking symbols..."
nm -gU addon.node | grep -E "(Init|napi|NODE)" | head -5

# Очистка
echo ""
echo "🧹 Cleaning temp files..."
rm -f *.o addon-*.node electron32_init.cc
rm -f *.swiftmodule *.swiftdoc *.swiftsourceinfo

# Копируем в dist-electron
if [ -d "../dist-electron" ]; then
    echo "📦 Copying to dist-electron..."
    cp addon.node ../dist-electron/native-addon.node
fi

# Финальная информация
echo ""
echo "✨ BUILD COMPLETE!"
echo ""
file addon.node
ls -lh addon.node
echo ""

# Проверка архитектур
if command -v lipo &> /dev/null; then
    ARCH_INFO=$(lipo -info addon.node 2>&1)
    if echo "$ARCH_INFO" | grep -q "x86_64 arm64"; then
        echo "🎉 Universal Binary: ✅ Intel + ✅ Apple Silicon"
    elif echo "$ARCH_INFO" | grep -q "x86_64"; then
        echo "📱 Intel-only build (x86_64)"
    elif echo "$ARCH_INFO" | grep -q "arm64"; then
        echo "📱 Apple Silicon-only build (arm64)"
    fi
fi

echo ""
echo "📝 To use:"
echo "   cp addon.node ../dist-electron/native-addon.node"
echo "   npm start"