#include <node.h>
#include <uv.h>
#include <node_object_wrap.h>
#include <memory>
#include <vector>
#include <map>        // Добавьте этот include для std::map
#include <string>     // Добавьте для std::string
#include <chrono>     // Добавьте для std::chrono
#include <atomic>     // Добавьте для std::atomic
#include <string.h>  // Для memcpy
#include <stdlib.h>  // Для malloc/free
#include <math.h>  // Для fmod

// Include Foundation and other frameworks first
#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>

// Include the generated Swift header as Objective-C
#import "CaptureModule-Swift.h"

using namespace v8;

static CCaptureManager* g_manager = nullptr;

// Simple atomic counters
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

// Global callback storage for frame forwarding - ONLY DEFINE ONCE HERE
static v8::Persistent<v8::Function> g_video_callback;
static v8::Persistent<v8::Function> g_audio_callback;

// Структура для хранения информации о потоке
struct StreamInfo {
    std::string streamId;
    bool hasVideo;
    bool hasAudio;
    int width;
    int height;
    double frameRate;
    int sampleRate;
    int channels;
};

struct WorkData {
    uv_work_t request;
    Persistent<Promise::Resolver> resolver;
    Isolate* isolate;
    std::string operation;
    std::string message;
    std::string type;
    std::string id;
    bool success;
    NSError* error;
    NSDictionary* sourceDict;
    
    WorkData() : success(false), error(nil), sourceDict(nil) {
        request.data = this;
    }
    
    ~WorkData() {
        resolver.Reset();
        error = nil;
        sourceDict = nil;
    }
};

static std::map<std::string, StreamInfo> g_active_streams;


void WorkAsync(uv_work_t* req) {
    @autoreleasepool {
        WorkData* data = static_cast<WorkData*>(req->data);
        
        if (!g_manager) {
            g_manager = [[CCaptureManager alloc] init];
        }
        
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        
        if (data->operation == "setCaptureSource") {
            NSDictionary* source = @{
                @"type": [NSString stringWithUTF8String:data->type.c_str()],
                @"id": [NSString stringWithUTF8String:data->id.c_str()]
            };
            
            [g_manager setCaptureSource:source completion:^(NSError* error) {
                if (error) {
                    data->error = error;
                    data->success = false;
                } else {
                    data->success = true;
                    data->message = "Capture source set";
                }
                dispatch_semaphore_signal(semaphore);
            }];
            
        } else if (data->operation == "startCapture") {
            [g_manager startCaptureWithCompletion:^(NSError* error) {
                if (error) {
                    data->error = error;
                    data->success = false;
                } else {
                    data->success = true;
                    data->message = "Capture started";
                    g_capture_active.store(true);
                }
                dispatch_semaphore_signal(semaphore);
            }];
            
        } else if (data->operation == "stopCapture") {
            g_capture_active.store(false);
            [g_manager stopCaptureWithCompletion:^(NSError* error) {
                if (error) {
                    data->error = error;
                    data->success = false;
                } else {
                    data->success = true;
                    data->message = "Capture stopped";
                }
                dispatch_semaphore_signal(semaphore);
            }];
            
        } else if (data->operation == "selectSourceWithPicker") {
            if (@available(macOS 14.0, *)) {
                [g_manager selectSourceWithPickerWithCompletion:^(NSError* error, NSDictionary* source) {
                    if (error) {
                        data->error = error;
                        data->success = false;
                    } else {
                        data->success = true;
                        data->message = "Source selected";
                        if (source) {
                            data->sourceDict = source;
                        }
                    }
                    dispatch_semaphore_signal(semaphore);
                }];
            } else {
                data->success = false;
                data->message = "Screen sharing picker requires macOS 14.0 or later";
                dispatch_semaphore_signal(semaphore);
            }
        }
        
        dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    }
}

