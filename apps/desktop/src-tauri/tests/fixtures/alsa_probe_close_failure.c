/* Inject an ambiguous close for a capture capability probe. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <unistd.h>

static atomic_int armed;
static atomic_int hold_close;
static atomic_int closing;
static atomic_int fail_close;
static atomic_int capture_opens;
static atomic_int failed;
static atomic_int capture_opens_after_failure;
static atomic_int probe_close_calls;
static atomic_uintptr_t probe;

void maus_test_arm_alsa_probe_close_failure(void) {
    atomic_store(&probe, 0);
    atomic_store(&failed, 0);
    atomic_store(&capture_opens_after_failure, 0);
    atomic_store(&probe_close_calls, 0);
    atomic_store(&capture_opens, 0);
    atomic_store(&closing, 0);
    atomic_store(&hold_close, 0);
    atomic_store(&fail_close, 1);
    atomic_store(&armed, 1);
}
void maus_test_hold_alsa_probe_close(void) {
    maus_test_arm_alsa_probe_close_failure();
    atomic_store(&fail_close, 0);
    atomic_store(&hold_close, 1);
}
void maus_test_release_alsa_probe_close(void) { atomic_store(&hold_close, 0); }
int maus_test_alsa_probe_closing(void) { return atomic_load(&closing); }
int maus_test_alsa_capture_opens(void) { return atomic_load(&capture_opens); }
int maus_test_alsa_probe_closes(void) { return atomic_load(&probe_close_calls); }
int maus_test_alsa_opens_after_probe_failure(void) { return atomic_load(&capture_opens_after_failure); }

int snd_pcm_open(void **pcm, const char *name, int stream, int mode) {
    int (*original)(void **, const char *, int, int) = dlsym(RTLD_NEXT, "snd_pcm_open");
    if (stream == 1) {
        atomic_fetch_add(&capture_opens, 1);
        if (atomic_load(&failed)) atomic_fetch_add(&capture_opens_after_failure, 1);
    }
    int result = original(pcm, name, stream, mode);
    if (stream == 1 && result == 0 && atomic_load(&armed))
        atomic_store(&probe, (uintptr_t)*pcm);
    return result;
}

int snd_pcm_close(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_close");
    int inject = atomic_load(&armed) && atomic_load(&probe) == (uintptr_t)pcm;
    if (!inject) return original(pcm);
    atomic_store(&armed, 0);
    atomic_fetch_add(&probe_close_calls, 1);
    atomic_store(&closing, 1);
    while (atomic_load(&hold_close)) usleep(1000);
    int result = original(pcm);
    if (atomic_load(&fail_close)) {
        atomic_store(&failed, 1);
        return result < 0 ? result : -EIO;
    }
    return result;
}
