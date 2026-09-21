cmake_minimum_required(VERSION 3.18)
project(yolo8 LANGUAGES C CXX)

set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

set(NCNN_PATH /tmp/opencode/ncnn)
set(NCNN_VULKAN OFF CACHE BOOL "" FORCE)
set(NCNN_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(NCNN_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(NCNN_BUILD_BENCHMARK OFF CACHE BOOL "" FORCE)
set(NCNN_PYTHON OFF CACHE BOOL "" FORCE)
set(NCNN_SHARED_LIB OFF CACHE BOOL "" FORCE)

add_subdirectory(${NCNN_PATH} ncnn)

add_library(yolo8 SHARED yolo_jni.cpp license.cpp)
target_link_libraries(yolo8 ncnn jnigraphics log android)
target_compile_options(yolo8 PRIVATE -static-libstdc++)
target_link_options(yolo8 PRIVATE -static-libstdc++)
