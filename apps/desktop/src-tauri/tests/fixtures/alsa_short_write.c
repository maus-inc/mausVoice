/* Test-only ALSA playback faults for a single isolated null stream. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

static atomic_ulong calls;
static atomic_ulong completed;
static atomic_int mismatch;
static unsigned char *original_buffer;
static unsigned long total_frames;
static unsigned long written_frames;

unsigned long maus_test_write_calls(void) { return atomic_load(&calls); }
unsigned long maus_test_write_completed(void) { return atomic_load(&completed); }
int maus_test_write_mismatch(void) { return atomic_load(&mismatch); }

long snd_pcm_writei(void *pcm, const void *buffer, unsigned long frames) {
    unsigned long call = atomic_fetch_add(&calls, 1);
    if (getenv("MAUS_TEST_WRITE_ALWAYS_EAGAIN")) return -EAGAIN;
    if (getenv("MAUS_TEST_WRITE_FATAL")) return -EINVAL;
    if (call == 0) return -EAGAIN;
    if (call == 1) return -EINTR;
    if (call == 2) return 0;
    if (atomic_load(&completed)) return -EAGAIN;

    if (!original_buffer) {
        if (frames < 2 || frames > 1000000) {
            atomic_store(&mismatch, 1);
            return -EIO;
        }
        total_frames = frames;
        original_buffer = malloc(frames * sizeof(float));
        if (!original_buffer) return -ENOMEM;
        memcpy(original_buffer, buffer, frames * sizeof(float));
    }
    if (frames > total_frames - written_frames ||
        memcmp(buffer, original_buffer + written_frames * sizeof(float),
               frames * sizeof(float)) != 0) {
        atomic_store(&mismatch, 1);
        return -EIO;
    }
    if (getenv("MAUS_TEST_WRITE_XRUN") && call == 4) return -EPIPE;
    long (*original)(void *, const void *, unsigned long) =
        (long (*)(void *, const void *, unsigned long))dlsym(RTLD_NEXT, "snd_pcm_writei");
    unsigned long limit = written_frames == 0 ? frames / 2 : frames;
    long result = original(pcm, buffer, limit);
    if (result > 0) written_frames += (unsigned long)result;
    if (written_frames == total_frames) atomic_store(&completed, 1);
    return result;
}
