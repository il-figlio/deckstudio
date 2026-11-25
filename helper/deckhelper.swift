// deckhelper: the small native side of DeckStudio.
//   deckhelper watch-apps            stream the frontmost app as JSON lines (NSWorkspace notifications)
//   deckhelper front                 print the frontmost app once
//   deckhelper apps                  list running regular apps
//   deckhelper audio list            list audio devices with input/output flags and defaults
//   deckhelper audio set-input <uid> / set-output <uid>
//   deckhelper audio mute-input [on|off|toggle] / input-muted
//   deckhelper camera-in-use         "1" if any camera is running somewhere, else "0"
//   deckhelper icon <bundle-id> <out.png> [size]   render an app's icon to PNG
//   deckhelper capture-access [request]  Screen Recording / Accessibility state of DeckStudio's TCC "responsible" app,
//                                        as JSON. Never prompts unless "request" is given (then asks macOS once).
//   deckhelper pb-count               {"count": NSPasteboard changeCount, "image": whether it holds an image}
import AppKit
import ApplicationServices
import CoreAudio
import CoreMediaIO
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: Any) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { print(s) }
}
func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }

func appInfo(_ a: NSRunningApplication?) -> [String: Any] {
    ["bundleId": a?.bundleIdentifier ?? "", "name": a?.localizedName ?? "", "pid": a?.processIdentifier ?? 0]
}

// MARK: audio
func prop(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ el: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: el)
}
func deviceIDs() -> [AudioDeviceID] {
    var addr = prop(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids
}
func string(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
    var addr = prop(sel)
    var v: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v) == noErr, let s = v?.takeRetainedValue() else { return "" }
    return s as String
}
func channels(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var addr = prop(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(buf.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}
func defaultDevice(_ sel: AudioObjectPropertySelector) -> AudioDeviceID {
    var addr = prop(sel)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}
func setDefault(_ sel: AudioObjectPropertySelector, uid: String) {
    guard let dev = deviceIDs().first(where: { string($0, kAudioDevicePropertyDeviceUID) == uid }) else { fail("no device with uid \(uid)") }
    var addr = prop(sel)
    var id = dev
    let st = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &id)
    if st != noErr { fail("could not set default device (\(st))") }
}
func inputMuted(_ dev: AudioDeviceID) -> Bool? {
    var addr = prop(kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput)
    guard AudioObjectHasProperty(dev, &addr) else { return nil }
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr else { return nil }
    return v != 0
}
// Devices without a hardware mute are "muted" by zeroing their input volume; the old volume is remembered.
// It lives in DeckStudio's folder ($DECKSTUDIO_HOME, else ~/.deckstudio), owner-only like everything there.
let deckHome: URL = {
    if let h = ProcessInfo.processInfo.environment["DECKSTUDIO_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".deckstudio")
}()
let volStore = deckHome.appendingPathComponent("mic-volume")
/// Write `text` to `url` as 0600 from the start (a temp file created 0600, then renamed over it).
func writePrivate(_ text: String, to url: URL) {
    let fm = FileManager.default
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    guard fm.createFile(atPath: tmp.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else { return }
    if rename(tmp.path, url.path) != 0 { unlink(tmp.path) }
}
// Volume may live on the main element or only on individual channels (element 1…n).
func volumeElements(_ dev: AudioDeviceID) -> [AudioObjectPropertyElement] {
    var els: [AudioObjectPropertyElement] = []
    for el in [kAudioObjectPropertyElementMain] + (1...max(1, UInt32(channels(dev, kAudioDevicePropertyScopeInput)))).map({ $0 }) {
        var addr = prop(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, el)
        if AudioObjectHasProperty(dev, &addr) { els.append(el); if el == kAudioObjectPropertyElementMain { break } }
    }
    return els
}
func inputVolume(_ dev: AudioDeviceID) -> Float32? {
    guard let el = volumeElements(dev).first else { return nil }
    var addr = prop(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, el)
    var v: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr else { return nil }
    return v
}
func setInputVolume(_ dev: AudioDeviceID, _ v: Float32) -> Bool {
    var ok = false
    for el in volumeElements(dev) {
        var addr = prop(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, el)
        var settable: DarwinBoolean = false
        guard AudioObjectIsPropertySettable(dev, &addr, &settable) == noErr, settable.boolValue else { continue }
        var x = v
        if AudioObjectSetPropertyData(dev, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &x) == noErr { ok = true }
    }
    return ok
}
func muteSettable(_ dev: AudioDeviceID) -> Bool {
    var addr = prop(kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput)
    var settable: DarwinBoolean = false
    return AudioObjectHasProperty(dev, &addr) && AudioObjectIsPropertySettable(dev, &addr, &settable) == noErr && settable.boolValue
}
func micMuted(_ dev: AudioDeviceID) -> Bool {
    if muteSettable(dev), let m = inputMuted(dev) { return m }
    return (inputVolume(dev) ?? 1) < 0.001
}
func setMicMuted(_ dev: AudioDeviceID, _ on: Bool) {
    var addr = prop(kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput)
    if muteSettable(dev) {
        var v: UInt32 = on ? 1 : 0
        if AudioObjectSetPropertyData(dev, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr { return }
    }
    if on {
        if let cur = inputVolume(dev), cur > 0.001 { writePrivate(String(cur), to: volStore) }
        if !setInputVolume(dev, 0) { fail("this microphone can't be muted from software") }
    } else {
        let saved = Float32((try? String(contentsOf: volStore, encoding: .utf8)) ?? "") ?? 0.75
        if !setInputVolume(dev, saved) { fail("this microphone can't be unmuted from software") }
    }
}

// MARK: camera
func cameraInUse() -> Bool {
    var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
                                         mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                         mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, &size) == 0 else { return false }
    var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    var used: UInt32 = 0
    CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, size, &used, &ids)
    for id in ids {
        var a = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
                                          mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeWildcard),
                                          mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementWildcard))
        var running: UInt32 = 0
        var u: UInt32 = 0
        if CMIOObjectGetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &u, &running) == 0, running != 0 { return true }
    }
    return false
}

