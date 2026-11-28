# Disable native CPU detection so the binary runs on any x86-64 CPU, not just the CI runner's.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

# GGML_NATIVE=OFF does not select a portable baseline on its own: ggml then
# enables SSE4.2, AVX, AVX2, BMI2, FMA and F16C by default, and MSVC turns
# AVX2 into /arch:AVX2 plus the GGML_AVX2/GGML_FMA/GGML_F16C defines for the
# whole ggml-cpu target. This static build has no runtime dispatch between
# instruction-set variants, so a release binary built that way executes AVX2
# in the first quantized kernel it reaches and dies on pre-Haswell CPUs with
# the Windows exception code 0xC000001D. Pin the shipped baseline to AVX, the
# level Intel Sandy Bridge and AMD Bulldozer introduced in 2011, and leave
# every wider extension off so the same binary runs on any supported CPU. A few
# entry-level parts of that generation shipped with AVX disabled, so
# src/cpu_requirements.rs checks the feature at startup rather than trusting the
# level.
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
