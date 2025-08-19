#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <thread>
#include <atomic>
#include <vector>
#include <memory>
#include <string>
#include <chrono>
#include <mutex>
#include <cstring>
#include <cmath>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")

// Глобальные переменные для callbacks
static napi_threadsafe_function g_video_tsfn = nullptr;
static napi_threadsafe_function g_audio_tsfn = nullptr;
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

// Структуры для передачи данных
struct VideoFrameData {
    uint8_t* data;
    int width;
    int height;
    double timestamp;
    bool hasRealPixels;
    size_t dataSize;
};

struct AudioFrameData {
    float* samples;
    int numSamples;
    int sampleRate;
    int channels;
    double timestamp;
    bool isSystemAudio;
};

// Структура для хранения информации об источнике
struct CaptureSource {
    std::string type;  // "display", "window", "application"
    std::string id;
    std::string name;
    int width;
    int height;
};

// Глобальные параметры качества
struct QualitySettings {
    int width = 1920;
    int height = 1080;
    int fps = 30;
    std::mutex mutex;
} g_quality;

// Вспомогательная функция для получения timestamp
double GetTimestamp() {
    static auto start = std::chrono::high_resolution_clock::now();
    auto now = std::chrono::high_resolution_clock::now();
    return std::chrono::duration<double>(now - start).count();
}

// Класс для захвата экрана через DXGI
class DXGIScreenCapture {
private:
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    IDXGIOutputDuplication* duplication = nullptr;
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    int targetWidth = 1920;
    int targetHeight = 1080;
    int targetFps = 30;
    
public:
    bool Initialize(int displayId) {
        // Создаем D3D11 устройство
        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0
        };
        
