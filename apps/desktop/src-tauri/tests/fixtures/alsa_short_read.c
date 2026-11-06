/* Test-only ALSA fault injection for an isolated null capture device. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

static atomic_ulong read_calls;
static atomic_int inject_eagain = 1;
static atomic_ulong last_requested;
static atomic_long last_returned;

unsigned long maus_test_last_read_requested(void) {
    return atomic_load(&last_requested);
}

long maus_test_last_read_returned(void) {
    return atomic_load(&last_returned);
}

unsigned long maus_test_read_calls(void) { return atomic_load(&read_calls); }

long snd_pcm_readi(void *pcm, void *buffer, unsigned long frames) {
    atomic_fetch_add(&read_calls, 1);
    const char *stall = getenv("MAUS_TEST_READ_STALL");
    if (stall) return strcmp(stall, "zero") == 0 ? 0 : -EAGAIN;
    if (atomic_exchange(&inject_eagain, 0)) {
        return -EAGAIN;
    }
    long (*original)(void *, void *, unsigned long) =
        (long (*)(void *, void *, unsigned long))dlsym(RTLD_NEXT, "snd_pcm_readi");
    unsigned long limit = frames > 1 ? frames / 2 : frames;
    long result = original(pcm, buffer, limit);
    atomic_store(&last_requested, frames);
    atomic_store(&last_returned, result);
    return result;
}
