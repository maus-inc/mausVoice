/* Inject two failed PCM stop attempts in one isolated ALSA-null test. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int failures_remaining;
static atomic_int failures_observed;

void maus_test_fail_next_alsa_stops(void) {
    atomic_store(&failures_observed, 0);
    atomic_store(&failures_remaining, 2);
}

int maus_test_alsa_stop_failures(void) {
    return atomic_load(&failures_observed);
}

int snd_pcm_drop(void *pcm) {
    int remaining = atomic_load(&failures_remaining);
    while (remaining > 0) {
        if (atomic_compare_exchange_weak(&failures_remaining, &remaining, remaining - 1)) {
            atomic_fetch_add(&failures_observed, 1);
            return -EIO;
        }
    }
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_drop");
    return original(pcm);
}