        D3D_FEATURE_LEVEL featureLevel;
        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &device,
            &featureLevel,
            &context
        );
        
        if (FAILED(hr)) {
            return false;
        }
        
        // Получаем DXGI адаптер
        IDXGIDevice* dxgiDevice = nullptr;
        hr = device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
        if (FAILED(hr)) return false;
        
        IDXGIAdapter* adapter = nullptr;
        hr = dxgiDevice->GetAdapter(&adapter);
        dxgiDevice->Release();
        if (FAILED(hr)) return false;
        
        // Получаем нужный output
        IDXGIOutput* output = nullptr;
        hr = adapter->EnumOutputs(displayId, &output);
        adapter->Release();
        if (FAILED(hr)) return false;
        
        // Получаем IDXGIOutput1
        IDXGIOutput1* output1 = nullptr;
        hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
        output->Release();
        if (FAILED(hr)) return false;
        
        // Создаем дупликацию экрана
        hr = output1->DuplicateOutput(device, &duplication);
        output1->Release();
        
        return SUCCEEDED(hr);
    }
    
    void SetQuality(int width, int height, int fps) {
        targetWidth = width;
        targetHeight = height;
        targetFps = fps;
    }
    
    void StartCapture() {
        isCapturing = true;
        captureThread = std::thread([this]() {
            CaptureLoop();
        });
    }
    
    void CaptureLoop() {
        int frameInterval = 1000 / targetFps; // миллисекунды между кадрами
        
        while (isCapturing) {
            auto frameStart = std::chrono::high_resolution_clock::now();
            
            IDXGIResource* desktopResource = nullptr;
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            
            // Получаем следующий кадр (таймаут 100мс)
            HRESULT hr = duplication->AcquireNextFrame(100, &frameInfo, &desktopResource);
            
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                continue; // Нет новых кадров
            }
            
            if (SUCCEEDED(hr) && desktopResource) {
                // Конвертируем в текстуру
                ID3D11Texture2D* texture = nullptr;
                hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&texture);
                
                if (SUCCEEDED(hr) && texture) {
                    ProcessFrame(texture);
                    texture->Release();
                }
                
                desktopResource->Release();
                duplication->ReleaseFrame();
            } else if (hr == DXGI_ERROR_ACCESS_LOST) {
                // Нужно переинициализировать дупликацию
                break;
            }
            
            // Контроль FPS
            auto frameEnd = std::chrono::high_resolution_clock::now();
            auto frameDuration = std::chrono::duration_cast<std::chrono::milliseconds>(frameEnd - frameStart).count();
            if (frameDuration < frameInterval) {
                Sleep(frameInterval - frameDuration);
            }
        }
    }
    
    void ProcessFrame(ID3D11Texture2D* texture) {
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        
        // Создаем staging текстуру для чтения CPU
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        
        ID3D11Texture2D* stagingTexture = nullptr;
        HRESULT hr = device->CreateTexture2D(&desc, nullptr, &stagingTexture);
        
        if (FAILED(hr) || !stagingTexture) return;
        
        // Копируем данные
        context->CopyResource(stagingTexture, texture);
        
        // Мапим для чтения
        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = context->Map(stagingTexture, 0, D3D11_MAP_READ, 0, &mapped);
        
        if (SUCCEEDED(hr)) {
            // Создаем структуру с данными
            VideoFrameData* frameData = new VideoFrameData();
            frameData->width = targetWidth;
            frameData->height = targetHeight;
            frameData->timestamp = GetTimestamp();
            frameData->hasRealPixels = true;
            
            // Масштабируем если нужно
            if (desc.Width != targetWidth || desc.Height != targetHeight) {
                // Простое масштабирование (можно улучшить)
                frameData->dataSize = targetWidth * targetHeight * 4;
                frameData->data = new uint8_t[frameData->dataSize];
                
                float xRatio = (float)desc.Width / targetWidth;
                float yRatio = (float)desc.Height / targetHeight;
                
                uint8_t* src = (uint8_t*)mapped.pData;
                uint8_t* dst = frameData->data;
                
                for (int y = 0; y < targetHeight; y++) {
                    for (int x = 0; x < targetWidth; x++) {
                        int srcX = (int)(x * xRatio);
                        int srcY = (int)(y * yRatio);
                        int srcIdx = (srcY * mapped.RowPitch) + (srcX * 4);
                        int dstIdx = (y * targetWidth + x) * 4;
                        
                        // Копируем BGRA пиксель
                        memcpy(&dst[dstIdx], &src[srcIdx], 4);
                    }
                }
            } else {
                // Прямое копирование
                frameData->dataSize = desc.Width * desc.Height * 4;
                frameData->data = new uint8_t[frameData->dataSize];
                
                uint8_t* src = (uint8_t*)mapped.pData;
                uint8_t* dst = frameData->data;
                
                for (UINT y = 0; y < desc.Height; y++) {
                    memcpy(dst, src, desc.Width * 4);
                    src += mapped.RowPitch;
                    dst += desc.Width * 4;
                }
            }
            
            context->Unmap(stagingTexture, 0);
            
            // Увеличиваем счетчик кадров
            g_video_frame_count++;
            
            // Отправляем в JavaScript callback
            if (g_video_tsfn) {
                napi_status status = napi_call_threadsafe_function(
                    g_video_tsfn,
                    frameData,
                    napi_tsfn_blocking
                );
                
                if (status != napi_ok) {
                    delete[] frameData->data;
                    delete frameData;
                }
            } else {
                delete[] frameData->data;
                delete frameData;
            }
        }
        
        stagingTexture->Release();
    }
    
    void StopCapture() {
        isCapturing = false;
        if (captureThread.joinable()) {
            captureThread.join();
        }
    }
    
    ~DXGIScreenCapture() {
        StopCapture();
        if (duplication) duplication->Release();
        if (context) context->Release();
        if (device) device->Release();
    }
};

