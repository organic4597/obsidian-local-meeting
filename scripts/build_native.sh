#!/bin/sh
set -eu
mkdir -p dist/native
swiftc native/CalendarBridge.swift -o dist/native/calendar-bridge -framework EventKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Info.plist
