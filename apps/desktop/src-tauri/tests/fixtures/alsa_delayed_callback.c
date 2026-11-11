/* Delay ALSA capture after readi and before the consumer callback. */
#define _GNU_SOURCE
#include <stdatomic.h>
#include <stddef.h>
#include <time.h>

static atomic_int armed;
static atomic_int entered;
static atomic_int released;

void maus_test_arm_delayed_callback(void) {
    atomic_store(&entered, 0);
    atomic_store(&released, 0);
    atomic_store(&armed, 1);
}
int maus_test_delayed_callback_entered(void) { return atomic_load(&entered); }
void maus_test_release_delayed_callback(void) { atomic_store(&released, 1); }

/* The null PCM normally reports no timestamp. Provide a monotonic timestamp so
 * CPAL queries the trigger timestamp between readi and the data callback. */
void snd_pcm_status_get_htstamp(const void *status, struct timespec *timestamp) {
    (void)status;
    clock_gettime(CLOCK_MONOTONIC, timestamp);
}

void snd_pcm_status_get_trigger_htstamp(const void *status, struct timespec *timestamp) {
    (void)status;
    timestamp->tv_sec = 0;
    timestamp->tv_nsec = 0;
    if (atomic_exchange(&armed, 0)) {
        atomic_store(&entered, 1);
        const struct timespec delay = { .tv_sec = 0, .tv_nsec = 1000000 };
        while (!atomic_load(&released)) nanosleep(&delay, NULL);
    }
}
