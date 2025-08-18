#define NAPI_VERSION 8
#include <node.h>
#include <v8.h>

// Forward declaration
extern "C" void Init(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, void* context);

// Wrapper function
static void InitWrapper(v8::Local<v8::Object> exports,
                        v8::Local<v8::Value> module,
                        v8::Local<v8::Context> context) {
    void* priv = nullptr;
    Init(exports, module, priv);
}

// CRITICAL: Define module with ABI 128
#define NODE_MODULE_VERSION 128

// Registration method 1: NODE_MODULE_CONTEXT_AWARE
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitWrapper)

// Registration method 2: Direct export
extern "C" {
    __attribute__((visibility("default")))
    void _register_screen_capture_webrtc() {
        // This will be called by Node/Electron
    }
    
    __attribute__((visibility("default")))
    void node_module_register(void* mod) {
        // Direct registration
    }
}

// Registration method 3: NAPI style
#ifdef NAPI_MODULE
NAPI_MODULE(screen_capture_webrtc, Init)
#endif
