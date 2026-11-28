# Disable -march=native so the binary runs on any x86-64 CPU, not just the CI runner's.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

# GGML_NATIVE=OFF does not select a portable baseline on its own: ggml then
# enables SSE4.2, AVX, AVX2, BMI2, FMA and F16C by default, and this static
# build has no runtime dispatch between instruction-set variants. A binary
# built that way executes AVX2 in the first quantized kernel it reaches and
# faults with an illegal instruction on pre-Haswell CPUs, which the desktop
# can only observe as a sidecar that vanished mid-request. Pin the shipped
# baseline to AVX (Intel Sandy Bridge / AMD Bulldozer, 2011 and later) and
# leave every wider extension off so the same binary runs on any supported
# CPU. src/cpu_requirements.rs checks the AVX requirement at startup.
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
