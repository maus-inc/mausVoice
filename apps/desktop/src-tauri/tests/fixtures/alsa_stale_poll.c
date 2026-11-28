/* Delay a completed ALSA poll across pause/resume, then report one XRUN. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <poll.h>
#include <stdatomic.h>
#include <stddef.h>
#include <time.h>

static atomic_int armed;
static atomic_int entered;
static atomic_int released;
static atomic_int inject_xrun;
static atomic_int report_xrun_state;
static atomic_int preparations;
static atomic_int starts;
static atomic_int tracking;

void maus_test_arm_stale_poll(void) {
    atomic_store(&entered, 0);
    atomic_store(&released, 0);
    atomic_store(&preparations, 0);
    atomic_store(&starts, 0);
    atomic_store(&tracking, 1);
    atomic_store(&armed, 1);
}
int maus_test_stale_poll_entered(void) { return atomic_load(&entered); }
void maus_test_release_stale_poll(void) { atomic_store(&released, 1); }
int maus_test_stale_poll_preparations(void) { return atomic_load(&preparations); }
int maus_test_stale_poll_starts(void) { return atomic_load(&starts); }

int poll(struct pollfd *fds, nfds_t count, int timeout) {
    int (*original)(struct pollfd *, nfds_t, int) = dlsym(RTLD_NEXT, "poll");
    int result = original(fds, count, timeout);
    if (result > 0 && atomic_exchange(&armed, 0)) {
        atomic_store(&entered, 1);
        const struct timespec delay = { .tv_sec = 0, .tv_nsec = 1000000 };
        while (!atomic_load(&released)) nanosleep(&delay, NULL);
        atomic_store(&inject_xrun, 1);
    }
    return result;
}

int snd_pcm_poll_descriptors_revents(void *pcm, struct pollfd *fds,
                                     unsigned int count, unsigned short *events) {
    int (*original)(void *, struct pollfd *, unsigned int, unsigned short *) =
        dlsym(RTLD_NEXT, "snd_pcm_poll_descriptors_revents");
    int result = original(pcm, fds, count, events);
    if (result == 0 && atomic_exchange(&inject_xrun, 0)) {
        atomic_store(&report_xrun_state, 1);
        *events = POLLERR;
    }
    return result;
}

int snd_pcm_state(void *pcm) {
    if (atomic_exchange(&report_xrun_state, 0)) return 4; /* XRUN */
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_state");
    return original(pcm);
}

int snd_pcm_prepare(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_prepare");
    if (atomic_load(&tracking)) atomic_fetch_add(&preparations, 1);
    return original(pcm);
}

int snd_pcm_start(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_start");
    if (atomic_load(&tracking)) atomic_fetch_add(&starts, 1);
    return original(pcm);
}