void WorkAsyncComplete(uv_work_t* req, int status) {
    std::unique_ptr<WorkData> data(static_cast<WorkData*>(req->data));
    
    Isolate* isolate = data->isolate;
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    Local<Promise::Resolver> resolver = Local<Promise::Resolver>::New(isolate, data->resolver);
    
    if (data->success && status == 0) {
        Local<Object> result = Object::New(isolate);
        result->Set(context,
            String::NewFromUtf8(isolate, "message").ToLocalChecked(),
            String::NewFromUtf8(isolate, data->message.c_str()).ToLocalChecked()).ToChecked();
        
        if (data->sourceDict) {
            NSString* type = data->sourceDict[@"type"];
            NSString* idStr = data->sourceDict[@"id"];
            if (type) {
                result->Set(context,
                    String::NewFromUtf8(isolate, "type").ToLocalChecked(),
                    String::NewFromUtf8(isolate, [type UTF8String]).ToLocalChecked()).ToChecked();
            }
            if (idStr) {
                result->Set(context,
                    String::NewFromUtf8(isolate, "id").ToLocalChecked(),
                    String::NewFromUtf8(isolate, [idStr UTF8String]).ToLocalChecked()).ToChecked();
            }
        }
        
        resolver->Resolve(context, result).ToChecked();
    } else {
        std::string errorMessage = data->message;
        if (data->error) {
            errorMessage = [[data->error localizedDescription] UTF8String];
        }
        resolver->Reject(context,
            String::NewFromUtf8(isolate, errorMessage.c_str()).ToLocalChecked()).ToChecked();
    }
}

void TestMethod(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    [g_manager testMethod];
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Test completed from Swift").ToLocalChecked());
}

