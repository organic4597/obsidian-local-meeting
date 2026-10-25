#!/bin/sh
# NVIDIA official v0.2.0 runtime + indexed, hash-verified Nemotron 3 model.
set -eu
mkdir -p runtime work
archive='nemo-speech-0.2.0-macos-aarch64-metal.tar.gz'
base='https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0'
curl --fail --location --proto '=https' "$base/$archive" -o "work/$archive"
curl --fail --location --proto '=https' "$base/$archive.sha256" -o "work/$archive.sha256"
(cd work && shasum -a 256 -c "$archive.sha256")
tar -xzf "work/$archive" -C runtime
runtime/nemo-speech-0.2.0-macos-aarch64-metal/bin/nemo-speech pull nvidia/Nemotron-3-Diarization
printf '\n화자 라이브러리: %s/runtime/nemo-speech-0.2.0-macos-aarch64-metal/lib/libnemo_speech_asr_c.dylib\n' "$PWD"
printf '모델: ~/Library/Caches/NeMoSpeech/models/nvidia/Nemotron-3-Diarization/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf\n'
