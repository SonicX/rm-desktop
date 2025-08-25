cmake_minimum_required(VERSION 3.10)
project(capture)

set(CMAKE_CXX_STANDARD 17)

# Node.js headers
include_directories(${CMAKE_JS_INC})

# Windows SDK paths для Zig
if(WIN32)
    link_libraries(
        d3d11
        dxgi
        ole32
        user32
    )
endif()

# Source files
add_library(${PROJECT_NAME} SHARED
    src/main.cpp
)

# Node.js linking
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# Export для Node.js
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")