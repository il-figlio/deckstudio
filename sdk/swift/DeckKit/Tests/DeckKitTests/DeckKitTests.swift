import Foundation
import Testing
@testable import DeckKit

private func tempDir() -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("deckkit-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}
private func mode(_ url: URL) -> Int { ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]) as? NSNumber)?.intValue ?? -1 }
private func json(_ url: URL) -> [String: DeckValue] { DeckValue.parse((try? Data(contentsOf: url)) ?? Data())?.objectValue ?? [:] }

@Suite struct StatusTests {
    @Test func writesContractFieldsAtomically() throws {
        let dir = tempDir().appendingPathComponent("App Support/Tool", isDirectory: true)
        let file = dir.appendingPathComponent("deckstudio-status.json")
        let s = DeckStatus(file: file, heartbeat: 30)
        #expect(s.set("focus", values: ["left": 1500, "phase": "focus"]))
        let o = json(file)
        #expect(o["schema"] == "status/v1")
        #expect(o["state"] == "focus")
        #expect(o["running"] == true)
        #expect(o["pid"]?.intValue == Int(getpid()))
        #expect(o["values"]?["left"] == 1500)
        #expect(String(data: try Data(contentsOf: file), encoding: .utf8)!.contains("\"left\":1500"))   // integers, not 1500.0
        let at = try #require(o["updated_at"]?.stringValue)
        #expect(at.hasSuffix("Z") && at.contains("."))    // ISO 8601 UTC with ms
        #expect(abs(try #require(DeckTime.parse(o["updated_at"])).timeIntervalSinceNow) < 5)
        #expect(mode(file) == 0o600)
        #expect(mode(dir) == 0o700)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".tmp") }
        #expect(leftovers.isEmpty)
        s.stop()
    }

    @Test func updateMergesAndNullRemoves() {
        let file = tempDir().appendingPathComponent("s.json")
        let s = DeckStatus(file: file)
        s.update(["a": 1, "b": "x"])
        #expect(json(file)["state"] == "idle")
        s.update(["a": 2, "b": nil])
        #expect(json(file)["values"] == ["a": 2])
        s.stop()
    }

    @Test func heartbeatRewrites() async throws {
        let file = tempDir().appendingPathComponent("s.json")
        let s = DeckStatus(file: file, heartbeat: 0.2)
        s.set("working")
        let first = try #require(json(file)["updated_at"]?.stringValue)
        try await Task.sleep(nanoseconds: 600_000_000)
        let later = try #require(json(file)["updated_at"]?.stringValue)
        #expect(first != later)
        s.stop()
        let stopped = json(file)
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(json(file)["updated_at"] == stopped["updated_at"])     // heartbeat stopped
        #expect(stopped["running"] == false && stopped["state"] == "off")
    }

    @Test func stateIsOneWord() {
        #expect(DeckStatus.clean("two words\n") == "two-words-")
        #expect(DeckStatus.clean("") == "idle")
        #expect(DeckStatus.clean(String(repeating: "x", count: 99)).count == 40)
    }
}