// Класс для захвата аудио через WASAPI
class WASAPIAudioCapture {
private:
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    bool isSystemAudio = true;
    
public:
    bool Initialize(const std::string& sourceType, const std::string& sourceId) {
        CoInitialize(nullptr);
        
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void**)&deviceEnumerator
        );
        
        if (FAILED(hr)) return false;
        
        // Определяем тип захвата
        if (sourceType == "display" || sourceType == "screen") {
            // Системный звук - используем устройство вывода с loopback
            isSystemAudio = true;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eRender,  // Важно! Для системного звука
                eConsole,
                &device
            );
        } else if (sourceType == "microphone") {
            // Микрофон
            isSystemAudio = false;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eCapture,  // Для микрофона
                eConsole,
                &device
            );
        } else {
            // Для окон/приложений пока используем системный звук
            isSystemAudio = true;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eRender,
                eConsole,
                &device
            );
        }
        
        if (FAILED(hr)) return false;
        
        // Активируем audio client
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            (void**)&audioClient
        );
        
        if (FAILED(hr)) return false;
        
        // Получаем формат
        hr = audioClient->GetMixFormat(&waveFormat);
        if (FAILED(hr)) return false;
        
        // Инициализируем
        DWORD streamFlags = isSystemAudio ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            streamFlags,
            10000000,  // 1 секунда буфера
            0,
            waveFormat,
            nullptr
        );
        
        if (FAILED(hr)) return false;
        
        // Получаем capture client
        hr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            (void**)&captureClient
        );
        
        return SUCCEEDED(hr);
    }
    
    void StartCapture() {
        if (!audioClient) return;
        
        isCapturing = true;
        HRESULT hr = audioClient->Start();
        
        if (SUCCEEDED(hr)) {
            captureThread = std::thread([this]() {
                CaptureLoop();
            });
        }
    }
    
    void CaptureLoop() {
        while (isCapturing) {
            Sleep(10); // Ждем немного данных
            
            UINT32 packetLength = 0;
            HRESULT hr = captureClient->GetNextPacketSize(&packetLength);
            
            while (packetLength != 0 && isCapturing) {
                BYTE* data = nullptr;
                UINT32 numFramesAvailable;
                DWORD flags;
                
                hr = captureClient->GetBuffer(
                    &data,
                    &numFramesAvailable,
                    &flags,
                    nullptr,
                    nullptr
                );
                
                if (SUCCEEDED(hr)) {
                    // Проверяем, не тишина ли это
                    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && numFramesAvailable > 0) {
                        ProcessAudioData(data, numFramesAvailable);
                    }
                    
                    captureClient->ReleaseBuffer(numFramesAvailable);
                }
                
                hr = captureClient->GetNextPacketSize(&packetLength);
                if (FAILED(hr)) break;
            }
        }
    }
    
    void ProcessAudioData(BYTE* data, UINT32 numFrames) {
        AudioFrameData* frameData = new AudioFrameData();
        frameData->numSamples = numFrames;
        frameData->sampleRate = waveFormat->nSamplesPerSec;
        frameData->channels = waveFormat->nChannels;
        frameData->timestamp = GetTimestamp();
        frameData->isSystemAudio = isSystemAudio;
        
        // Выделяем память для сэмплов
        size_t sampleCount = numFrames * waveFormat->nChannels;
        frameData->samples = new float[sampleCount];
        
        // Конвертируем в float
        if (waveFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            // Уже float
            memcpy(frameData->samples, data, sampleCount * sizeof(float));
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_PCM) {
            // Конвертируем из PCM
            if (waveFormat->wBitsPerSample == 16) {
                INT16* pcmData = (INT16*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    frameData->samples[i] = pcmData[i] / 32768.0f;
                }
            } else if (waveFormat->wBitsPerSample == 32) {
                INT32* pcmData = (INT32*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    frameData->samples[i] = pcmData[i] / 2147483648.0f;
                }
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            WAVEFORMATEXTENSIBLE* wfex = (WAVEFORMATEXTENSIBLE*)waveFormat;
            if (wfex->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) {
                memcpy(frameData->samples, data, sampleCount * sizeof(float));
            } else if (wfex->SubFormat == KSDATAFORMAT_SUBTYPE_PCM) {
                INT16* pcmData = (INT16*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    frameData->samples[i] = pcmData[i] / 32768.0f;
                }
            }
        }
        
        // Увеличиваем счетчик
        g_audio_frame_count++;
        
        // Отправляем в JavaScript
        if (g_audio_tsfn) {
            napi_status status = napi_call_threadsafe_function(
                g_audio_tsfn,
                frameData,
                napi_tsfn_blocking
            );
            
            if (status != napi_ok) {
                delete[] frameData->samples;
                delete frameData;
            }
        } else {
            delete[] frameData->samples;
            delete frameData;
        }
    }
    
    void StopCapture() {
        isCapturing = false;
        
        if (audioClient) {
            audioClient->Stop();
        }
        
        if (captureThread.joinable()) {
            captureThread.join();
        }
    }
    
    ~WASAPIAudioCapture() {
        StopCapture();
        if (captureClient) captureClient->Release();
        if (audioClient) audioClient->Release();
        if (device) device->Release();
        if (deviceEnumerator) deviceEnumerator->Release();
        if (waveFormat) CoTaskMemFree(waveFormat);
        CoUninitialize();
    }
};

