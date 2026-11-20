/* Exercise the ALSA POLLERR/XRUN path against an isolated null device. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <poll.h>
#include <stdatomic.h>

static atomic_int active;
static atomic_int preparations;

void maus_test_inject_alsa_poll_xrun(void) {
    atomic_store(&preparations, 0);
    atomic_store(&active, 1);
}

int maus_test_alsa_xrun_preparations(void) { return atomic_load(&preparations); }

int snd_pcm_poll_descriptors_revents(void *pcm, struct pollfd *fds, unsigned int count, unsigned short *events) {
    int (*original)(void *, struct pollfd *, unsigned int, unsigned short *) =
        (int (*)(void *, struct pollfd *, unsigned int, unsigned short *))dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors_revents");
    int result = original(pcm, fds, count, events);
    if (result == 0 && atomic_load(&active)) *events = POLLERR;
    return result;
}

int snd_pcm_state(void *pcm) {
    if (atomic_load(&active)) return 4; /* SND_PCM_STATE_XRUN */
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_state");
    return original(pcm);
}

int snd_pcm_prepare(void *pcm) {
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_prepare");
    if (atomic_exchange(&active, 0)) atomic_fetch_add(&preparations, 1);
    return original(pcm);
}