@Suite struct ReaderTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func write(_ o: DeckValue) -> URL {
        let f = tempDir().appendingPathComponent("s.json")
        try! Data(o.jsonString().utf8).write(to: f)
        return f
    }
    func iso(_ ago: TimeInterval) -> DeckValue { .string(DeckTime.iso(now.addingTimeInterval(-ago))) }

    @Test func missingIsOffNotStale() {
        let r = DeckStatusReader.read(file: URL(fileURLWithPath: "/nonexistent/x.json"), now: now)
        #expect(r.state == "off" && !r.stale && !r.running)
    }
    @Test func freshAlive() {
        let f = write(["state": "focus", "running": true, "pid": 4242, "updated_at": iso(10), "values": ["left": 3]])
        let r = DeckStatusReader.read(file: f, now: now, isAlive: { _ in true })
        #expect(r.state == "focus" && !r.stale && r.values["left"] == 3 && r.pid == 4242)
    }
    @Test func deadPidIsStale() {
        let f = write(["state": "focus", "running": true, "pid": 4242, "updated_at": iso(1)])
        let r = DeckStatusReader.read(file: f, now: now, isAlive: { _ in false })
        #expect(r.state == "off" && r.stale && r.staleReason == "pid" && r.reportedState == "focus")
        #expect(r.document["stale"] == true && r.document["state"] == "off")
    }
    @Test func oldHeartbeatIsStale() {
        let f = write(["state": "focus", "pid": 4242, "updated_at": iso(96)])
        #expect(DeckStatusReader.read(file: f, now: now, isAlive: { _ in true }).staleReason == "heartbeat")
        let g = write(["state": "focus", "pid": 4242, "updated_at": iso(94)])
        #expect(!DeckStatusReader.read(file: g, now: now, isAlive: { _ in true }).stale)
    }
    @Test func heartbeatFormats() {
        let t = now.timeIntervalSince1970 - 5
        for hb: DeckValue in [.number(t), .number(t * 1000), .string(String(Int(t))), .string(DeckTime.iso(now.addingTimeInterval(-5)))] {
            for key in ["updated_at", "updatedAt", "heartbeat"] {
                let f = write(["state": "busy", key: hb])
                #expect(!DeckStatusReader.read(file: f, now: now).stale, "\(key)=\(hb)")
            }
        }
        #expect(DeckTime.parse("2026-11-24T09:41:07Z") != nil)
    }
    @Test func cleanStopIsNeverStaleByAge() {
        // stop(finalState: "done"): running false, an old heartbeat → still "done", not stale (DeckStudio: _state stopped)
        let r = DeckStatusReader.read(file: write(["state": "done", "running": false, "pid": 4242, "updated_at": iso(5000)]), now: now, isAlive: { _ in false })
        #expect(r.state == "done" && !r.stale && r.staleReason == nil)
    }
    @Test func staleFlagAndCleanOff() {
        #expect(DeckStatusReader.read(file: write(["state": "busy", "stale": true, "updated_at": iso(0)]), now: now).staleReason == "flag")
        // a cleanly stopped tool: off, running false, old heartbeat → plain off, not stale
        let r = DeckStatusReader.read(file: write(["state": "off", "running": false, "pid": 4242, "updated_at": iso(500)]), now: now, isAlive: { _ in false })
        #expect(r.state == "off" && !r.stale)
    }
    @Test func roundTripWithWriter() {
        let f = tempDir().appendingPathComponent("s.json")
        let s = DeckStatus(file: f)
        s.set("focus", values: ["left": 10])
        #expect(DeckStatusReader.read(file: f).state == "focus")
        s.stop()
        #expect(DeckStatusReader.read(file: f).state == "off")
        // the writer's pid (us) is alive; a fake dead pid makes it stale
        let dead = DeckStatus(file: f, pid: 999_999)
        dead.set("focus")
        #expect(DeckStatusReader.read(file: f).staleReason == "pid")
        dead.stop()
    }
}

@Suite struct CLITests {
    @Test func statusLineAndJson() {
        let f = tempDir().appendingPathComponent("s.json")
        let s = DeckStatus(file: f)
        s.set("focus", values: ["left": 7])
        #expect(DeckCLI.render(["--line"], file: f) == ("focus", 0))
        let (j, code) = DeckCLI.render(["--json"], file: f)
        #expect(code == 0 && !j.contains("\n") && DeckValue.parse(Data(j.utf8))?["values"]?["left"] == 7)
        #expect(DeckCLI.render([], file: f).output.contains("\n"))
        #expect(DeckCLI.render(["--nope"], file: f).code == 2)
        s.stop()
        #expect(DeckCLI.render(["--line"], file: URL(fileURLWithPath: "/nonexistent")) == ("off", 0))
    }
}

@Suite struct TokenTests {
    @Test func createReadVerify() throws {
        let file = tempDir().appendingPathComponent("sub/control-token")
        let t = DeckControlToken(file: file)
        #expect(t.read() == nil && !t.verify("x"))
        let tok = try t.ensure()
        #expect(DeckControlToken.isWellFormed(tok))
        #expect(try t.ensure() == tok)
        #expect(mode(file) == 0o600)
        #expect(t.verify(tok))
        #expect(!t.verify(String(tok.dropLast()) + (tok.hasSuffix("0") ? "1" : "0")))
        #expect(!t.verify(nil) && !t.verify(tok.uppercased()))
        let rotated = try t.rotate()
        #expect(rotated != tok && !t.verify(tok))
    }
    @Test func looseFileTrustsNothing() throws {
        let file = tempDir().appendingPathComponent("control-token")
        let t = DeckControlToken(file: file)
        let tok = try t.ensure()
        chmod(file.path, 0o644)
        #expect(t.read() == nil && !t.verify(tok))
    }
    @Test func urls() throws {
        let t = DeckControlToken(file: tempDir().appendingPathComponent("control-token"))
        let url = try t.appendToken(to: URL(string: "pomodoro://start?minutes=25&token=forged")!)
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        #expect(q.filter { $0.name == "token" }.count == 1 && q.contains { $0.name == "minutes" })
        #expect(t.verify(url: url))
        #expect(!t.verify(url: URL(string: "pomodoro://start")!))
        #expect(!t.verify(url: URL(string: "pomodoro://start?token=" + String(repeating: "a", count: 64))!))
        #expect(DeckControlToken.constantTimeEquals("abc", "abc") && !DeckControlToken.constantTimeEquals("abc", "abd") && !DeckControlToken.constantTimeEquals("ab", "abc"))
    }
}

