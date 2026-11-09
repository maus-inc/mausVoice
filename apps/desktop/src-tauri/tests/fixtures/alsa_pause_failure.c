/* Fault injection for isolated ALSA null capture and playback tests. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>

/* 1: hardware pause unsupported, 2: pause fails after changing state,
 * 3: resume fails after changing state, 4: pause unsupported, 5: pause I/O error,
 * 6: simulate a successful pause independently of the null PCM's state. */
static atomic_int mode;
static atomic_int pause_calls;
void maus_test_arm_alsa_pause(int value) {
    atomic_store(&mode, value);
    atomic_store(&pause_calls, 0);
}
int maus_test_alsa_pause_calls(void) { return atomic_load(&pause_calls); }

int snd_pcm_hw_params_can_pause(const void *params) {
    if (atomic_load(&mode) == 1) return 0;
    int (*original)(const void *) = dlsym(RTLD_NEXT, "snd_pcm_hw_params_can_pause");
    return original(params);
}
int snd_pcm_pause(void *pcm, int enabled) {
    atomic_fetch_add(&pause_calls, 1);
    int selected = atomic_load(&mode);
    if (enabled && (selected == 4 || selected == 5 || selected == 6)) {
        atomic_store(&mode, 0);
        if (selected == 6) return 0;
        return selected == 4 ? -ENOSYS : -EIO;
    }
    int (*original)(void *, int) = dlsym(RTLD_NEXT, "snd_pcm_pause");
    int result = original(pcm, enabled);
    selected = atomic_load(&mode);
    if (result == 0 && ((selected == 2 && enabled) || (selected == 3 && !enabled))) {
        atomic_store(&mode, 0);
        return -EIO;
    }
    return result;
}
