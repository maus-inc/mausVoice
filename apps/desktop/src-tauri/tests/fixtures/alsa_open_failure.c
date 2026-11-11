/* Return an error with a non-null capture handle, as a misbehaving plugin might. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>

static atomic_int armed;
static atomic_int opens_after_failure;
static atomic_int closes;
static atomic_int failed;
static atomic_uintptr_t uncertain_handle;

void maus_test_arm_alsa_open_failure(void) {
    atomic_store(&failed, 0);
    atomic_store(&opens_after_failure, 0);
    atomic_store(&closes, 0);
    atomic_store(&uncertain_handle, 0);
    atomic_store(&armed, 1);
}
int maus_test_alsa_opens_after_open_failure(void) { return atomic_load(&opens_after_failure); }
int maus_test_alsa_uncertain_open_closes(void) { return atomic_load(&closes); }

int snd_pcm_open(void **pcm, const char *name, int stream, int mode) {
    int (*original)(void **, const char *, int, int) = dlsym(RTLD_NEXT, "snd_pcm_open");
    if (stream == 1 && atomic_load(&failed)) atomic_fetch_add(&opens_after_failure, 1);
    int result = original(pcm, name, stream, mode);
    if (stream == 1 && result == 0 && atomic_exchange(&armed, 0)) {
        atomic_store(&uncertain_handle, (uintptr_t)*pcm);
        atomic_store(&failed, 1);
        return -EIO;
    }
    return result;
}

int snd_pcm_close(void *pcm) {
    int (*original)(void *) = dlsym(RTLD_NEXT, "snd_pcm_close");
    if (atomic_load(&uncertain_handle) == (uintptr_t)pcm) atomic_fetch_add(&closes, 1);
    return original(pcm);
}
