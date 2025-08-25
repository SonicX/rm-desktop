{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ ],
      "conditions": [
        ['OS=="mac"', {
          "sources": [
            "src/webrtc_wrapper.mm",
            "src/ScreenCaptureManager.swift"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CFLAGS": [
              "-fobjc-arc"
            ],
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++20",
              "-fobjc-arc",
              "-stdlib=libc++",
              "-I/usr/local/include",
              "-I/opt/homebrew/include"
            ]
          },
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "/usr/local/include/node",
            "/opt/homebrew/include/node",
            "."
          ],
          "libraries": [
            "-framework Foundation",
            "-framework CoreMedia",
            "-framework AVFoundation", 
            "-framework ScreenCaptureKit",
            "-framework CoreVideo",
            "-framework AppKit"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "NODE_MODULE_VERSION=128"
          ]
        }]
      ]
    }
  ]
}
