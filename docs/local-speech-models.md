# Local speech models

mausVoice supports Whisper GGML models and local ONNX engines including NVIDIA Parakeet, Canary, and **SenseVoice**.

## SenseVoice

SenseVoice is a multilingual offline model backed by `sherpa-onnx`. Its model bundle contains an int8 ONNX graph and tokens, uses automatic language detection, and enables inverse text normalization for punctuation and numbers. Select it under **Settings → AI transcription**, download the model, and then choose it as the local model.

Local transcription includes an energy gate before inference. This avoids loading a model for empty microphone buffers and reduces silence hallucinations.
