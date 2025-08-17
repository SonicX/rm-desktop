#!/bin/bash

echo "🚀 Building for native architecture only"

# Определяем текущую архитектуру
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    echo "📱 Building for Intel Mac (x86_64)"
elif [ "$ARCH" = "arm64" ]; then
    echo "📱 Building for Apple Silicon (arm64)"
else
    echo "❌ Unknown architecture: $ARCH"
    exit 1
fi

# Запускаем прямую сборку (она уже работает)
./build-direct.sh

# Проверяем результат
if [ -f "addon.node" ]; then
    echo ""
    echo "✅ Native build successful for $ARCH"
    echo "📋 Binary info:"
    file addon.node
    
    # Для отладки Electron - копируем в нужное место
    if [ -d "../node_modules/electron/dist" ]; then
        echo "📦 Found Electron, you may need to rebuild with:"
        echo "   npm run rebuild"
    fi
else
    echo "❌ Build failed"
    exit 1
fi