// MARK: key synthesis (push-to-talk). Returns an error message, or nil.
func postCombo(_ combo: String, down: Bool) -> String? {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    let modFlags: [String: (CGEventFlags, CGKeyCode)] = [
        "cmd": (.maskCommand, 55), "command": (.maskCommand, 55), "shift": (.maskShift, 56), "opt": (.maskAlternate, 58),
        "option": (.maskAlternate, 58), "alt": (.maskAlternate, 58), "ctrl": (.maskControl, 59), "control": (.maskControl, 59),
        "rcmd": (.maskCommand, 54), "ropt": (.maskAlternate, 61), "rshift": (.maskShift, 60), "rctrl": (.maskControl, 62), "fn": (.maskSecondaryFn, 63)]
    let named: [String: CGKeyCode] = ["space": 49, "return": 36, "tab": 48, "escape": 53, "esc": 53, "grave": 50, "f13": 105, "f14": 107, "f15": 113,
        "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    // ANSI virtual keycodes, index = keycode (spaces are unused codes)
    let letters = Array("asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.")
    func code(_ k: String) -> CGKeyCode? {
        if let c = named[k] { return c }
        if k.count == 1, let i = letters.firstIndex(of: Character(k)), letters[i] != " " { return CGKeyCode(i) }
        return nil
    }
    var flags: CGEventFlags = []
    var mods: [CGKeyCode] = []
    var main: CGKeyCode? = nil
    for p in parts { if let m = modFlags[p] { flags.insert(m.0); mods.append(m.1) } else if let c = code(p) { main = c } else { return "unknown key \(p)" } }
    guard AXIsProcessTrusted() else { return "needs Accessibility permission for the app running DeckStudio" }
    let src = CGEventSource(stateID: .hidSystemState)
    func post(_ k: CGKeyCode, _ d: Bool, _ f: CGEventFlags) { let e = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: d); e?.flags = f; e?.post(tap: .cghidEventTap) }
    if main == nil {
        for m in (down ? mods : mods.reversed()) {
            let e = CGEvent(keyboardEventSource: src, virtualKey: m, keyDown: down)
            e?.type = .flagsChanged
            e?.flags = down ? flags : []
            e?.post(tap: .cghidEventTap)
        }
    } else if down {
        for m in mods { post(m, true, flags) }
        post(main!, true, flags)
    } else {
        post(main!, false, flags)
        for m in mods.reversed() { post(m, false, []) }
    }
    return nil
}

// MARK: capture permissions
// TCC charges a permission to the "responsible" process: the app that (indirectly) launched DeckStudio,
// e.g. Terminal / iTerm / an agent host, not node itself. Report which one, so the user knows what to allow.
func responsibleApp() -> [String: Any] {
    typealias Resp = @convention(c) (pid_t) -> pid_t
    var pid = getpid()
    if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") {
        pid = unsafeBitCast(sym, to: Resp.self)(getpid())
    }
    var buf = [CChar](repeating: 0, count: 4096)
    proc_pidpath(pid, &buf, 4096)
    let exe = String(cString: buf)
    // innermost enclosing .app bundle of the executable
    var url = URL(fileURLWithPath: exe)
    var app: URL? = nil
    while url.path != "/" { if url.pathExtension == "app" { app = url; break }; url = url.deletingLastPathComponent() }
    let b = app.flatMap { Bundle(url: $0) }
    let name = (b?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? (b?.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? app?.deletingPathExtension().lastPathComponent ?? URL(fileURLWithPath: exe).lastPathComponent
    return ["pid": pid, "path": app?.path ?? exe, "name": name, "bundleId": b?.bundleIdentifier ?? ""]
}

// MARK: main
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "front":
    emit(appInfo(NSWorkspace.shared.frontmostApplication))
case "watch-apps":
    emit(appInfo(NSWorkspace.shared.frontmostApplication))
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
        emit(appInfo(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication))
    }
    // exit when the parent (DeckStudio) goes away
    let parent = getppid()
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in if getppid() != parent { exit(0) } }
    RunLoop.main.run()
