/* Simulate a close that has invalidated the handle but reports failure. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int armed;
static atomic_int observed;
static atomic_int tracking;

void maus_test_arm_alsa_close_failure(void) {
    atomic_store(&observed, 0);
    atomic_store(&tracking, 1);
    atomic_store(&armed, 1);
}

int maus_test_alsa_close_calls(void) { return atomic_load(&observed); }

int snd_pcm_close(void *pcm) {
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_close");
    int inject = atomic_exchange(&armed, 0);
    if (atomic_load(&tracking)) {
        atomic_fetch_add(&observed, 1);
    }
    if (inject) {
        int result = original(pcm);
        return result < 0 ? result : -EIO;
    }
    return original(pcm);
}
