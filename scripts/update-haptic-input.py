import sys, os
files = [
    'packages/rust_windows_pill/src/input.rs',
    'packages/rust_gtk_pill/src/input.rs',
]
for fpath in files:
    with open(fpath, 'r') as f:
        content = f.read()
    if 'send_haptic' in content:
        print(f"Skipped {fpath} (already has send_haptic)")
        continue
    # Add send_haptic function
    content = content.replace(
        'fn handle_click(',
        '/// A23: Dispatch haptic/audio feedback to the desktop process.\nfn send_haptic(kind: &str) {\n    ipc::send(&OutMessage::HapticFeedback {\n        kind: kind.to_string(),\n    });\n}\n\nfn handle_click(',
        1
    )
    # Wire haptic to click actions
    pairs = [
        ('ClickAction::Pill => {\n                    ipc::send(&OutMessage::Click);', 'ClickAction::Pill => {\n                    send_haptic("press");\n                    ipc::send(&OutMessage::Click);'),
        ('ClickAction::StyleForward => {', 'ClickAction::StyleForward => {\n                    send_haptic("deep");'),
        ('ClickAction::StyleBackward => {', 'ClickAction::StyleBackward => {\n                    send_haptic("deep");'),
        ('ClickAction::CancelDictation => {', 'ClickAction::CancelDictation => {\n                    send_haptic("deep");'),
    ]
    for old, new in pairs:
        content = content.replace(old, new, 1)
    with open(fpath, 'w') as f:
        f.write(content)
    print(f"Updated {fpath}")