@Suite struct ManifestTests {
    func sample() -> DeckManifest {
        var m = DeckManifest(id: "pomodoro", name: "Pomodoro", version: "1.0.0", description: "A focus timer")
        m.icon = .glyph("timer")
        m.detect = .init(bin: ["pomodoro", "~/.local/bin/pomodoro"])
        m.status = .file("~/Library/Application Support/Pomodoro/deckstudio-status.json")
        m.values = ["state": .spec(path: "$.state", default: "off", stale: "off"), "left": "$.values.left"]
        m.actions = ["start": .cmd(["$bin", "start", "{minutes}"], title: "Start", params: ["minutes"]), "site": .url("https://example.com")]
        m.templates = .init(keys: ["timer": ["title": "Pomodoro", "template": ["label": "{self.left}", "onPress": ["type": "plugin", "action": "start"]]]])
        return m
    }
    @Test func encodesAndRoundTrips() throws {
        let m = sample()
        #expect(m.check().isEmpty)
        let data = try m.jsonData()
        let o = try #require(DeckValue.parse(data)?.objectValue)
        #expect(o["deckstudio"] == "plugin/v1")
        #expect(o["values"]?["left"] == "$.values.left")
        #expect(o["values"]?["state"]?["stale"] == "off")
        #expect(o["actions"]?["start"]?["cmd"] == ["$bin", "start", "{minutes}"])
        #expect(o["icon"] == ["glyph": "timer"])
        #expect(o["status"]?["stale"] == 95)
        #expect(try JSONDecoder().decode(DeckManifest.self, from: data) == m)
        let dir = tempDir()
        let file = try m.write(to: dir)
        #expect(file.lastPathComponent == "deckstudio.json")
        #expect(try DeckManifest.read(from: dir) == m)
    }
    @Test func checkCatchesCommonMistakes() {
        var m = DeckManifest(id: "Bad Id", name: "x", version: "1")
        m.values = ["Up": "nope"]
        m.actions = ["sh": .cmd(["/bin/zsh", "-c", "x"]), "go": .cmd(["$bin"]), "link": .url("myapp://x"), "js": .url("javascript:alert(1)")]
        m.status = .init(cmd: ["a"], file: "/x")
        let e = m.check().joined(separator: "\n")
        for needle in ["id:", "values.Up", "bad path", "zsh needs permissions.shell", "\"$bin\" needs detect.bin", "myapp: links need", "not an openable", "exactly one"] {
            #expect(e.contains(needle), "\(needle) in \(e)")
        }
    }
    @Test func settingsValueTestsAndDetachRoundTrip() throws {
        var m = DeckManifest(id: "polt", name: "Polt", version: "1.0.0")
        m.detect = .init(bin: ["polt"])
        m.settings = ["config": .init(default: "~/p.json", title: "Config"), "target": .init(default: "app"), "n": .init(type: "number", default: 3)]
        m.status = .cmd(["$bin", "status", "--config", "{settings.config}"])
        m.values = ["hot": .spec(path: "$.pct", atLeast: 80), "build": .spec(path: "$['{settings.target}'].status", equals: "failed", then: "bad", else: "")]
        m.actions = ["build": .cmd(["$bin", "build", "{settings.target}"], toast: true, timeout: 1200, detach: true)]
        #expect(m.check().isEmpty, "\(m.check())")
        let data = try m.jsonData()
        let o = try #require(DeckValue.parse(data)?.objectValue)
        #expect(o["settings"]?["config"]?["default"] == "~/p.json")
        #expect(o["values"]?["hot"]?["atLeast"] == 80)
        #expect(o["values"]?["build"]?["else"] == "")
        #expect(o["actions"]?["build"]?["detach"] == true && o["actions"]?["build"]?["timeout"] == 1200)
        #expect(try JSONDecoder().decode(DeckManifest.self, from: data) == m)
        var bad = m
        bad.settings = ["n": .init(type: "number", default: "x"), "Bad": .init(), "d": .init(type: "date")]
        bad.values?["x"] = .spec(path: "$.a", then: "on")
        bad.actions?["u"] = .url("https://x.com"); bad.actions?["u"]?.detach = true
        let e = bad.check().joined(separator: "\n")
        for needle in ["settings.n.default: must be a number", "settings.Bad", "settings.d.type", "values.x: then / else need a test", "actions.u.detach", "{settings.config}: \"config\" isn't declared", "{settings.target}"] {
            #expect(e.contains(needle), "\(needle) in \(e)")
        }
    }
}
