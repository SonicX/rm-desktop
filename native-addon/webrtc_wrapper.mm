// Here's how your webrtc_wrapper.mm should be structured:

#include <node.h>
#include <uv.h>
#include <node_object_wrap.h>

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
void SetWebRTCVideoCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up a simple counter callback - no V8 callbacks
    [g_manager setWebRTCVideoCallback:^(NSDictionary* frameData) {
        g_video_frame_count.fetch_add(1);
        // No JavaScript callback - just count frames
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC video counter set").ToLocalChecked());
}

void SetWebRTCAudioCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up a simple counter callback - no V8 callbacks
    [g_manager setWebRTCAudioCallback:^(CMSampleBufferRef sampleBuffer) {
        g_audio_frame_count.fetch_add(1);
        // No JavaScript callback - just count frames
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC audio counter set").ToLocalChecked());
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
                callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught()) {
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
                callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught()) {
                    // Silently ignore callback errors to prevent crashes
                }
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Audio frame forwarding enabled").ToLocalChecked());
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
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
