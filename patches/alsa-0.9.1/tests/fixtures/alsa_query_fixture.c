/* Loaded only into the isolated alsa_query_fixture test process. */
#include <alsa/asoundlib.h>
#include <errno.h>
#include <stdlib.h>

int snd_ctl_open(snd_ctl_t **ctl, const char *name, int mode) {
    (void)name;
    (void)mode;
    *ctl = (snd_ctl_t *)1;
    return 0;
}

int snd_ctl_close(snd_ctl_t *ctl) {
    (void)ctl;
    return 0;
}

int snd_ctl_poll_descriptors_count(snd_ctl_t *ctl) {
    (void)ctl;
    return -EIO;
}

int snd_pcm_open(snd_pcm_t **pcm, const char *name, snd_pcm_stream_t stream, int mode) {
    (void)name;
    (void)stream;
    (void)mode;
    *pcm = (snd_pcm_t *)1;
    return 0;
}

int snd_pcm_close(snd_pcm_t *pcm) {
    (void)pcm;
    return 0;
}

int snd_pcm_poll_descriptors_count(snd_pcm_t *pcm) {
    (void)pcm;
    return -EIO;
}

int snd_ctl_rawmidi_next_device(snd_ctl_t *ctl, int *device) {
    (void)ctl;
    int last = getenv("MIDI_EMPTY_RUN") ? 100000 : 3;
    *device = *device < last ? *device + 1 : -1;
    return 0;
}

int snd_ctl_rawmidi_info(snd_ctl_t *ctl, snd_rawmidi_info_t *info) {
    (void)ctl;
    unsigned int device = snd_rawmidi_info_get_device(info);
    snd_rawmidi_stream_t stream = snd_rawmidi_info_get_stream(info);
    if (getenv("MIDI_EMPTY_RUN")) {
        if (device < 100000 || stream == SND_RAWMIDI_STREAM_INPUT) return -ENOENT;
        return 0;
    }
    if (device == 2) return -EIO;
    if ((device == 0 && stream == SND_RAWMIDI_STREAM_INPUT) ||
        (device == 1 && stream == SND_RAWMIDI_STREAM_OUTPUT) ||
        (device == 3 && stream == SND_RAWMIDI_STREAM_INPUT)) return -ENOENT;
    return 0;
}

unsigned int snd_rawmidi_info_get_subdevices_count(const snd_rawmidi_info_t *info) {
    return snd_rawmidi_info_get_device(info) == 0 ? 2 : 1;
}

/* Wait shims never block; return the supplied value through an accessor. */
static int last_wait_timeout;
int maus_test_last_wait_timeout(void) { return last_wait_timeout; }
int snd_pcm_wait(snd_pcm_t *pcm, int timeout) {
    (void)pcm;
    last_wait_timeout = timeout;
    return 0;
}
int snd_mixer_open(snd_mixer_t **mixer, int mode) {
    (void)mode;
    *mixer = (snd_mixer_t *)1;
    return 0;
}
int snd_mixer_close(snd_mixer_t *mixer) {
    (void)mixer;
    return 0;
}
int snd_mixer_wait(snd_mixer_t *mixer, int timeout) {
    (void)mixer;
    last_wait_timeout = timeout;
    return 0;
}
int snd_hctl_open(snd_hctl_t **hctl, const char *name, int mode) {
    (void)name;
    (void)mode;
    *hctl = (snd_hctl_t *)1;
    return 0;
}
int snd_hctl_close(snd_hctl_t *hctl) {
    (void)hctl;
    return 0;
}
int snd_hctl_wait(snd_hctl_t *hctl, int timeout) {
    (void)hctl;
    last_wait_timeout = timeout;
    return 0;
}
