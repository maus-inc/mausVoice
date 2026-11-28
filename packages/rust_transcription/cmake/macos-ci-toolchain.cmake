# Keep ggml on a conservative ARM baseline for CI stability on GitHub macOS runners.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod" CACHE STRING "" FORCE)

# The x86_64 half of the universal build needs its own baseline. With
# GGML_NATIVE=OFF, ggml enables SSE4.2, AVX, AVX2, BMI2, FMA and F16C by
# default, and this static build has no runtime dispatch between
# instruction-set variants, so an x86_64 binary built that way faults with an
# illegal instruction on pre-Haswell Macs, which covers the 2011 through 2013
# models. Pin the shipped x86_64 baseline to AVX and leave every wider
# extension off. The ARM values above are unaffected. src/cpu_requirements.rs
# checks AVX at startup.
set(GGML_AVX2 OFF CACHE BOOL "" FORCE)
set(GGML_AVX_VNNI OFF CACHE BOOL "" FORCE)
set(GGML_BMI2 OFF CACHE BOOL "" FORCE)
set(GGML_FMA OFF CACHE BOOL "" FORCE)
set(GGML_F16C OFF CACHE BOOL "" FORCE)
set(GGML_AVX512 OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_VBMI OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_VNNI OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_BF16 OFF CACHE BOOL "" FORCE)
set(GGML_AMX_TILE OFF CACHE BOOL "" FORCE)
set(GGML_AMX_INT8 OFF CACHE BOOL "" FORCE)
set(GGML_AMX_BF16 OFF CACHE BOOL "" FORCE)

# The macos-15 runners ship CMake 4.x, which no longer picks the deployment
# target up from the environment the way the macos-14 image's CMake did, so
# sherpa-onnx's C++ objects came out built for the SDK default (13.4) while the
# final link used the workflow's 13.3 floor. Force the workflow's target so
# every object and the link agree.
if(DEFINED ENV{MACOSX_DEPLOYMENT_TARGET})
  set(CMAKE_OSX_DEPLOYMENT_TARGET "$ENV{MACOSX_DEPLOYMENT_TARGET}" CACHE STRING "Minimum macOS deployment target" FORCE)
endif()
