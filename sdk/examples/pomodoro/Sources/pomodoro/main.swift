// pomodoro: a focus timer on the Stream Deck through DeckStudio (DeckKit example).
//   pomodoro run [minutes]     the timer itself (writes the status file every second)
//   pomodoro start [minutes]   starts `run` in the background (what the deck key calls)
//   pomodoro stop              stops a running timer
//   pomodoro status [--line|--json]
import DeckKit
import Foundation

let app = "Pomodoro"
let file = DeckPaths.statusFile(app: app)
let args = Array(CommandLine.arguments.dropFirst())
DeckCLI.handleStatusIfRequested(args, file: file)                       // status --line|--json, exit 0
let minutes = args.count > 1 ? max(0.05, Double(args[1]) ?? 25) : 25
var signals: [DispatchSourceSignal] = []

switch args.first {
case "run":
    let status = DeckStatus(app: app)
    for sig in [SIGINT, SIGTERM] {                                      // stop() on Ctrl-C / kill: running:false
        signal(sig, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        s.setEventHandler { status.stop(); exit(0) }
        s.resume(); signals.append(s)
    }
    let end = Date().addingTimeInterval(minutes * 60)
    while case let left = Int(end.timeIntervalSinceNow.rounded(.up)), left > 0 {
        status.set("focus", values: ["left": .init(left), "time": .string(String(format: "%02d:%02d", left / 60, left % 60))])
        Thread.sleep(forTimeInterval: 1)
    }
    status.stop(finalState: "done", values: ["left": 0, "time": "00:00"])
case "start":
    if DeckStatusReader.read(file: file).running { print("already running"); exit(0) }
    let p = Process()
    p.executableURL = Bundle.main.executableURL
    p.arguments = ["run", String(minutes)]
    p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run()                                                          // keeps running after we exit
    print("focus \(Int(minutes)) min")
case "stop":
    let s = DeckStatusReader.read(file: file)
    if s.running, let pid = s.pid { kill(pid, SIGTERM) }
    print("stopped")
default:
    FileHandle.standardError.write(Data("usage: pomodoro run|start [minutes] | stop | status [--line|--json]\n".utf8))
    exit(2)
}
