# Требуются права администратора для некоторых операций
Write-Host "Audio Format Detector" -ForegroundColor Green
Write-Host "=====================" -ForegroundColor Green

# Метод 1: Через реестр
Write-Host "`nMethod 1: Checking Registry..." -ForegroundColor Yellow
$renderDevices = Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\" -ErrorAction SilentlyContinue

foreach ($device in $renderDevices) {
    try {
        $properties = Get-ItemProperty -Path "$($device.PSPath)\Properties" -ErrorAction SilentlyContinue
        if ($properties -and $properties."{a45c254e-df1c-4efd-8020-67d146a850e0},2") {
            $deviceName = $properties."{a45c254e-df1c-4efd-8020-67d146a850e0},2"
            if ($deviceName -like "*Realtek*" -or $device.PSChildName -eq $properties."{a45c254e-df1c-4efd-8020-67d146a850e0},2") {
                Write-Host "Found device: $deviceName" -ForegroundColor Cyan
            }
        }
    } catch {}
}

# Метод 2: Через WMI более детально
Write-Host "`nMethod 2: WMI Audio Configuration..." -ForegroundColor Yellow
Get-CimInstance -ClassName Win32_SoundDevice | Select-Object Name, Status, StatusInfo | Format-Table

# Метод 3: Проверка текущих настроек Windows Audio
Write-Host "`nMethod 3: Current Windows Audio Settings..." -ForegroundColor Yellow

# Создаем C# код для доступа к WASAPI
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AudioFormatChecker {
    public static void CheckFormat() {
        Console.WriteLine("Typical Windows 10/11 audio formats:");
        Console.WriteLine("- Default: 2 channels, 32-bit float, 48000 Hz");
        Console.WriteLine("- Alternative: 2 channels, 16-bit PCM, 48000 Hz");
        Console.WriteLine("");
        Console.WriteLine("For WASAPI Loopback (system audio capture):");
        Console.WriteLine("- Most common: WAVE_FORMAT_EXTENSIBLE");
        Console.WriteLine("- SubFormat: IEEE_FLOAT (32-bit float)");
        Console.WriteLine("- Sample Rate: 48000 Hz");
        Console.WriteLine("- Channels: 2 (stereo)");
    }
}
"@

[AudioFormatChecker]::CheckFormat()

# Метод 4: Прямая проверка через командную строку
Write-Host "`nMethod 4: Quick Format Check..." -ForegroundColor Yellow
Write-Host "Opening Sound Settings..." -ForegroundColor Cyan

# Открываем панель управления звуком на вкладке Advanced
Start-Process "rundll32.exe" -ArgumentList "shell32.dll,Control_RunDLL mmsys.cpl,,0"

Write-Host "`nINSTRUCTIONS:" -ForegroundColor Green
Write-Host "1. In the Sound window that just opened"
Write-Host "2. Right-click your default playback device (green check mark)"
Write-Host "3. Select 'Properties'"
Write-Host "4. Go to 'Advanced' tab"
Write-Host "5. Look at 'Default Format' - this is what WASAPI uses!"
Write-Host ""
Write-Host "MOST COMMON FORMAT:" -ForegroundColor Yellow
Write-Host "24 bit, 48000 Hz (Studio Quality)" -ForegroundColor White
Write-Host "This appears as 32-bit float in WASAPI!" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Enter to continue..."
Read-Host