void SetCaptureSource(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    if (args.Length() < 1 || !args[0]->IsObject()) {
        resolver->Reject(context, String::NewFromUtf8(isolate, "Invalid source object").ToLocalChecked()).ToChecked();
        return;
    }
    
    Local<Object> sourceObj = args[0]->ToObject(context).ToLocalChecked();
    Local<String> typeKey = String::NewFromUtf8(isolate, "type").ToLocalChecked();
    Local<String> idKey = String::NewFromUtf8(isolate, "id").ToLocalChecked();

    Local<Value> typeValue = sourceObj->Get(context, typeKey).ToLocalChecked();
    Local<Value> idValue = sourceObj->Get(context, idKey).ToLocalChecked();

    if (!typeValue->IsString() || !idValue->IsString()) {
        resolver->Reject(context, String::NewFromUtf8(isolate, "Type and id must be strings").ToLocalChecked()).ToChecked();
        return;
    }

    String::Utf8Value type(isolate, typeValue);
    String::Utf8Value id(isolate, idValue);
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "setCaptureSource";
    data->type = *type;
    data->id = *id;
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

void StartCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "startCapture";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

void StopCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "stopCapture";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

void SelectSourceWithPicker(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "selectSourceWithPicker";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

// Simple counter-based callbacks that just increment counters
// Замените текущую функцию SetWebRTCVideoCallback на эту полноценную версию:

void SetWebRTCVideoCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    NSLog(@"🎯 SetWebRTCVideoCallback called from JavaScript");
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Проверяем, что передана функция
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Сохраняем JavaScript callback
    Local<Function> callback = Local<Function>::Cast(args[0]);
    Persistent<Function>* persistentCallback = new Persistent<Function>(isolate, callback);
    
    // Устанавливаем Objective-C callback который будет вызывать JavaScript
    [g_manager setWebRTCVideoCallback:^(NSDictionary* frameData) {
        // Инкрементируем счетчик
        g_video_frame_count.fetch_add(1);
        
        NSLog(@"📹 Native video callback fired! Frame count: %llu", g_video_frame_count.load());
        
        // Извлекаем данные из словаря
        NSNumber* width = frameData[@"width"];
        NSNumber* height = frameData[@"height"];
        NSNumber* timestamp = frameData[@"timestamp"];
        NSNumber* pixelFormat = frameData[@"pixelFormat"];
        NSNumber* bytesPerRow = frameData[@"bytesPerRow"];
        NSNumber* dataSize = frameData[@"dataSize"];
        NSNumber* hasData = frameData[@"hasData"];
        
        // Для видео фреймов нужно получить пиксельные данные
        // В текущей реализации Swift только передает метаданные
        // Нужно будет расширить для передачи реальных данных
        
        uint64_t frameNumber = g_video_frame_count.load();
        
        // Вызываем JavaScript callback из главного потока
        dispatch_async(dispatch_get_main_queue(), ^{
            Isolate* isolate = Isolate::GetCurrent();
            if (!isolate) return;
            
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            // Получаем сохраненный callback
            Local<Function> jsCallback = Local<Function>::New(isolate, *persistentCallback);
            
            // Создаем объект с информацией о видео фрейме
            Local<Object> videoInfo = Object::New(isolate);
            
            if (width) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "width").ToLocalChecked(),
                    Number::New(isolate, [width intValue])).ToChecked();
            }
            if (height) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "height").ToLocalChecked(),
                    Number::New(isolate, [height intValue])).ToChecked();
            }
            if (timestamp) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                    Number::New(isolate, [timestamp doubleValue])).ToChecked();
            }
            if (pixelFormat) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "pixelFormat").ToLocalChecked(),
                    Number::New(isolate, [pixelFormat intValue])).ToChecked();
                
                // Добавляем читаемое название формата
                const char* formatName = "unknown";
                uint32_t format = [pixelFormat unsignedIntValue];
                if (format == kCVPixelFormatType_32BGRA) {
                    formatName = "BGRA";
                } else if (format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
                    formatName = "YUV420";
                }
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "pixelFormatName").ToLocalChecked(),
                    String::NewFromUtf8(isolate, formatName).ToLocalChecked()).ToChecked();
            }
            if (bytesPerRow) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "bytesPerRow").ToLocalChecked(),
                    Number::New(isolate, [bytesPerRow intValue])).ToChecked();
            }
            if (dataSize) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "dataSize").ToLocalChecked(),
                    Number::New(isolate, [dataSize intValue])).ToChecked();
            }
            if (hasData) {
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "hasData").ToLocalChecked(),
                    v8::Boolean::New(isolate, [hasData boolValue])).ToChecked();
            }
            
            // Добавляем номер фрейма
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                Number::New(isolate, static_cast<double>(frameNumber))).ToChecked();
            
            // Добавляем FPS информацию
            static double lastTimestamp = 0;
            if (timestamp && lastTimestamp > 0) {
                double timeDiff = [timestamp doubleValue] - lastTimestamp;
                double fps = timeDiff > 0 ? 1.0 / timeDiff : 0;
                videoInfo->Set(context,
                    String::NewFromUtf8(isolate, "fps").ToLocalChecked(),
                    Number::New(isolate, fps)).ToChecked();
            }
            if (timestamp) {
                lastTimestamp = [timestamp doubleValue];
            }
            
            // TODO: Добавить передачу реальных пиксельных данных
            // Для этого нужно обновить Swift код чтобы передавать CVPixelBuffer
            
            // Вызываем JavaScript callback
            Local<Value> argv[] = { videoInfo };
            
            v8::TryCatch try_catch(isolate);
            MaybeLocal<Value> result = jsCallback->Call(context, Null(isolate), 1, argv);
            
            if (try_catch.HasCaught()) {
                // Логируем ошибку но не крашимся
                String::Utf8Value error(isolate, try_catch.Exception());
                NSLog(@"Error in video callback: %s", *error);
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC video callback set").ToLocalChecked());
}

// Вспомогательная функция для создания пустого буфера правильного размера
Local<ArrayBuffer> CreateAudioBuffer(Isolate* isolate, const AudioStreamBasicDescription& asbd, long numSamples) {
    // Рассчитываем размер буфера
    size_t bytesPerFrame = asbd.mBytesPerFrame;
    if (bytesPerFrame == 0) {
        // Если mBytesPerFrame не установлен, рассчитываем сами
        bytesPerFrame = (asbd.mBitsPerChannel / 8) * asbd.mChannelsPerFrame;
    }
    
    size_t totalBytes = numSamples * bytesPerFrame;
    
    NSLog(@"🎵 Creating audio buffer: %ld samples, %zu bytes per frame, %zu total bytes", 
          numSamples, bytesPerFrame, totalBytes);
    
    return ArrayBuffer::New(isolate, totalBytes);
}

