/* Inject an ALSA capture setup failure and optionally an ambiguous close. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int fail_setup;
static atomic_int fail_poll_count;
static atomic_int close_pending;
static atomic_int fail_close;
static atomic_int setups;
static atomic_int closes;

void maus_test_arm_alsa_build_failure(int close_fails) {
    atomic_store(&setups, 0);
    atomic_store(&closes, 0);
    atomic_store(&fail_close, close_fails);
    atomic_store(&close_pending, 0);
    atomic_store(&fail_setup, 1);
}

int maus_test_alsa_failed_setups(void) { return atomic_load(&setups); }
int maus_test_alsa_build_close_calls(void) { return atomic_load(&closes); }

void maus_test_arm_alsa_poll_count_failure(void) {
    atomic_store(&closes, 0);
    atomic_store(&fail_close, 0);
    atomic_store(&close_pending, 0);
    atomic_store(&fail_poll_count, 1);
}

int snd_pcm_poll_descriptors_count(void *pcm) {
    if (atomic_exchange(&fail_poll_count, 0)) {
        atomic_store(&close_pending, 1);
        return -EIO;
    }
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors_count");
    return original(pcm);
}

int snd_pcm_hw_params(void *pcm, void *params) {
    if (atomic_exchange(&fail_setup, 0)) {
        atomic_fetch_add(&setups, 1);
        atomic_store(&close_pending, 1);
        return -EIO;
    }
    int (*original)(void *, void *) = (int (*)(void *, void *))dlsym(RTLD_NEXT, "snd_pcm_hw_params");
    return original(pcm, params);
}

int snd_pcm_close(void *pcm) {
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_close");
    int inject = atomic_exchange(&close_pending, 0);
    if (inject) {
        atomic_fetch_add(&closes, 1);
        int result = original(pcm);
        return result < 0 || !atomic_load(&fail_close) ? result : -EIO;
    }
    return original(pcm);
}
