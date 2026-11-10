/* Simulate capture-only PCMs and selected capture open/setup failures. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stddef.h>

static atomic_int open_error;
static atomic_int setup_failure;
static atomic_int capture_opens;
static atomic_int injected;

void maus_test_alsa_cache_fail_open(int error) {
    atomic_store(&injected, 0);
    atomic_store(&open_error, error);
}
void maus_test_alsa_cache_fail_setup(void) {
    atomic_store(&injected, 0);
    atomic_store(&setup_failure, 1);
}
int maus_test_alsa_cache_capture_opens(void) { return atomic_load(&capture_opens); }
int maus_test_alsa_cache_injected(void) { return atomic_load(&injected); }

int snd_pcm_open(void **pcm, const char *name, int stream, int mode) {
    int (*original)(void **, const char *, int, int) = dlsym(RTLD_NEXT, "snd_pcm_open");
    if (stream == 0) return -ENODEV;
    atomic_fetch_add(&capture_opens, 1);
    int error = atomic_exchange(&open_error, 0);
    if (error) {
        *pcm = NULL;
        atomic_fetch_add(&injected, 1);
        return -error;
    }
    return original(pcm, name, stream, mode);
}

int snd_pcm_hw_params(void *pcm, void *params) {
    if (atomic_exchange(&setup_failure, 0)) {
        atomic_fetch_add(&injected, 1);
        return -EIO;
    }
    int (*original)(void *, void *) = dlsym(RTLD_NEXT, "snd_pcm_hw_params");
    return original(pcm, params);
}