// Полная функция SetWebRTCAudioCallback
void SetWebRTCAudioCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    NSLog(@"🎯 SetWebRTCAudioCallback called from JavaScript");
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Проверяем, что передана функция
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Сохраняем JavaScript callback
    Local<Function> callback = Local<Function>::Cast(args[0]);
    Persistent<Function>* persistentCallback = new Persistent<Function>(isolate, callback);
    
    // Устанавливаем Objective-C callback который будет вызывать JavaScript
    [g_manager setWebRTCAudioCallback:^(CMSampleBufferRef sampleBuffer) {
        // Инкрементируем счетчик
        g_audio_frame_count.fetch_add(1);
        
        // Получаем данные о формате ДО dispatch_async
        CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
        AudioStreamBasicDescription asbd = {0};
        bool hasFormat = false;
        
        if (formatDesc) {
            const AudioStreamBasicDescription* asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
            if (asbdPtr) {
                asbd = *asbdPtr;
                hasFormat = true;
            }
        }
        
        // Получаем данные ДО dispatch_async
        long numSamples = CMSampleBufferGetNumSamples(sampleBuffer);
        uint64_t frameNumber = g_audio_frame_count.load();
        
        // Проверяем наличие блока данных
        CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
        bool hasBlockBuffer = (blockBuffer != nullptr);
        
        // КРИТИЧНО: Определяем источник более надежно
        // SCStream (системный звук) имеет временные метки кратные 0.02 (50 FPS)
        // Микрофон имеет более случайные временные метки
        CMTime presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
        double timestamp = CMTimeGetSeconds(presentationTime);
        
        // Анализируем паттерн временных меток
        double timeValue = timestamp * 1000.0; // Переводим в миллисекунды
        double remainder = fmod(timeValue, 20.0); // Проверяем кратность 20ms
        
        // SCStream обычно выдает фреймы каждые 20ms (0.02s)
        bool isSystemAudio = (remainder < 1.0 || remainder > 19.0);
        
        // Дополнительная проверка: размер данных
        // Системный звук часто имеет размер 7680 байт (960 сэмплов * 2 канала * 4 байта)
        // Микрофон чаще имеет размер 2048 байт
        size_t dataSize = 0;
        if (blockBuffer) {
            size_t lengthAtOffset = 0;
            size_t totalLength = 0;
            
            OSStatus status = CMBlockBufferGetDataPointer(
                blockBuffer,
                0,
                &lengthAtOffset,
                &totalLength,
                nullptr
            );
            
            if (status == noErr) {
                dataSize = totalLength;
            }
        }
        
        // Уточняем определение источника по размеру
        if (dataSize == 7680) {
            isSystemAudio = true;
        } else if (dataSize == 2048) {
            isSystemAudio = false;
        }
        
        const char* sourceType = isSystemAudio ? "system" : "microphone";
        
        NSLog(@"🎵 Audio callback: frame %llu, time: %.6f, remainder: %.2f, size: %zu, source: %s", 
              g_audio_frame_count.load(), 
              timestamp,
              remainder,
              dataSize,
              sourceType);
        
        // Пытаемся извлечь данные сразу
        void* audioDataPtr = nullptr;
        size_t audioDataSize = 0;
        
        if (blockBuffer && dataSize > 0) {
            // Есть CMBlockBuffer - извлекаем данные
            size_t lengthAtOffset = 0;
            size_t totalLength = 0;
            char* dataPointer = nullptr;
            
            OSStatus status = CMBlockBufferGetDataPointer(
                blockBuffer,
                0,
                &lengthAtOffset,
                &totalLength,
                &dataPointer
            );
            
            if (status == noErr && dataPointer && totalLength > 0) {
                audioDataPtr = malloc(totalLength);
                memcpy(audioDataPtr, dataPointer, totalLength);
                audioDataSize = totalLength;
                NSLog(@"🎵 Copied audio data from %s: %zu bytes", sourceType, totalLength);
            }
        } else if (hasFormat && numSamples > 0) {
            // Нет CMBlockBuffer - создаем буфер с тишиной для системного звука
            size_t bytesPerFrame = asbd.mBytesPerFrame;
            if (bytesPerFrame == 0) {
                bytesPerFrame = (asbd.mBitsPerChannel / 8) * asbd.mChannelsPerFrame;
            }
            
            audioDataSize = numSamples * bytesPerFrame;
            audioDataPtr = calloc(1, audioDataSize); // calloc инициализирует нулями
            NSLog(@"🎵 Created silent buffer for %s: %ld samples, %zu bytes", 
                  sourceType, numSamples, audioDataSize);
        }
        
        // Сохраняем определенный источник для использования в dispatch_async
        bool isMicrophoneSource = !isSystemAudio;
        
        // Вызываем JavaScript callback из главного потока
        dispatch_async(dispatch_get_main_queue(), ^{
            Isolate* isolate = Isolate::GetCurrent();
            if (!isolate) {
                if (audioDataPtr) free(audioDataPtr);
                return;
            }
            
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            // Получаем сохраненный callback
            Local<Function> jsCallback = Local<Function>::New(isolate, *persistentCallback);
            
            // Создаем объект с информацией об аудио
            Local<Object> audioInfo = Object::New(isolate);
            
            // Добавляем информацию о формате если есть
            if (hasFormat) {
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
                    Number::New(isolate, asbd.mSampleRate)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
                    Number::New(isolate, asbd.mChannelsPerFrame)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "bitsPerChannel").ToLocalChecked(),
                    Number::New(isolate, asbd.mBitsPerChannel)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "formatID").ToLocalChecked(),
                    Number::New(isolate, asbd.mFormatID)).ToChecked();
            }
            
            // Добавляем основные данные
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                Number::New(isolate, timestamp)).ToChecked();
            
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "numSamples").ToLocalChecked(),
                Number::New(isolate, numSamples)).ToChecked();
            
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                Number::New(isolate, static_cast<double>(frameNumber))).ToChecked();
            
            // Добавляем аудио данные если есть
            if (audioDataPtr && audioDataSize > 0) {
                // Создаем ArrayBuffer и копируем данные
                Local<ArrayBuffer> arrayBuffer = ArrayBuffer::New(isolate, audioDataSize);
                void* bufferData = arrayBuffer->GetBackingStore()->Data();
                memcpy(bufferData, audioDataPtr, audioDataSize);
                
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "data").ToLocalChecked(),
                    arrayBuffer).ToChecked();
                
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "dataSize").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(audioDataSize))).ToChecked();
                
                // Указываем источник на основе анализа
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "source").ToLocalChecked(),
                    String::NewFromUtf8(isolate, isMicrophoneSource ? "microphone" : "system").ToLocalChecked()).ToChecked();
                
                // Добавляем дополнительную информацию для отладки
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "hasBlockBuffer").ToLocalChecked(),
                    v8::Boolean::New(isolate, hasBlockBuffer)).ToChecked();
            }
            
            // Освобождаем память
            if (audioDataPtr) {
                free(audioDataPtr);
            }
            
            // Вызываем JavaScript callback
            Local<Value> argv[] = { audioInfo };
            
            v8::TryCatch try_catch(isolate);
            MaybeLocal<Value> result = jsCallback->Call(context, Null(isolate), 1, argv);
            
            if (try_catch.HasCaught()) {
                // Логируем ошибку но не крашимся
                String::Utf8Value error(isolate, try_catch.Exception());
                NSLog(@"Error in audio callback: %s", *error);
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC audio callback set").ToLocalChecked());
}

