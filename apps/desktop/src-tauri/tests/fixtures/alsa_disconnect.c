/* Test-only ALSA disconnect after capture has started on a null device. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdlib.h>

static atomic_int active;
static atomic_uint observations;

void maus_test_inject_alsa_disconnect(void) { atomic_store(&active, 1); }
void maus_test_clear_alsa_disconnect(void) { atomic_store(&active, 0); }
unsigned int maus_test_alsa_disconnect_observations(void) { return atomic_load(&observations); }

int snd_pcm_poll_descriptors_revents(void *pcm, struct pollfd *fds, unsigned int count, unsigned short *events) {
    int (*original)(void *, struct pollfd *, unsigned int, unsigned short *) =
        (int (*)(void *, struct pollfd *, unsigned int, unsigned short *))dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors_revents");
    int result = original(pcm, fds, count, events);
    if (result == 0 && atomic_load(&active)) {
        atomic_fetch_add(&observations, 1);
        *events = getenv("MAUS_TEST_DISCONNECTED_STATE") ? POLLERR : POLLHUP;
    }
    return result;
}

int snd_pcm_state(void *pcm) {
    if (atomic_load(&active) && getenv("MAUS_TEST_DISCONNECTED_STATE"))
        return 8; /* SND_PCM_STATE_DISCONNECTED */
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_state");
    return original(pcm);
}

int snd_pcm_drop(void *pcm) {
    /* A null PCM can stop despite the interposed state, so inject the stop failure too. */
    if (atomic_load(&active) && getenv("MAUS_TEST_DISCONNECTED_STATE"))
        return -ENODEV;
    int (*original)(void *) = (int (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_drop");
    return original(pcm);
}
