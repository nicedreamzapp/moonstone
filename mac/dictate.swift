// Moonstone Dictate — turns macOS's own dictation on/off in the text box that has the cursor.
// Moonstone's mic button runs it. Sign it with a stable identity (see build.sh) so the Accessibility
// permission survives rebuilds; ad-hoc signing ties the permission to one exact build and every rebuild needs a re-allow.
//   dictate start | stop   open the front app's Edit menu and click Start/Stop Dictation if that's what it shows
//   dictate status         open the Edit menu, report "on" / "off", touch nothing
//   dictate ctrl           press Control twice (flags in hex: dictate ctrl 40101 100)
//   dictate check          print whether permission is granted
// Brave/Chrome only fill in their Edit menu when it is opened, so reading it closed finds nothing.
import Foundation
import AppKit
import ApplicationServices
import CoreAudio

let args = Array(CommandLine.arguments.dropFirst())
if !CGPreflightPostEventAccess() || !AXIsProcessTrusted() {
    _ = CGRequestPostEventAccess()
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    print("needs-permission"); exit(2)
}
let mode = args.first ?? "status"
if mode == "check" { print("ok"); exit(0) }

if mode == "ctrl" {
    let down = UInt64(args.count > 1 ? args[1] : "40101", radix: 16) ?? 0x40101
    let up = UInt64(args.count > 2 ? args[2] : "100", radix: 16) ?? 0x100
    let src = CGEventSource(stateID: .hidSystemState)
    func ctrl(_ isDown: Bool) {
        let e = CGEvent(keyboardEventSource: src, virtualKey: 0x3B, keyDown: isDown)!
        e.type = .flagsChanged; e.flags = CGEventFlags(rawValue: isDown ? down : up); e.post(tap: .cghidEventTap) }
    ctrl(true); usleep(40_000); ctrl(false); usleep(120_000); ctrl(true); usleep(40_000); ctrl(false)
    print("sent"); exit(0)
}

func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? { var v: CFTypeRef?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func title(_ e: AXUIElement) -> String { (attr(e, kAXTitleAttribute) as? String) ?? "" }

// the app that has keyboard focus (more honest than "frontmost" for a background helper)
// (falls back to the frontmost app - the system-wide focus query comes back empty for a helper launched by open)
let sys = AXUIElementCreateSystemWide()
var pid: pid_t = 0
if let fa = attr(sys, kAXFocusedApplicationAttribute) { AXUIElementGetPid(fa as! AXUIElement, &pid) }
if pid == 0, let fr = NSWorkspace.shared.frontmostApplication { pid = fr.processIdentifier }
if pid == 0 { print("no-front-app"); exit(1) }
let appEl = AXUIElementCreateApplication(pid)
let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
guard let mbRef = attr(appEl, kAXMenuBarAttribute) else { print("no-menu-bar in \(name)"); exit(1) }
guard let editTop = kids(mbRef as! AXUIElement).first(where: { title($0) == "Edit" }) else { print("no-edit-menu in \(name)"); exit(1) }

func close() { for menu in kids(editTop) { AXUIElementPerformAction(menu, kAXCancelAction as CFString) } }
// open the Edit menu and find the dictation item (Brave fills the menu only when it's opened)
func findItem() -> (AXUIElement?, String) {
    AXUIElementPerformAction(editTop, kAXPressAction as CFString)
    var item: AXUIElement? = nil, label = ""
    for _ in 0..<40 {                                                     // up to ~2s for the menu to populate
        for menu in kids(editTop) { for it in kids(menu) {
            // while dictation is listening Brave can show "Cancel Dictation" instead of "Stop" - that also means on
            let t = title(it); if t.hasPrefix("Start Dictation") || t.hasPrefix("Stop Dictation") || (t.hasPrefix("Cancel Dictation") && item == nil) { item = it; label = t } } }
        if item != nil { break }; usleep(50_000)
    }
    return (item, label)
}
// A browser's menu label can be one step stale (it can say "Stop Dictation" while the mic is already off), so the
// truth is whether a microphone is actually running; the label only counts if no mic can be read.
func micRunning() -> Bool? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var sz = UInt32(0); if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz) != 0 { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(sz) / MemoryLayout<AudioObjectID>.size)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz, &ids) != 0 { return nil }
    var sawInput = false
    for d in ids {
        var ia = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var isz = UInt32(0); AudioObjectGetPropertyDataSize(d, &ia, 0, nil, &isz); if isz == 0 { continue }
        sawInput = true
        var ra = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var run = UInt32(0); var rsz = UInt32(MemoryLayout<UInt32>.size)
        if AudioObjectGetPropertyData(d, &ra, 0, nil, &rsz, &run) == 0 && run != 0 { return true }
    }
    return sawInput ? false : nil
}
func isOn(_ label: String) -> Bool { micRunning() ?? !label.hasPrefix("Start") }
// after a press, watch the microphone itself until it lands where we wanted (up to ~1.2s)
func settles(_ want: Bool) -> Bool {
    guard micRunning() != nil else { return true }                       // no mic to read: trust the press
    for _ in 0..<24 { if micRunning() == want { return true }; usleep(50_000) }
    return false
}

var (item, label) = findItem()
guard item != nil else {
    let seen = kids(editTop).flatMap { kids($0) }.map { title($0) }.filter { !$0.isEmpty }
    close(); print("no-dictation-item in \(name) [\(seen.joined(separator: ", "))]"); exit(1) }
if mode == "status" { close(); print(isOn(label) ? "on in \(name)" : "off in \(name)"); exit(0) }
let want = mode == "start"
if isOn(label) == want { close(); print("already-\(want ? "on" : "off") in \(name)"); exit(0) }
// press, then check the mic really changed; one retry with a freshly opened menu, then say it failed
for attempt in 1...2 {
    if attempt > 1 { (item, label) = findItem(); guard item != nil else { close(); break } }
    AXUIElementPerformAction(item!, kAXPressAction as CFString)          // pressing an item also closes the menu
    if settles(want) { print("\(want ? "started" : "stopped") in \(name)\(attempt > 1 ? " (2nd try)" : "")"); exit(0) }
}
print("unchanged: mic still \(want ? "off" : "on") in \(name)"); exit(1)
