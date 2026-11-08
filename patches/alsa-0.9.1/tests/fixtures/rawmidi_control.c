/* Loaded only into the isolated rawmidi_iteration test process. */
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