case "apps":
    emit(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(appInfo))
case "audio":
    let sub = args.dropFirst().first ?? "list"
    switch sub {
    case "list":
        let din = defaultDevice(kAudioHardwarePropertyDefaultInputDevice), dout = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        emit(deviceIDs().map { id -> [String: Any] in
            let ins = channels(id, kAudioDevicePropertyScopeInput), outs = channels(id, kAudioDevicePropertyScopeOutput)
            return ["uid": string(id, kAudioDevicePropertyDeviceUID), "name": string(id, kAudioObjectPropertyName),
                    "input": ins > 0, "output": outs > 0, "defaultInput": id == din, "defaultOutput": id == dout,
                    "inputMuted": ins > 0 ? micMuted(id) : false]
        }.filter { ($0["input"] as! Bool) || ($0["output"] as! Bool) })
    case "set-input":
        guard args.count > 2 else { fail("uid?") }
        setDefault(kAudioHardwarePropertyDefaultInputDevice, uid: args[2])
    case "set-output":
        guard args.count > 2 else { fail("uid?") }
        setDefault(kAudioHardwarePropertyDefaultOutputDevice, uid: args[2])
    case "input-muted": print(micMuted(defaultDevice(kAudioHardwarePropertyDefaultInputDevice)) ? "1" : "0")
    case "mute-input":
        let dev = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let mode = args.count > 2 ? args[2] : "toggle"
        setMicMuted(dev, mode == "on" ? true : mode == "off" ? false : !micMuted(dev))
        print(micMuted(dev) ? "1" : "0")
    default: fail("audio: list | set-input <uid> | set-output <uid> | input-muted | mute-input [on|off|toggle]")
    }
case "keydown", "keyup":
    guard args.count > 1 else { fail("\(args[0]) <combo>, e.g. opt or ctrl+space or fn") }
    if let err = postCombo(args[1], down: args[0] == "keydown") { fail(err) }
case "keyd":
    // Long-lived push-to-talk daemon: reads "down <combo>" / "up <combo>" lines and applies them
    // strictly in order. Anything still held is released when stdin closes (DeckStudio exited).
    var held: [String: Int] = [:]
    while let line = readLine() {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { continue }
        let (cmd, combo) = (parts[0], parts[1])
        if cmd == "down" {
            if let err = postCombo(combo, down: true) { print("error " + err); continue }
            held[combo, default: 0] += 1
        } else if cmd == "up" {
            if held[combo, default: 0] > 0 { held[combo]! -= 1 }
            if let err = postCombo(combo, down: false) { print("error " + err); continue }
        } else if cmd == "release-all" {
            for (c, n) in held where n > 0 { _ = postCombo(c, down: false) }
            held.removeAll()
        }
        print("ok")
    }
    for (c, n) in held where n > 0 { _ = postCombo(c, down: false) }
case "installed":
    // which of these bundle ids (or app names) are installed: {"id": true|false}
    var out: [String: Bool] = [:]
    for id in args.dropFirst() {
        if id.contains(".") { out[id] = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) != nil }
        else { out[id] = NSWorkspace.shared.fullPath(forApplication: id) != nil }
    }
    emit(out)
case "capture-access":
    var screen = CGPreflightScreenCaptureAccess()
    if !screen && args.dropFirst().first == "request" { screen = CGRequestScreenCaptureAccess() }
    emit(["screen": screen, "accessibility": AXIsProcessTrusted(), "displays": NSScreen.screens.count, "responsible": responsibleApp()])
case "pb-count":
    let pb = NSPasteboard.general
    let image = (pb.types ?? []).contains { [NSPasteboard.PasteboardType.png, .tiff].contains($0) || $0.rawValue == "public.jpeg" }
    emit(["count": pb.changeCount, "image": image])
case "camera-in-use":
    print(cameraInUse() ? "1" : "0")
case "icon":
    guard args.count >= 3 else { fail("icon <bundle-id> <out.png> [size]") }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: args[1]) else { fail("app not found: \(args[1])") }
    guard let px = Int(args.count > 3 ? args[3] : "256"), (16...1024).contains(px) else { fail("icon: size must be a whole number from 16 to 1024") }
    let size = CGFloat(px)
    let img = NSWorkspace.shared.icon(forFile: url.path)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
default:
    fail("usage: deckhelper watch-apps | front | apps | audio … | camera-in-use | capture-access [request] | pb-count | icon <bundle-id> <out.png>")
}
