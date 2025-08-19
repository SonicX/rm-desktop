{
  "targets": [{
    "target_name": "capture",
    "sources": ["src/main.cpp"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "conditions": [
      ["OS=='win'", {
        "libraries": [
          "-ld3d11.lib",
          "-ldxgi.lib", 
          "-lole32.lib",
          "-luser32.lib",
          "-ldwmapi.lib",
          "-lpsapi.lib",
          "-lwinmm.lib"
        ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1,
            "AdditionalOptions": ["/std:c++17"]
          }
        }
      }]
    ],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"]
  }]
}