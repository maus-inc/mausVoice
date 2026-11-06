/* Test-only ALSA fault injection. Compile as a shared object and preload only
 * for the isolated null-device test. The normal ALSA library does the work. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int inject_overrun;

void maus_test_inject_alsa_overrun(void) {
    atomic_store(&inject_overrun, 1);
}

long snd_pcm_avail(void *pcm) {
    if (atomic_exchange(&inject_overrun, 0)) {
        return -EPIPE;
    }
    long (*original)(void *) = (long (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_avail");
    return original(pcm);
}