// Глобальные экземпляры захвата
static std::unique_ptr<DXGIScreenCapture> g_screenCapture;
static std::unique_ptr<WASAPIAudioCapture> g_audioCapture;
static CaptureSource g_currentSource;

// === N-API функции ===

// Тестовый метод
napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows Native Module v1.0 - REAL", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Получение доступных источников
napi_value GetAvailableSources(napi_env env, napi_callback_info info) {
    napi_value array;
    napi_create_array(env, &array);
    
    std::vector<CaptureSource> sources;
    
    // Перечисляем дисплеи через DXGI
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    
    if (SUCCEEDED(hr)) {
        UINT adapterIndex = 0;
        IDXGIAdapter1* adapter = nullptr;
        
        while (factory->EnumAdapters1(adapterIndex, &adapter) != DXGI_ERROR_NOT_FOUND) {
            UINT outputIndex = 0;
            IDXGIOutput* output = nullptr;
            
            while (adapter->EnumOutputs(outputIndex, &output) != DXGI_ERROR_NOT_FOUND) {
                DXGI_OUTPUT_DESC desc;
                output->GetDesc(&desc);
                
                CaptureSource source;
                source.type = "screen";
                source.id = std::to_string(outputIndex);
                source.name = "Display " + std::to_string(outputIndex + 1);
                source.width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
                source.height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
                
                sources.push_back(source);
                
                output->Release();
                outputIndex++;
            }
            
            adapter->Release();
            adapterIndex++;
        }
        
        factory->Release();
    }
    
    // Добавляем источники окон (упрощенно)
    HWND hwnd = GetForegroundWindow();
    if (hwnd) {
        char windowTitle[256];
        GetWindowTextA(hwnd, windowTitle, sizeof(windowTitle));
        
        RECT rect;
        GetWindowRect(hwnd, &rect);
        
        CaptureSource source;
        source.type = "window";
        source.id = std::to_string((intptr_t)hwnd);
        source.name = std::string(windowTitle);
        source.width = rect.right - rect.left;
        source.height = rect.bottom - rect.top;
        
        sources.push_back(source);
    }
    
    // Конвертируем в JavaScript массив
    for (size_t i = 0; i < sources.size(); i++) {
        napi_value obj;
        napi_create_object(env, &obj);
        
        napi_value type, id, name, width, height;
        napi_create_string_utf8(env, sources[i].type.c_str(), NAPI_AUTO_LENGTH, &type);
        napi_create_string_utf8(env, sources[i].id.c_str(), NAPI_AUTO_LENGTH, &id);
        napi_create_string_utf8(env, sources[i].name.c_str(), NAPI_AUTO_LENGTH, &name);
        napi_create_int32(env, sources[i].width, &width);
        napi_create_int32(env, sources[i].height, &height);
        
        napi_set_named_property(env, obj, "type", type);
        napi_set_named_property(env, obj, "id", id);
        napi_set_named_property(env, obj, "name", name);
        napi_set_named_property(env, obj, "width", width);
        napi_set_named_property(env, obj, "height", height);
        
        napi_set_element(env, array, i, obj);
    }
    
    return array;
}

// Установка источника захвата
napi_value SetCaptureSource(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected source object");
        return nullptr;
    }
    
    // Получаем type и id
    napi_value typeVal, idVal;
    napi_get_named_property(env, argv[0], "type", &typeVal);
    napi_get_named_property(env, argv[0], "id", &idVal);
    
    char type[256], id[256];
    size_t typeLen, idLen;
    napi_get_value_string_utf8(env, typeVal, type, sizeof(type), &typeLen);
    napi_get_value_string_utf8(env, idVal, id, sizeof(id), &idLen);
    
    // Сохраняем текущий источник
    g_currentSource.type = type;
    g_currentSource.id = id;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// Установка качества захвата
