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

// Simple atomic counters - no callbacks to crash
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

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

void Init(Local<Object> exports, Local<Value> module, void* context) {
    NODE_SET_METHOD(exports, "testMethod", TestMethod);
    NODE_SET_METHOD(exports, "selectSourceWithPicker", SelectSourceWithPicker);
    NODE_SET_METHOD(exports, "setCaptureSource", SetCaptureSource);
    NODE_SET_METHOD(exports, "startCapture", StartCapture);
    NODE_SET_METHOD(exports, "stopCapture", StopCapture);
    NODE_SET_METHOD(exports, "setWebRTCVideoCallback", SetWebRTCVideoCallback);
    NODE_SET_METHOD(exports, "setWebRTCAudioCallback", SetWebRTCAudioCallback);
    NODE_SET_METHOD(exports, "getFrameStats", GetFrameStats);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
