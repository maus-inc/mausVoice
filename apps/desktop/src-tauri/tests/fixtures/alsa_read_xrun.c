/* Inject readi XRUN only for an isolated ALSA null capture test. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

static atomic_int inject;
static atomic_int recovering;
static atomic_int preparations;
static atomic_int starts;
void maus_test_inject_read_xrun(void) {
    atomic_store(&preparations, 0);
    atomic_store(&starts, 0);
    atomic_store(&inject, 1);
}
int maus_test_read_xrun_preparations(void) { return atomic_load(&preparations); }
int maus_test_read_xrun_starts(void) { return atomic_load(&starts); }
long snd_pcm_readi(void *pcm, void *buffer, unsigned long frames) {
    if (atomic_exchange(&inject, 0)) {
        atomic_store(&recovering, 1);
        return -EPIPE;
    }
    long (*original)(void *, void *, unsigned long) = dlsym(RTLD_NEXT, "snd_pcm_readi");
    return original(pcm, buffer, frames);
}
int snd_pcm_prepare(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_prepare");
    int result = original(pcm);
    if (atomic_load(&recovering)) atomic_fetch_add(&preparations, 1);
    return result;
}
int snd_pcm_start(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_start");
    int result = original(pcm);
    if (atomic_exchange(&recovering, 0)) atomic_fetch_add(&starts, 1);
    return result;
}
