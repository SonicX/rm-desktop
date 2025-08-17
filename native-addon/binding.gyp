{
  "targets": [
    {
      "target_name": "screen_capture_webrtc",
      "sources": [
        "<!@(ls -1 src/*.mm 2>/dev/null || ls -1 *.mm)",
        "<!@(ls -1 src/*.swift 2>/dev/null || ls -1 *.swift)"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        ".",
        "src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ['OS=="mac"', {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CFLAGS": [
              "-fobjc-arc",
              "-Wno-deprecated-declarations"
            ],
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++20",
              "-fobjc-arc",
              "-Wno-deprecated-declarations"
            ],
            "OTHER_SWIFT_FLAGS": [
              "-module-name", "CaptureModule",
              "-emit-module",
              "-emit-objc-header"
            ]
          },
          "link_settings": {
            "libraries": [
              "-framework Foundation",
              "-framework CoreMedia", 
              "-framework AVFoundation",
              "-framework ScreenCaptureKit",
              "-framework CoreVideo",
              "-framework AppKit"
            ]
          }
        }]
      ]
    }
  ]
}