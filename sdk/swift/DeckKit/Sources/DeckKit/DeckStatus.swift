import Foundation

/// Writes the status file DeckStudio reads (`"status": { "file": … }`) and keeps its heartbeat fresh.
///
/// The file is one JSON object, rewritten atomically (temp file 0600 + rename) in a 0700 folder:
///
/// ```json
/// {"schema":"status/v1","state":"focus","running":true,"pid":4242,
///  "since":"2026-11-24T09:41:07.120Z","updated_at":"2026-11-24T09:41:37.120Z","values":{"remaining":1470}}
/// ```
///
/// - `state`: one short word (`idle`, `working`, …). `off` means "not running".
/// - `updated_at`: ISO 8601 UTC, rewritten at least every `heartbeat` seconds (default 30) while running.
/// - `pid` + `running`: DeckStudio treats the status as stale as soon as that process is gone, so a crash never shows as busy.
/// - `values`: your numbers / words. Map them in the manifest with `$.values.<name>`.
///
/// Never put user content (document names, text, paths, URLs) in the status: any local process can read it,
/// and keys show it on a physical device.
public final class DeckStatus: @unchecked Sendable {
    public static let schema = "status/v1"
    /// Rewrite at least this often while running.
    public static let defaultHeartbeat: TimeInterval = 30
    /// A reader treats a status older than this as stale (≥ 3 heartbeats + slack). Put the same number in the manifest's `status.stale`.
    public static let staleAfter: TimeInterval = 95

    public let file: URL
    public let pid: Int32
    public let heartbeat: TimeInterval
    /// The last write error, if any. Writing is best-effort: a tool keeps working without its status.
    public private(set) var lastError: Error?

    private let lock = NSLock()
    private let now: () -> Date
    private var state: String?
    private var since: Date?
    private var values: [String: DeckValue] = [:]
    private var running = false
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "deckkit.status.heartbeat")

    /// Status at `~/Library/Application Support/<app>/deckstudio-status.json`.
    public convenience init(app: String, heartbeat: TimeInterval = DeckStatus.defaultHeartbeat) {
        self.init(file: DeckPaths.statusFile(app: app), heartbeat: heartbeat)
    }

    public init(file: URL, heartbeat: TimeInterval = DeckStatus.defaultHeartbeat, pid: Int32 = getpid(), now: @escaping () -> Date = Date.init) {
        self.file = file
        self.pid = pid
        self.heartbeat = max(0.05, min(heartbeat, 30))
        self.now = now
    }

    deinit { timer?.cancel() }

    /// Sets the state word (and, when given, replaces all values), writes the file and starts the heartbeat.
    /// `since` changes only when the state does.
    @discardableResult
    public func set(_ state: String, values: [String: DeckValue]? = nil) -> Bool {
        let word = DeckStatus.clean(state)
        lock.lock()
        if word != self.state { since = now() }
        self.state = word
        if let values { self.values = values }
        running = word != "off"
        let doc = snapshotLocked()
        lock.unlock()
        let ok = write(doc)
        running ? startHeartbeat() : stopHeartbeat()
        return ok
    }

    /// Merges values (a `.null` removes one) and writes. Before the first `set`, the state is `idle`.
    @discardableResult
    public func update(_ values: [String: DeckValue]) -> Bool {
        lock.lock()
        for (k, v) in values { if v == .null { self.values.removeValue(forKey: k) } else { self.values[k] = v } }
        let first = state == nil
        lock.unlock()
        if first { return set("idle") }
        lock.lock(); let doc = snapshotLocked(); lock.unlock()
        return write(doc)
    }

    /// The final write: `running: false`, the heartbeat stops. DeckStudio then reads `{id._state}` as `stopped` with this
    /// state and these values, however old the heartbeat gets, so a clean exit never looks like a crash (`stale`).
    @discardableResult
    public func stop(finalState: String = "off", values: [String: DeckValue]? = nil) -> Bool {
        stopHeartbeat()
        lock.lock()
        let word = DeckStatus.clean(finalState)
        if word != state { since = now() }
        state = word
        if let values { self.values = values }
        running = false
        let doc = snapshotLocked()
        lock.unlock()
        return write(doc)
    }

    /// Rewrites the file now (the heartbeat calls this).
    @discardableResult
    public func write() -> Bool {
        lock.lock(); let doc = snapshotLocked(); lock.unlock()
        return write(doc)
    }

    /// The document as it would be written now.
    public func snapshot() -> DeckValue { lock.lock(); defer { lock.unlock() }; return snapshotLocked() }

    private func snapshotLocked() -> DeckValue {
        var o: [String: DeckValue] = [
            "schema": .string(DeckStatus.schema),
            "state": .string(state ?? "idle"),
            "running": .bool(running),
            "pid": .number(Double(pid)),
            "updated_at": .string(DeckTime.iso(now())),
            "values": .object(values),
        ]
        if let since { o["since"] = .string(DeckTime.iso(since)) }
        return .object(o)
    }

    private func write(_ doc: DeckValue) -> Bool {
        do {
            try DeckFS.writeAtomic(Data((doc.jsonString() + "\n").utf8), to: file)
            lock.lock(); lastError = nil; lock.unlock()
            return true
        } catch {
            lock.lock(); lastError = error; lock.unlock()
            return false
        }
    }

    private func startHeartbeat() {
        lock.lock(); defer { lock.unlock() }
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + heartbeat, repeating: heartbeat, leeway: .milliseconds(100))
        t.setEventHandler { [weak self] in self?.write() }
        t.resume()
        timer = t
    }

    private func stopHeartbeat() {
        lock.lock(); let t = timer; timer = nil; lock.unlock()
        t?.cancel()
    }

    /// One word: control characters and spaces become `-`, at most 40 characters.
    static func clean(_ s: String) -> String {
        let w = String(s.unicodeScalars.map { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) ? "-" : Character($0) }).prefix(40)
        return w.isEmpty ? "idle" : String(w)
    }
}

