#!/bin/bash

echo "🚀 Creating Universal Binary for Electron 32"
echo "📱 Current architecture: $(uname -m)"

# Сохраняем текущий рабочий addon
if [ -f "addon.node" ]; then
    CURRENT_ARCH=$(lipo -info addon.node 2>&1 | grep -o 'x86_64\|arm64')
    echo "📋 Current addon is: $CURRENT_ARCH"
    cp addon.node addon-${CURRENT_ARCH}.node
fi

# Функция для сборки конкретной архитектуры
build_for_arch() {
    local arch=$1
    echo ""
    echo "🖥️  Building for $arch..."
    
    # Очистка
    rm -f *.o
    
    # Скачиваем Electron headers если нужно
    ELECTRON_VERSION="32.3.3"
    HEADERS_DIR="$HOME/.electron-gyp/$ELECTRON_VERSION"
    
    if [ ! -d "$HEADERS_DIR/include/node" ]; then
        echo "📥 Downloading Electron headers..."
        mkdir -p "$HEADERS_DIR"
        curl -sL "https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz" | \
            tar -xz -C "$HEADERS_DIR" --strip-components=1
    fi
    
    # Компилируем Swift для архитектуры
    echo "🔨 Compiling Swift for $arch..."
    swiftc -emit-object \
        -module-name CaptureModule \
        -emit-module \
        -emit-module-path . \
        -emit-objc-header \
        -emit-objc-header-path CaptureModule-Swift.h \
        -target ${arch}-apple-macos13.0 \
        -o CaptureModule-${arch}.o \
        src/ScreenCaptureManager.swift 2>&1 | grep -v "warning"
    
    if [ ! -f "CaptureModule-${arch}.o" ]; then
        # Пробуем альтернативный способ
        swiftc -emit-object \
            -module-name CaptureModule \
            -arch ${arch} \
            -o CaptureModule-${arch}.o \
            src/ScreenCaptureManager.swift 2>&1 | grep -v "warning"
    fi
    
    if [ ! -f "CaptureModule-${arch}.o" ]; then
        echo "❌ Swift compilation failed for $arch"
        return 1
    fi
    
    # Создаем wrapper
    cat > wrapper-${arch}.cc << 'EOF'
extern "C" void Init(void* exports, void* module, void* context);

extern "C" __attribute__((visibility("default"))) 
void node_register_module_v128(void* exports, void* module, void* context) {
    Init(exports, module, context);
}

extern "C" __attribute__((visibility("default")))
void napi_register_module_v1(void* exports, void* module, void* context) {
    Init(exports, module, context);
}
EOF
    
    # Компилируем wrapper
    clang++ -c \
        -arch ${arch} \
        -std=c++20 \
        -stdlib=libc++ \
        -fPIC \
        -o wrapper-${arch}.o \
        wrapper-${arch}.cc
    
    # Компилируем C++
    echo "🔨 Compiling C++ for $arch..."
    clang++ -c \
        -arch ${arch} \
        -std=c++20 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -I"$HEADERS_DIR/include/node" \
        -I"node_modules/node-addon-api" \
        -I"." \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -DBUILDING_NODE_EXTENSION \
        -o webrtc_wrapper-${arch}.o \
        src/webrtc_wrapper.mm
    
    if [ ! -f "webrtc_wrapper-${arch}.o" ]; then
        # Fallback без headers
        clang++ -c \
            -arch ${arch} \
            -std=c++20 \
            -stdlib=libc++ \
            -fPIC \
            -fobjc-arc \
            -I"node_modules/node-addon-api" \
            -DNAPI_DISABLE_CPP_EXCEPTIONS \
            -o webrtc_wrapper-${arch}.o \
            src/webrtc_wrapper.mm
    fi
    
    if [ ! -f "webrtc_wrapper-${arch}.o" ]; then
        echo "❌ C++ compilation failed for $arch"
        return 1
    fi
    
    # Линкуем
    echo "🔗 Linking for $arch..."
    clang++ \
        -arch ${arch} \
        -bundle \
        -undefined dynamic_lookup \
        -mmacosx-version-min=13.0 \
        -stdlib=libc++ \
        -o addon-${arch}.node \
        webrtc_wrapper-${arch}.o \
        CaptureModule-${arch}.o \
        wrapper-${arch}.o \
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
    
    # Очистка временных файлов
    rm -f wrapper-${arch}.cc wrapper-${arch}.o
    rm -f CaptureModule-${arch}.o webrtc_wrapper-${arch}.o
    
    return 0
}

# Если у нас уже есть x86_64, пробуем собрать arm64
if [ -f "addon-x86_64.node" ]; then
    echo "✅ Already have x86_64 build"
    HAVE_X86=true
else
    if build_for_arch "x86_64"; then
        HAVE_X86=true
    else
        HAVE_X86=false
    fi
fi

# Пробуем собрать для ARM
if [ -f "addon-arm64.node" ]; then
    echo "✅ Already have arm64 build"
    HAVE_ARM=true
else
    if build_for_arch "arm64"; then
        HAVE_ARM=true
    else
        HAVE_ARM=false
        echo "⚠️ ARM build failed (normal on Intel Mac)"
    fi
fi

# Создаем Universal Binary если возможно
echo ""
if [ "$HAVE_X86" = true ] && [ "$HAVE_ARM" = true ]; then
    echo "🎯 Creating Universal Binary..."
    lipo -create addon-x86_64.node addon-arm64.node -output addon.node
    
    if [ -f "addon.node" ]; then
        echo "✅ UNIVERSAL BINARY CREATED!"
        echo ""
        lipo -info addon.node
        file addon.node
        ls -lh addon.node
        
        # Копируем
        cp addon.node ../dist-electron/native-addon.node
        echo ""
        echo "🎉 Universal Binary copied to dist-electron/"
    fi
    
elif [ "$HAVE_X86" = true ]; then
    echo "📦 Using Intel-only build"
    cp addon-x86_64.node addon.node
    cp addon.node ../dist-electron/native-addon.node
    echo "✅ Intel version copied to dist-electron/"
    
elif [ "$HAVE_ARM" = true ]; then
    echo "📦 Using ARM-only build"
    cp addon-arm64.node addon.node
    cp addon.node ../dist-electron/native-addon.node
    echo "✅ ARM version copied to dist-electron/"
    
else
    echo "❌ No successful builds"
    exit 1
fi

# Очистка
rm -f addon-x86_64.node addon-arm64.node
rm -f *.o

echo ""
echo "✨ Done!"

# Инструкции для создания полной Universal Binary
if [ "$HAVE_X86" = true ] && [ "$HAVE_ARM" = false ]; then
    echo ""
    echo "📝 To create Universal Binary:"
    echo "   1. Copy this project to an ARM Mac"
    echo "   2. Run: ./make-universal.sh"
    echo "   3. Copy the resulting addon-arm64.node back here"
    echo "   4. Run: lipo -create addon-x86_64.node addon-arm64.node -output addon.node"
fi