// Method to get current frame counts
void GetFrameStats(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    Local<Object> stats = Object::New(isolate);
    stats->Set(context,
        String::NewFromUtf8(isolate, "videoFrames").ToLocalChecked(),
        Number::New(isolate, static_cast<double>(g_video_frame_count.load()))).ToChecked();
    stats->Set(context,
        String::NewFromUtf8(isolate, "audioFrames").ToLocalChecked(),
        Number::New(isolate, static_cast<double>(g_audio_frame_count.load()))).ToChecked();
    stats->Set(context,
        String::NewFromUtf8(isolate, "isActive").ToLocalChecked(),
        v8::Boolean::New(isolate, g_capture_active.load())).ToChecked();
    
    args.GetReturnValue().Set(stats);
}

// Function to forward video frames to Electron
// Replace the problematic ForwardVideoFrame and ForwardAudioFrame functions in your webrtc_wrapper.mm
// Fix the V8 API calls

void ForwardVideoFrame(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Store the callback
    g_video_callback.Reset(isolate, args[0].As<Function>());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up WebRTC video callback that forwards to JavaScript
    [g_manager setWebRTCVideoCallback:^(NSDictionary* frameData) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!g_video_callback.IsEmpty()) {
                Isolate* isolate = Isolate::GetCurrent();
                if (!isolate) return;
                
                HandleScope scope(isolate);
                Local<Context> context = isolate->GetCurrentContext();
                
                // Create JavaScript object from frame data
                Local<Object> jsFrameData = Object::New(isolate);
                
                NSNumber* width = frameData[@"width"];
                NSNumber* height = frameData[@"height"];
                NSNumber* timestamp = frameData[@"timestamp"];
                
                if (width) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "width").ToLocalChecked(),
                        Number::New(isolate, [width doubleValue])).ToChecked();
                }
                if (height) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "height").ToLocalChecked(),
                        Number::New(isolate, [height doubleValue])).ToChecked();
                }
                if (timestamp) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                        Number::New(isolate, [timestamp doubleValue])).ToChecked();
                }
                
                // Add frame counter
                g_video_frame_count.fetch_add(1);
                jsFrameData->Set(context,
                    String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(g_video_frame_count.load()))).ToChecked();
                
                // Call the JavaScript callback
                Local<Function> callback = Local<Function>::New(isolate, g_video_callback);
                Local<Value> argv[] = { jsFrameData };
                
                v8::TryCatch try_catch(isolate);
                MaybeLocal<Value> result = callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught() || result.IsEmpty()) {
                    // Silently ignore callback errors to prevent crashes
                }
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Video frame forwarding enabled").ToLocalChecked());
}