/// The status as a reader should see it.
public struct DeckStatusSnapshot: Equatable, Sendable {
    /// The state to show: the file's state, or `offState` when missing / stale.
    public var state: String
    /// What the file said, before staleness was applied (nil when there is no readable file).
    public var reportedState: String?
    public var running: Bool
    public var pid: Int32?
    public var updatedAt: Date?
    public var since: Date?
    public var values: [String: DeckValue]
    /// The file exists but its process is gone, its heartbeat is too old, or it says `"stale": true`.
    public var stale: Bool
    /// Why it is stale (`pid`, `heartbeat`, `flag`), nil when fresh.
    public var staleReason: String?
    /// The whole document as read (with `state`, `running` and `stale` replaced when stale): what `status --json` prints.
    public var document: DeckValue
}

/// Reads a status file with the same staleness rules as DeckStudio, for `mytool status --line|--json`.
public enum DeckStatusReader {
    /// - Parameters:
    ///   - staleAfter: seconds; a heartbeat (`updated_at` / `updatedAt` / `heartbeat`, ISO or epoch s/ms) older than this is stale.
    ///   - offState: the word for "not running" (missing file, or stale).
    public static func read(file: URL, staleAfter: TimeInterval = DeckStatus.staleAfter, offState: String = "off",
                            now: Date = Date(), isAlive: (Int32) -> Bool = DeckStatusReader.alive) -> DeckStatusSnapshot {
        let off = DeckStatusSnapshot(state: offState, reportedState: nil, running: false, pid: nil, updatedAt: nil, since: nil, values: [:],
                                     stale: false, staleReason: nil,
                                     document: ["schema": .string(DeckStatus.schema), "state": .string(offState), "running": false])
        guard let data = FileManager.default.contents(atPath: file.path), data.count <= 1 << 20,
              let doc = DeckValue.parse(data), var o = doc.objectValue else { return off }
        let state = o["state"]?.stringValue ?? o["status"]?.stringValue ?? offState
        let pid = o["pid"]?.intValue.flatMap { Int32(exactly: $0) }
        let hb = DeckTime.parse(o["updated_at"] ?? o["updatedAt"] ?? o["heartbeat"])
        let running = o["running"]?.boolValue ?? (state != offState)
        var reason: String?
        if o["stale"]?.boolValue == true { reason = "flag" }
        else if running, let pid, pid > 1, !isAlive(pid) { reason = "pid" }
        // a clean stop (`running: false`, any final state) is never stale by age: DeckStudio reads it as `_state: stopped`
        else if running, state != offState, hb.map({ now.timeIntervalSince($0) > staleAfter }) ?? true { reason = "heartbeat" }
        var snap = DeckStatusSnapshot(state: state, reportedState: state, running: running, pid: pid, updatedAt: hb,
                                      since: DeckTime.parse(o["since"]), values: o["values"]?.objectValue ?? [:],
                                      stale: reason != nil, staleReason: reason, document: doc)
        if reason != nil {
            snap.state = offState; snap.running = false
            o["state"] = .string(offState); o["running"] = false; o["stale"] = true
            snap.document = .object(o)
        }
        return snap
    }

    public static func read(app: String, staleAfter: TimeInterval = DeckStatus.staleAfter, offState: String = "off") -> DeckStatusSnapshot {
        read(file: DeckPaths.statusFile(app: app), staleAfter: staleAfter, offState: offState)
    }

    /// Our tool runs as this user, so EPERM (another user's process that reused the pid) is not it.
    public static func alive(_ pid: Int32) -> Bool { pid > 0 && kill(pid, 0) == 0 }
}
