#!/bin/sh
set -eu
mkdir -p dist/native
swiftc -target "$(uname -m)-apple-macosx15.0" native/CalendarBridge.swift -o dist/native/calendar-bridge -framework EventKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Info.plist
mkdir -p 'dist/native/Local Meeting Audio.app/Contents/MacOS'
cp native/AudioInfo.plist 'dist/native/Local Meeting Audio.app/Contents/Info.plist'
swiftc -target "$(uname -m)-apple-macosx14.2" native/SystemAudioBridge.swift -o 'dist/native/Local Meeting Audio.app/Contents/MacOS/LocalMeetingAudio' -framework CoreAudio -framework AppKit
codesign --force --deep --sign - 'dist/native/Local Meeting Audio.app'
