#!/bin/bash

echo "🔧 Setting up native-addon build environment..."

# Делаем скрипты исполняемыми
echo "📝 Setting executable permissions on scripts..."
chmod +x scripts/*.sh 2>/dev/null
chmod +x *.sh 2>/dev/null
chmod +x build-universal-electron.sh 2>/dev/null

# Создаем необходимые директории
echo "📁 Creating required directories..."
mkdir -p src
mkdir -p scripts
mkdir -p examples

# Организуем файлы если они в корне
echo "📋 Organizing source files..."

# Перемещаем исходники в src если они в корне
[ -f "ScreenCaptureManager.swift" ] && [ ! -f "src/ScreenCaptureManager.swift" ] && mv ScreenCaptureManager.swift src/
[ -f "webrtc_wrapper.mm" ] && [ ! -f "src/webrtc_wrapper.mm" ] && mv webrtc_wrapper.mm src/

# Копируем заголовочные файлы
[ -f "CaptureModule-Bridging-Header.h" ] && cp CaptureModule-Bridging-Header.h src/ 2>/dev/null
[ -f "CaptureModule-Swift.h" ] && cp CaptureModule-Swift.h src/ 2>/dev/null

# Проверяем наличие основных файлов
echo "✅ Checking required files..."
required_files=(
    "src/ScreenCaptureManager.swift"
    "src/webrtc_wrapper.mm"
    "binding.gyp"
    "package.json"
)

missing_files=()
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        # Проверяем, может файл в корне
        base_name=$(basename "$file")
        if [ -f "$base_name" ]; then
            echo "  Moving $base_name to $file"
            mkdir -p $(dirname "$file")
            mv "$base_name" "$file"
        else
            missing_files+=("$file")
        fi
    else
        echo "  ✓ $file"
    fi
done

if [ ${#missing_files[@]} -gt 0 ]; then
    echo "❌ Missing required files:"
    for file in "${missing_files[@]}"; do
        echo "  - $file"
    done
    echo ""
    echo "Please ensure all required files are present."
    exit 1
fi

# Создаем скрипт сборки в scripts если его нет
if [ ! -f "scripts/build-for-electron.sh" ]; then
    echo "📝 Creating build script..."
    mkdir -p scripts
    cat > scripts/build-for-electron.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")/.."
bash build-universal-electron.sh || bash scripts/build-universal.sh || npm run build:manual
EOF
    chmod +x scripts/build-for-electron.sh
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "  1. npm install        # Install dependencies"
echo "  2. npm run build      # Build the addon"
echo ""
echo "🏗️ Available build commands:"
echo "  npm run build         # Standard build"
echo "  npm run rebuild       # Rebuild with electron-rebuild"
echo ""

# Показываем структуру файлов
echo "📁 Current structure:"
echo "  src/"
ls -la src/ 2>/dev/null | grep -E "\.(swift|mm|h)$" | awk '{print "    "$NF}'
echo "  scripts/"
ls -la scripts/ 2>/dev/null | grep "\.sh$" | awk '{print "    "$NF}'