// Function to forward audio frames to Electron
void ForwardAudioFrame(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    NSLog(@"🎯 ForwardAudioFrame called from JavaScript");
    
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Store the callback
    g_audio_callback.Reset(isolate, args[0].As<Function>());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up WebRTC audio callback that forwards to JavaScript
    [g_manager setWebRTCAudioCallback:^(CMSampleBufferRef sampleBuffer) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!g_audio_callback.IsEmpty()) {
                Isolate* isolate = Isolate::GetCurrent();
                if (!isolate) return;
                
                HandleScope scope(isolate);
                Local<Context> context = isolate->GetCurrentContext();
                
                // Create JavaScript object from audio data
                Local<Object> jsAudioData = Object::New(isolate);
                
                // Get audio format info
                CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
                if (formatDesc) {
                    const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
                    if (asbd) {
                        jsAudioData->Set(context,
                            String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
                            Number::New(isolate, asbd->mSampleRate)).ToChecked();
                        jsAudioData->Set(context,
                            String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
                            Number::New(isolate, asbd->mChannelsPerFrame)).ToChecked();
                    }
                }
                
                // Add timestamp
                CMTime presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
                double timestamp = CMTimeGetSeconds(presentationTime) * 1000.0; // Convert to milliseconds
                jsAudioData->Set(context,
                    String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                    Number::New(isolate, timestamp)).ToChecked();
                
                // Add frame counter
                g_audio_frame_count.fetch_add(1);
                jsAudioData->Set(context,
                    String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(g_audio_frame_count.load()))).ToChecked();
                
                // Call the JavaScript callback
                Local<Function> callback = Local<Function>::New(isolate, g_audio_callback);
                Local<Value> argv[] = { jsAudioData };
                
                v8::TryCatch try_catch(isolate);
                MaybeLocal<Value> result = callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught() || result.IsEmpty()) {
                    // Silently ignore callback errors to prevent crashes
                }
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Audio frame forwarding enabled").ToLocalChecked());
}