napi_value SetCaptureQuality(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected quality object");
        return nullptr;
    }
    
    napi_value widthVal, heightVal, fpsVal;
    napi_get_named_property(env, argv[0], "width", &widthVal);
    napi_get_named_property(env, argv[0], "height", &heightVal);
    napi_get_named_property(env, argv[0], "fps", &fpsVal);
    
    int32_t width, height, fps;
    napi_get_value_int32(env, widthVal, &width);
    napi_get_value_int32(env, heightVal, &height);
    napi_get_value_int32(env, fpsVal, &fps);
    
    // Сохраняем настройки качества
    {
        std::lock_guard<std::mutex> lock(g_quality.mutex);
        g_quality.width = width;
        g_quality.height = height;
        g_quality.fps = fps;
    }
    
    // Применяем к текущему захвату если он активен
    if (g_screenCapture) {
        g_screenCapture->SetQuality(width, height, fps);
    }
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// Начало захвата
napi_value StartCapture(napi_env env, napi_callback_info info) {
    // Останавливаем предыдущий захват
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
        g_audioCapture.reset();
    }
    
    // Создаем новые экземпляры
    bool videoStarted = false;
    bool audioStarted = false;
    
    // Запускаем видео захват
    if (g_currentSource.type == "screen" || g_currentSource.type == "display") {
        int displayId = 0;
        try {
            displayId = std::stoi(g_currentSource.id);
        } catch (...) {
            displayId = 0;
        }
        
        g_screenCapture = std::make_unique<DXGIScreenCapture>();
        if (g_screenCapture->Initialize(displayId)) {
            // Применяем настройки качества
            std::lock_guard<std::mutex> lock(g_quality.mutex);
            g_screenCapture->SetQuality(g_quality.width, g_quality.height, g_quality.fps);
            
            g_screenCapture->StartCapture();
            videoStarted = true;
        }
    }
    
    // Запускаем аудио захват
    g_audioCapture = std::make_unique<WASAPIAudioCapture>();
    if (g_audioCapture->Initialize(g_currentSource.type, g_currentSource.id)) {
        g_audioCapture->StartCapture();
        audioStarted = true;
    }
    
    g_capture_active = videoStarted || audioStarted;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, videoStarted || audioStarted, &success);
    napi_set_named_property(env, result, "success", success);
    
    napi_value message;
    std::string msg = "Started: ";
    if (videoStarted) msg += "video ";
    if (audioStarted) msg += "audio";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

