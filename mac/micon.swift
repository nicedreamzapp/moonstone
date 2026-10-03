// micon: prints 1 if any audio input device on this Mac is in use right now, else 0 (add -v to list them)
import CoreAudio
import Foundation
func get<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ v: inout T) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var sz = UInt32(MemoryLayout<T>.size); return AudioObjectGetPropertyData(obj, &a, 0, nil, &sz, &v) == 0 }
var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var sz = UInt32(0); AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz)
var ids = [AudioObjectID](repeating: 0, count: Int(sz) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz, &ids)
var any = false
for d in ids {
    var ia = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var isz = UInt32(0); AudioObjectGetPropertyDataSize(d, &ia, 0, nil, &isz); if isz == 0 { continue }
    var run = UInt32(0); _ = get(d, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal, &run)
    var run2 = UInt32(0); _ = get(d, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeInput, &run2)
    if CommandLine.arguments.contains("-v") { print(d, run, run2) }
    if run != 0 || run2 != 0 { any = true }
}
print(any ? 1 : 0)