void GetAvailableSources(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    // Создаем WorkData для асинхронной операции
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "getAvailableSources";
    
    uv_queue_work(uv_default_loop(), &data->request, 
        // Функция выполнения в рабочем потоке
        [](uv_work_t* req) {
            @autoreleasepool {
                WorkData* data = static_cast<WorkData*>(req->data);
                
                if (!g_manager) {
                    g_manager = [[CCaptureManager alloc] init];
                }
                
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                __block NSArray<NSDictionary*>* sources = nil;
                __block NSError* error = nil;
                
                [g_manager getAvailableSourcesWithCompletion:^(NSError* err, NSArray<NSDictionary*>* sourcesArray) {
                    error = err;
                    sources = sourcesArray;
                    dispatch_semaphore_signal(semaphore);
                }];
                
                dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
                
                if (error) {
                    data->error = error;
                    data->success = false;
                } else if (sources) {
                    // Сохраняем источники в формате, который можем передать обратно
                    data->success = true;
                    data->sourceDict = @{@"sources": sources};
                }
            }
        },
        // Функция завершения в главном потоке
        [](uv_work_t* req, int status) {
            std::unique_ptr<WorkData> data(static_cast<WorkData*>(req->data));
            
            Isolate* isolate = data->isolate;
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            Local<Promise::Resolver> resolver = Local<Promise::Resolver>::New(isolate, data->resolver);
            
            if (data->success && status == 0) {
                NSArray<NSDictionary*>* sources = data->sourceDict[@"sources"];
                
                if (sources) {
                    // Конвертируем NSArray в JavaScript массив
                    Local<Array> jsArray = Array::New(isolate, (int)sources.count);
                    
                    for (NSUInteger i = 0; i < sources.count; i++) {
                        NSDictionary* source = sources[i];
                        Local<Object> jsSource = Object::New(isolate);
                        
                        // Конвертируем все поля из словаря
                        for (NSString* key in source) {
                            id value = source[key];
                            Local<String> jsKey = String::NewFromUtf8(isolate, [key UTF8String]).ToLocalChecked();
                            
                            if ([value isKindOfClass:[NSString class]]) {
                                jsSource->Set(context, jsKey,
                                    String::NewFromUtf8(isolate, [(NSString*)value UTF8String]).ToLocalChecked()).ToChecked();
                            } else if ([value isKindOfClass:[NSNumber class]]) {
                                jsSource->Set(context, jsKey,
                                    Number::New(isolate, [(NSNumber*)value doubleValue])).ToChecked();
                            }
                        }
                        
                        jsArray->Set(context, i, jsSource).ToChecked();
                    }
                    
                    resolver->Resolve(context, jsArray).ToChecked();
                } else {
                    resolver->Resolve(context, Array::New(isolate, 0)).ToChecked();
                }
            } else {
                std::string errorMessage = "Failed to get sources";
                if (data->error) {
                    errorMessage = [[data->error localizedDescription] UTF8String];
                }
                resolver->Reject(context,
                    String::NewFromUtf8(isolate, errorMessage.c_str()).ToLocalChecked()).ToChecked();
            }
        }
    );
}

