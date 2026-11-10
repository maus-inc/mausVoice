/* Test-only ALSA disconnect after capture has started on a null device. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

static atomic_int active;
static atomic_int injected_pollerr;
static atomic_uint observations;

void maus_test_inject_alsa_disconnect(void) { atomic_store(&active, 1); }
void maus_test_clear_alsa_disconnect(void) { atomic_store(&active, 0); }
unsigned int maus_test_alsa_disconnect_observations(void) { return atomic_load(&observations); }

static int inject_failure_at(const char *stage) {
    const char *selected = getenv("MAUS_TEST_DISCONNECT_STAGE");
    if (!atomic_load(&active) || !selected || strcmp(selected, stage) != 0) return 0;
    atomic_fetch_add(&observations, 1);
    return 1;
}

int snd_pcm_poll_descriptors(void *pcm, struct pollfd *fds, unsigned int count) {
    if (inject_failure_at("fill")) return -ENODEV;
    int (*original)(void *, struct pollfd *, unsigned int) =
        (int (*)(void *, struct pollfd *, unsigned int))dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors");
    return original(pcm, fds, count);
}

int snd_pcm_status(void *pcm, void *status) {
    if (inject_failure_at("status")) return -ENODEV;
    int (*original)(void *, void *) = (int (*)(void *, void *))dlsym(RTLD_NEXT, "snd_pcm_status");
    return original(pcm, status);
}

long snd_pcm_avail(void *pcm) {
    if (inject_failure_at("avail")) return -ENODEV;
    long (*original)(void *) = (long (*)(void *))dlsym(RTLD_NEXT, "snd_pcm_avail");
    return original(pcm);
}

long snd_pcm_readi(void *pcm, void *buffer, unsigned long frames) {
    if (inject_failure_at("read")) return -ENODEV;
    long (*original)(void *, void *, unsigned long) =
        (long (*)(void *, void *, unsigned long))dlsym(RTLD_NEXT, "snd_pcm_readi");
    return original(pcm, buffer, frames);
}

long snd_pcm_writei(void *pcm, const void *buffer, unsigned long frames) {
    const char *stage = getenv("MAUS_TEST_DISCONNECT_STAGE");
    if (atomic_load(&active) && stage && strcmp(stage, "recover") == 0) return -EPIPE;
    if (inject_failure_at("write")) return -ENODEV;
    long (*original)(void *, const void *, unsigned long) =
        (long (*)(void *, const void *, unsigned long))dlsym(RTLD_NEXT, "snd_pcm_writei");
    return original(pcm, buffer, frames);
}

int snd_pcm_recover(void *pcm, int error, int silent) {
    if (inject_failure_at("recover")) return -ENODEV;
    int (*original)(void *, int, int) =
        (int (*)(void *, int, int))dlsym(RTLD_NEXT, "snd_pcm_recover");
    return original(pcm, error, silent);
}

int snd_pcm_poll_descriptors_revents(void *pcm, struct pollfd *fds, unsigned int count, unsigned short *events) {
    if (inject_failure_at("revents")) return -ENODEV;
    int (*original)(void *, struct pollfd *, unsigned int, unsigned short *) =
        (int (*)(void *, struct pollfd *, unsigned int, unsigned short *))dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors_revents");
    int result = original(pcm, fds, count, events);
    if (result == 0 && atomic_load(&active) && !getenv("MAUS_TEST_DISCONNECT_STAGE")) {
        atomic_fetch_add(&observations, 1);
        *events = getenv("MAUS_TEST_DISCONNECTED_STATE") ? POLLERR : POLLHUP;
        if (*events == POLLERR) atomic_store(&injected_pollerr, 1);
    }
    return result;
}

int snd_pcm_state(void *pcm) {
    /* Preserve the real state until revents has injected POLLERR, so the
       worker cannot observe the simulated disconnect before that path. */
    if (atomic_load(&active) && atomic_load(&injected_pollerr) &&
        getenv("MAUS_TEST_DISCONNECTED_STATE"))
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
