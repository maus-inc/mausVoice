# Keep ggml on a conservative ARM baseline for CI stability on GitHub macOS runners.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod" CACHE STRING "" FORCE)

# The macos-15 runners ship CMake 4.x, which no longer picks the deployment
# target up from the environment the way the macos-14 image's CMake did, so
# sherpa-onnx's C++ objects came out built for the SDK default (13.4) while the
# final link used the workflow's 13.3 floor. Force the workflow's target so
# every object and the link agree.
if(DEFINED ENV{MACOSX_DEPLOYMENT_TARGET})
  set(CMAKE_OSX_DEPLOYMENT_TARGET "$ENV{MACOSX_DEPLOYMENT_TARGET}" CACHE STRING "Minimum macOS deployment target" FORCE)
endif()
