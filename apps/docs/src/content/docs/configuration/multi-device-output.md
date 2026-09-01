---
title: "Multi-device output"
description: "Pair a sender and receiver, route final text, and understand the current LAN transport boundary."
sidebar:
  order: 10
---

**Settings → General → More settings → Multi-device** can make one mausVoice desktop receive text from another. This changes the delivery stage only: recording, transcription, replacements, and any post-processing still run on the sender. When remote output is enabled, normal dictation goes to the selected receiver instead of being inserted on the sender. Bulk dictation sends the completed result; Verbatim real-time output can send committed text segments as they arrive. Microphone audio is never routed to the receiver.

## Pair with an invite

On the computer that should receive text:

1. Turn on **Receive transcript from another device**.
2. Leave **Receiver port** blank to use an automatically assigned port, or enter a positive fixed port and choose **Apply**. Applying a new port restarts an active receiver.
3. Optionally enable **Start receiver automatically**.
4. Choose **Copy invite** and transfer that value privately to the sender.

On the computer where you dictate:

1. Open the same dialog and choose **Import invite**.
2. Paste the receiver's invite and choose **Pair**. The receiver validates its current pairing code, creates a shared secret, trusts the sender, and rotates the pairing code.
3. Turn on **Send transcript to another device**, choose the paired **Active receiver**, and run **Send test**.

The receiver reports its listen address, port, last sender, last delivery state, target window, and latest error. Before testing, focus the actual editable field on the receiver computer. A successful network acknowledgement does not help if the receiver is focused on the mausVoice window or has no editable field selected.

## Trusted devices and manual setup

Invite pairing is the preferred path. **Trusted devices → Add device** is the manual fallback and asks for a name, device ID, platform, role, and shared secret. A receiver also needs an address such as `192.168.1.25:43123`. Both records must use the same secret. The current platform selector offers macOS and Windows values.

You can copy, edit, or delete a trusted-device record from the dialog. Deleting a record removes that trust relationship locally; remove the counterpart record on the other computer as well when retiring a pairing.

## Security boundary

The current implementation sends newline-delimited JSON over a plain TCP connection. It checks the pairing code, then authenticates later sessions by comparing the paired sender's shared secret, but it does **not** add TLS or encrypt the transcript payload. Pairing codes, shared secrets, and finalized text therefore must not be treated as confidential on an untrusted network.

Use this feature only on a network and devices you control, restrict the receiver port with the host firewall, and never publish it directly to the internet. The receiver binds to all interfaces (`0.0.0.0`), even though the dialog presents a detected connection address. An invite is base64url-encoded configuration, not encryption; share it like a credential.

If delivery fails, verify that the receiver is running, the address and port are reachable, both devices still have matching trusted records, and the destination field is focused. Disable remote output to return to normal local insertion while investigating.