// Остановка захвата
napi_value StopCapture(napi_env env, napi_callback_info info) {
    g_capture_active = false;
    
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
        g_audioCapture.reset();
    }
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// Установка callback для видео
napi_value SetWebRTCVideoCallback(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected callback function");
        return nullptr;
    }
    
    // Удаляем старый callback если есть
    if (g_video_tsfn) {
        napi_release_threadsafe_function(g_video_tsfn, napi_tsfn_release);
        g_video_tsfn = nullptr;
    }
    
    // Создаем новый threadsafe function
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCVideoCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],  // JavaScript функция
        nullptr,  // async_resource
        work_name,  // async_resource_name
        0,  // max_queue_size (unlimited)
        1,  // initial_thread_count
        nullptr,  // thread_finalize_data
        nullptr,  // thread_finalize_cb
        nullptr,  // context
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            // Вызывается в главном потоке JavaScript
            VideoFrameData* frameData = (VideoFrameData*)data;
            
            napi_value videoInfo;
            napi_create_object(env, &videoInfo);
            
            // Добавляем метаданные
            napi_value width, height, timestamp, hasRealPixels, frameNumber;
            napi_create_int32(env, frameData->width, &width);
            napi_create_int32(env, frameData->height, &height);
            napi_create_double(env, frameData->timestamp, &timestamp);
            napi_get_boolean(env, frameData->hasRealPixels, &hasRealPixels);
            napi_create_double(env, (double)g_video_frame_count.load(), &frameNumber);
            
            napi_set_named_property(env, videoInfo, "width", width);
            napi_set_named_property(env, videoInfo, "height", height);
            napi_set_named_property(env, videoInfo, "timestamp", timestamp);
            napi_set_named_property(env, videoInfo, "hasRealPixels", hasRealPixels);
            napi_set_named_property(env, videoInfo, "frameNumber", frameNumber);
            
            // Создаем ArrayBuffer с пикселями
            if (frameData->hasRealPixels && frameData->data) {
                void* buffer_data;
                napi_value arrayBuffer;
                napi_create_arraybuffer(env, frameData->dataSize, &buffer_data, &arrayBuffer);
                memcpy(buffer_data, frameData->data, frameData->dataSize);
                napi_set_named_property(env, videoInfo, "data", arrayBuffer);
            }
            
            // Вызываем JavaScript callback
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &videoInfo, &result);
            
            // Очищаем память
            delete[] frameData->data;
            delete frameData;
        },
        &g_video_tsfn
    );
    
    napi_value result;
    napi_create_string_utf8(env, "WebRTC video callback set", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Установка callback для аудио
napi_value SetWebRTCAudioCallback(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected callback function");
        return nullptr;
    }
    
    // Удаляем старый callback если есть
    if (g_audio_tsfn) {
        napi_release_threadsafe_function(g_audio_tsfn, napi_tsfn_release);
        g_audio_tsfn = nullptr;
    }
    
    // Создаем новый threadsafe function
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCAudioCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],  // JavaScript функция
        nullptr,  // async_resource
        work_name,  // async_resource_name
        0,  // max_queue_size (unlimited)
        1,  // initial_thread_count
        nullptr,  // thread_finalize_data
        nullptr,  // thread_finalize_cb
        nullptr,  // context
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            // Вызывается в главном потоке JavaScript
            AudioFrameData* frameData = (AudioFrameData*)data;
            
            napi_value audioInfo;
            napi_create_object(env, &audioInfo);
            
            // Добавляем метаданные
            napi_value sampleRate, channels, timestamp, numSamples, frameNumber, source;
            napi_create_int32(env, frameData->sampleRate, &sampleRate);
            napi_create_int32(env, frameData->channels, &channels);
            napi_create_double(env, frameData->timestamp, &timestamp);
            napi_create_int32(env, frameData->numSamples, &numSamples);
            napi_create_double(env, (double)g_audio_frame_count.load(), &frameNumber);
            napi_create_string_utf8(env, frameData->isSystemAudio ? "system" : "microphone", 
                                   NAPI_AUTO_LENGTH, &source);
            
            napi_set_named_property(env, audioInfo, "sampleRate", sampleRate);
            napi_set_named_property(env, audioInfo, "channels", channels);
            napi_set_named_property(env, audioInfo, "timestamp", timestamp);
            napi_set_named_property(env, audioInfo, "numSamples", numSamples);
            napi_set_named_property(env, audioInfo, "frameNumber", frameNumber);
            napi_set_named_property(env, audioInfo, "source", source);
            
            // Создаем ArrayBuffer с сэмплами
            if (frameData->samples) {
                void* buffer_data;
                napi_value arrayBuffer;
                size_t dataSize = frameData->numSamples * frameData->channels * sizeof(float);
                napi_create_arraybuffer(env, dataSize, &buffer_data, &arrayBuffer);
                memcpy(buffer_data, frameData->samples, dataSize);
                napi_set_named_property(env, audioInfo, "data", arrayBuffer);
                
                napi_value dataSizeVal;
                napi_create_double(env, (double)dataSize, &dataSizeVal);
                napi_set_named_property(env, audioInfo, "dataSize", dataSizeVal);
            }
            
            // Вызываем JavaScript callback
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &audioInfo, &result);
            
            // Очищаем память
            delete[] frameData->samples;
            delete frameData;
        },
        &g_audio_tsfn
    );
    
    napi_value result;
    napi_create_string_utf8(env, "WebRTC audio callback set", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Инициализация модуля
napi_value Init(napi_env env, napi_value exports) {
    // Базовые методы
    napi_property_descriptor desc[] = {
        {"testMethod", nullptr, TestMethod, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getAvailableSources", nullptr, GetAvailableSources, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startCapture", nullptr, StartCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopCapture", nullptr, StopCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureQuality", nullptr, SetCaptureQuality, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureSource", nullptr, SetCaptureSource, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCVideoCallback", nullptr, SetWebRTCVideoCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)