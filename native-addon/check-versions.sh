#!/bin/bash

echo "🔍 Version Diagnostic Tool"
echo "=========================="
echo ""

# Проверяем версию Electron в package.json
echo "📦 Package.json versions:"
for pkg in "../package.json" "../../package.json"; do
    if [ -f "$pkg" ]; then
        FULL_PATH=$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")
        ELECTRON_VERSION=$(node -p "
            try {
                const p = require('$FULL_PATH');
                (p.devDependencies?.electron || p.dependencies?.electron || 'not found').replace(/[\^~]/, '');
            } catch(e) {
                'error reading file';
            }
        ")
        echo "   $pkg: Electron $ELECTRON_VERSION"
    fi
done

echo ""
echo "💻 System versions:"
# Проверяем установленный Electron
if command -v electron &> /dev/null; then
    INSTALLED_VERSION=$(electron --version | sed 's/v//')
    echo "   Installed Electron: $INSTALLED_VERSION"
else
    echo "   Electron: not installed globally"
fi

# Проверяем Node.js
NODE_VERSION=$(node --version)
NODE_ABI=$(node -p "process.versions.modules")
echo "   Node.js: $NODE_VERSION (ABI $NODE_ABI)"

echo ""
echo "📊 ABI Version Reference Table:"
echo "   ================================"
echo "   Electron 29.x → ABI 121"
echo "   Electron 30.x → ABI 121"
echo "   Electron 31.x → ABI 124"
echo "   Electron 32.x → ABI 125  ← Your version"
echo "   Electron 33.x → ABI 127"
echo "   Electron 34.x → ABI 128"
echo "   ================================"

# Проверяем текущий addon
echo ""
if [ -f "addon.node" ]; then
    echo "📄 Current addon.node:"
    echo "   File size: $(ls -lh addon.node | awk '{print $5}')"
    echo "   Created: $(stat -f "%Sm" -t "%Y-%m-%d %H:%M" addon.node 2>/dev/null || stat -c "%y" addon.node 2>/dev/null | cut -d' ' -f1-2)"
    echo "   Architecture: $(lipo -info addon.node 2>/dev/null || file addon.node | cut -d: -f2)"
    
    # Пытаемся загрузить в Node.js
    echo ""
    echo "   Testing with current Node.js:"
    node -e "
        try { 
            require('./addon.node'); 
            console.log('      ✅ Loads successfully in Node.js $NODE_VERSION');
        } catch(e) { 
            if (e.message.includes('NODE_MODULE_VERSION')) {
                const match = e.message.match(/NODE_MODULE_VERSION (\d+).*NODE_MODULE_VERSION (\d+)/);
                if (match) {
                    console.log('      ❌ ABI mismatch: addon has ABI ' + match[1] + ', but Node.js needs ABI ' + match[2]);
                } else {
                    console.log('      ❌ ' + e.message);
                }
            } else {
                console.log('      ❌ ' + e.message.split('\\n')[0]);
            }
        }
    " 2>&1
    
    # Проверяем Electron headers
    echo ""
    echo "   Electron headers cache:"
    if [ -d "$HOME/.electron-gyp" ]; then
        for dir in $HOME/.electron-gyp/*/; do
            if [ -d "$dir" ]; then
                version=$(basename "$dir")
                echo "      - v$version"
            fi
        done
    else
        echo "      No cached headers"
    fi
else
    echo "❌ addon.node not found"
    echo "   Run ./build-universal.sh to build"
fi

echo ""
echo "💡 Recommendations:"
echo "   1. Make sure package.json has Electron ^32.3.0"
echo "   2. Run ./build-universal.sh to rebuild addon"
echo "   3. The addon will be built for Electron automatically"
echo ""