// Функция для создания виртуального MediaStream ID
void CreateVirtualStream(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    if (args.Length() < 1 || !args[0]->IsObject()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected stream configuration object").ToLocalChecked()));
        return;
    }
    
    Local<Object> config = args[0]->ToObject(context).ToLocalChecked();
    
    // Генерируем уникальный ID для потока
    auto now = std::chrono::system_clock::now();
    auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    std::string streamId = "native-stream-" + std::to_string(timestamp);
    
    StreamInfo info;
    info.streamId = streamId;
    
    // Получаем параметры видео
    Local<Value> hasVideoVal = config->Get(context, String::NewFromUtf8(isolate, "hasVideo").ToLocalChecked()).ToLocalChecked();
    info.hasVideo = hasVideoVal->BooleanValue(isolate);
    
    if (info.hasVideo) {
        info.width = config->Get(context, String::NewFromUtf8(isolate, "width").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.height = config->Get(context, String::NewFromUtf8(isolate, "height").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.frameRate = config->Get(context, String::NewFromUtf8(isolate, "frameRate").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
    }
    
    // Получаем параметры аудио
    Local<Value> hasAudioVal = config->Get(context, String::NewFromUtf8(isolate, "hasAudio").ToLocalChecked()).ToLocalChecked();
    info.hasAudio = hasAudioVal->BooleanValue(isolate);
    
    if (info.hasAudio) {
        info.sampleRate = config->Get(context, String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.channels = config->Get(context, String::NewFromUtf8(isolate, "channels").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
    }
    
    // Сохраняем информацию о потоке
    g_active_streams[streamId] = info;
    
    // Настраиваем прямые callbacks для этого потока
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Возвращаем ID потока
    Local<Object> result = Object::New(isolate);
    result->Set(context,
        String::NewFromUtf8(isolate, "streamId").ToLocalChecked(),
        String::NewFromUtf8(isolate, streamId.c_str()).ToLocalChecked()).ToChecked();
    result->Set(context,
        String::NewFromUtf8(isolate, "hasVideo").ToLocalChecked(),
        v8::Boolean::New(isolate, info.hasVideo)).ToChecked();  // Используем v8::Boolean
    result->Set(context,
        String::NewFromUtf8(isolate, "hasAudio").ToLocalChecked(),
        v8::Boolean::New(isolate, info.hasAudio)).ToChecked();  // Используем v8::Boolean
    
    args.GetReturnValue().Set(result);
}

// Функция для получения видео фрейма в формате, пригодном для WebRTC
void GetVideoFrameData(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    // Эта функция будет вызываться из JavaScript для получения последнего видео фрейма
    // В реальной реализации здесь нужно будет:
    // 1. Получить CVImageBuffer из последнего фрейма
    // 2. Конвертировать в RGB/YUV формат
    // 3. Передать как ArrayBuffer в JavaScript
    
    Local<Object> frameInfo = Object::New(isolate);
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
        Number::New(isolate, g_video_frame_count.load())).ToChecked();
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "width").ToLocalChecked(),
        Number::New(isolate, 1920)).ToChecked(); // Заглушка
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "height").ToLocalChecked(),
        Number::New(isolate, 1080)).ToChecked(); // Заглушка
    
    args.GetReturnValue().Set(frameInfo);
}

// Функция для получения аудио данных в формате PCM
void GetAudioFrameData(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    // Эта функция будет вызываться из JavaScript для получения аудио данных
    // В реальной реализации здесь нужно будет:
    // 1. Получить CMSampleBuffer из последнего аудио фрейма
    // 2. Извлечь PCM данные
    // 3. Передать как Float32Array в JavaScript
    
    Local<Object> audioInfo = Object::New(isolate);
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
        Number::New(isolate, g_audio_frame_count.load())).ToChecked();
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
        Number::New(isolate, 48000)).ToChecked();
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
        Number::New(isolate, 2)).ToChecked();
    
    args.GetReturnValue().Set(audioInfo);
}

// Update your Init function to export the new methods
void Init(Local<Object> exports, Local<Value> module, void* context) {
    NODE_SET_METHOD(exports, "testMethod", TestMethod);
    NODE_SET_METHOD(exports, "selectSourceWithPicker", SelectSourceWithPicker);
    NODE_SET_METHOD(exports, "setCaptureSource", SetCaptureSource);
    NODE_SET_METHOD(exports, "startCapture", StartCapture);
    NODE_SET_METHOD(exports, "stopCapture", StopCapture);
    NODE_SET_METHOD(exports, "setWebRTCVideoCallback", SetWebRTCVideoCallback);
    NODE_SET_METHOD(exports, "setWebRTCAudioCallback", SetWebRTCAudioCallback);
    NODE_SET_METHOD(exports, "getFrameStats", GetFrameStats);
    
    // Add the new frame forwarding methods
    NODE_SET_METHOD(exports, "forwardVideoFrame", ForwardVideoFrame);
    NODE_SET_METHOD(exports, "forwardAudioFrame", ForwardAudioFrame);

    NODE_SET_METHOD(exports, "getAvailableSources", GetAvailableSources);

    // Новые методы для MediaStream
    NODE_SET_METHOD(exports, "createVirtualStream", CreateVirtualStream);
    NODE_SET_METHOD(exports, "getVideoFrameData", GetVideoFrameData);
    NODE_SET_METHOD(exports, "getAudioFrameData", GetAudioFrameData);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
