import Foundation
import CoreAudio
import AppKit
import Darwin

// Capture helper: stdout carries interleaved 48 kHz Float32 microphone/system samples.
// A private aggregate shares the input device clock with a drift-compensated tap.
// Any missing stream or queue overflow aborts capture rather than silently dropping audio.
func check(_ value: OSStatus, _ operation: String) throws {
    if value != noErr { throw NSError(domain: operation, code: Int(value)) }
}
func scalar<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) throws {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    try withUnsafeMutablePointer(to: &value) { ptr in try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, ptr), "property") }
}
func processes() throws -> [(pid_t, String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "process size")
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if ids.isEmpty {return []}
    try ids.withUnsafeMutableBytes { b in try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, b.baseAddress!), "process list") }
    return ids.compactMap { id in
        var pid: pid_t = 0, running: UInt32 = 0
        guard (try? scalar(id, kAudioProcessPropertyPID, &pid)) != nil, (try? scalar(id, kAudioProcessPropertyIsRunningOutput, &running)) != nil, running != 0, pid > 0 else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        return (pid, app?.localizedName ?? "프로세스 \(pid)")
    }
}
func processObject(_ pid: pid_t) throws -> AudioObjectID {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var process = pid, object = AudioObjectID(0), size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &process, &size, &object), "process")
    guard object != 0 else { throw NSError(domain: "선택한 앱의 오디오를 찾을 수 없습니다", code: 1) }
    return object
}
final class State {
    let lock = NSLock(); var pendingBytes = 0; var failure: String?
    func fail(_ message: String) { lock.lock(); defer {lock.unlock()}; if failure == nil { failure = message } }
    func begin(_ bytes: Int) -> Bool {lock.lock(); defer {lock.unlock()}; if failure != nil {return false}; if bytes > 4*1024*1024-pendingBytes {failure = "오디오 기록이 입력을 따라가지 못했습니다";return false}; pendingBytes += bytes;return true}
    func end(_ bytes: Int) {lock.lock(); pendingBytes -= bytes; lock.unlock()}
    func error() -> String? {lock.lock();defer{lock.unlock()};return failure}
}
func capture(_ pids: [pid_t]?) throws {
    var tap: AudioObjectID = 0, aggregate: AudioObjectID = 0
    let desc: CATapDescription
    if let pids {guard !pids.isEmpty else {throw NSError(domain:"선택한 앱이 없습니다",code:1)};desc = CATapDescription(monoMixdownOfProcesses: try pids.map { try processObject($0) })}
    else {desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])}
    desc.name = "Local Meeting system audio"; desc.isPrivate = true; desc.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(desc, &tap), "system tap")
    defer { if aggregate != 0 {AudioHardwareDestroyAggregateDevice(aggregate)}; if tap != 0 {AudioHardwareDestroyProcessTap(tap)} }
    var input: AudioObjectID = 0; try scalar(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, &input)
    var inputUID: Unmanaged<CFString>? = nil; try scalar(input, kAudioDevicePropertyDeviceUID, &inputUID)
    guard let uid = inputUID?.takeUnretainedValue() as String? else {throw NSError(domain:"마이크를 찾지 못했습니다",code:1)}
    let spec: [String:Any] = [kAudioAggregateDeviceNameKey:"Local Meeting Capture",kAudioAggregateDeviceUIDKey:UUID().uuidString,kAudioAggregateDeviceIsPrivateKey:true,kAudioAggregateDeviceMainSubDeviceKey:uid,kAudioAggregateDeviceSubDeviceListKey:[[kAudioSubDeviceUIDKey:uid]],kAudioAggregateDeviceTapListKey:[[kAudioSubTapUIDKey:desc.uuid.uuidString,kAudioSubTapDriftCompensationKey:true]]]
    try check(AudioHardwareCreateAggregateDevice(spec as CFDictionary, &aggregate), "aggregate")
    var format = AudioStreamBasicDescription(), address = AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyStreamFormat,mScope:kAudioDevicePropertyScopeInput,mElement:kAudioObjectPropertyElementMain), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(aggregate,&address,0,nil,&size,&format),"input format")
    guard format.mSampleRate == 48000, format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0 else {throw NSError(domain:"48kHz 부동소수점 마이크가 필요합니다",code:1)}
    let state = State(), writer = DispatchQueue(label:"localmeeting.audio.writer"); var proc: AudioDeviceIOProcID?
    try check(AudioDeviceCreateIOProcIDWithBlock(&proc,aggregate,nil){_,data,_,_,_ in
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating:data))
        guard buffers.count == 2, buffers[0].mNumberChannels == 1, buffers[1].mNumberChannels == 1, buffers[0].mDataByteSize == buffers[1].mDataByteSize, let m = buffers[0].mData, let s = buffers[1].mData else {state.fail("마이크와 시스템 오디오 스트림을 확인하지 못했습니다");return}
        let n = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        guard n > 0, state.begin(n*8) else {return}
        let mic=m.assumingMemoryBound(to:Float.self), sys=s.assumingMemoryBound(to:Float.self)
        var block=[Float](repeating:0,count:n*2)
        for i in 0..<n {block[i*2]=mic[i];block[i*2+1]=sys[i]}
        writer.async {block.withUnsafeBytes { raw in var sent=0;while sent<raw.count {let n=Darwin.write(STDOUT_FILENO,raw.baseAddress!.advanced(by:sent),raw.count-sent);if n<=0 {state.fail("오디오 전달이 중단됐습니다");break};sent+=n}};state.end(n*8)}
    },"audio callback")
    defer {if let proc {AudioDeviceDestroyIOProcID(aggregate,proc)}}
    try check(AudioDeviceStart(aggregate,proc),"capture start")
    fputs("READY 48000 2\n",stderr);fflush(stderr)
    let done=DispatchSemaphore(value:0)
    DispatchQueue.global().async {_=readLine();done.signal()}
    while done.wait(timeout:.now()+0.1) == .timedOut {
        if state.error() != nil {break}
        if let pids, pids.contains(where:{kill($0,0) != 0 && errno == ESRCH}) {state.fail("선택한 앱이 종료되어 시스템 오디오 녹음을 중지했습니다");break}
    }
    try check(AudioDeviceStop(aggregate,proc),"capture stop")
    writer.sync {}
    if let error=state.error() {throw NSError(domain:error,code:1)}
}
do {
    if CommandLine.arguments.contains("--list") {
        let data = try JSONSerialization.data(withJSONObject:processes().map { ["pid":$0.0,"name":$0.1] });FileHandle.standardOutput.write(data)
    } else if CommandLine.arguments.contains("--global") {try capture(nil)}
    else if let i=CommandLine.arguments.firstIndex(of:"--pid"), i+1<CommandLine.arguments.count, let pid=pid_t(CommandLine.arguments[i+1]), pid>0 {try capture([pid])}
    else {throw NSError(domain:"오디오 캡처 대상을 선택하세요",code:1)}
} catch {fputs("\(error)\n",stderr);exit(1)}
