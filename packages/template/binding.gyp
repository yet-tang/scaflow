{
  "targets": [
    {
      "target_name": "scaflow_template_native",
      "sources": ["native/template_native.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
      },
      "conditions": [
        ["OS == 'linux'", {
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
