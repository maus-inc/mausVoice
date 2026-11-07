/* Simulate a capture start that succeeds in the driver but reports an error,
 * followed by two failed stops. Use only with an isolated ALSA null device. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int inject_start;
static atomic_int starts_observed;
static atomic_int stops_remaining;
static atomic_int stops_observed;

void maus_test_arm_alsa_start_failure(void) {
    atomic_store(&starts_observed, 0);
    atomic_store(&stops_observed, 0);
    atomic_store(&stops_remaining, 2);
    atomic_store(&inject_start, 1);
}

int maus_test_alsa_failed_starts(void) { return atomic_load(&starts_observed); }
int maus_test_alsa_failed_start_stops(void) { return atomic_load(&stops_observed); }

int snd_pcm_start(void *pcm) {
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_start");
    int result = original(pcm);
    if (result == 0 && atomic_exchange(&inject_start, 0)) {
        atomic_fetch_add(&starts_observed, 1);
        return -EIO;
    }
    return result;
}

int snd_pcm_drop(void *pcm) {
    int remaining = atomic_load(&stops_remaining);
    while (remaining > 0) {
        if (atomic_compare_exchange_weak(&stops_remaining, &remaining, remaining - 1)) {
            atomic_fetch_add(&stops_observed, 1);
            return -EIO;
        }
    }
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_drop");
    return original(pcm);
}
