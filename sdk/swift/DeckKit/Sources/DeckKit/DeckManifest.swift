import Foundation

/// `deckstudio.json` (plugin/v1) as a Codable struct. Build one in code and `write(to:)` it next to your tool, or decode
/// an existing one. Spec: DeckStudio `docs/PLUGINS.md`; the authoritative validator is DeckStudio's `validateManifest`
/// (`deckctl plugin validate`). `check()` here catches the common mistakes offline.
///
/// ```swift
/// var m = DeckManifest(id: "pomodoro", name: "Pomodoro", version: "1.0.0")
/// m.detect = .init(bin: ["pomodoro", "~/.local/bin/pomodoro"])
/// m.status = .file("~/Library/Application Support/Pomodoro/deckstudio-status.json")
/// m.values = ["state": .spec(path: "$.state", stale: "off"), "left": "$.values.left"]
/// m.actions = ["start": .cmd(["$bin", "start"], title: "Start")]
/// try m.write(to: URL(fileURLWithPath: "."))
/// ```
public struct DeckManifest: Codable, Equatable, Sendable {
    public static let schemaVersion = "plugin/v1"
    public static let fileName = "deckstudio.json"
    public static let reservedIds: Set<String> = ["self", "plugin", "plugins", "deckstudio", "deck", "page", "value", "out", "settings"]

    public var schemaURL: String?
    public var deckstudio: String = DeckManifest.schemaVersion
    public var id: String
    public var name: String
    public var version: String
    public var author: String?
    public var homepage: String?
    public var description: String?
    public var icon: Icon?
    public var detect: Detect?
    public var install: Install?
    public var status: Transport?
    public var bots: Transport?
    public var values: [String: Value]?
    public var actions: [String: Action]?
    /// What the user can change in DeckStudio's editor (saved in their profile, never in the manifest):
    /// `{settings.<name>}` in your argv / urls / status file / value paths, `{<id>.settings.<name>}` on keys.
    public var settings: [String: Setting]?
    public var templates: Templates?
    public var permissions: Permissions?

    enum CodingKeys: String, CodingKey {
        case schemaURL = "$schema", deckstudio, id, name, version, author, homepage, description, icon, detect, install, status, bots, values, actions, settings, templates, permissions
    }

    public init(id: String, name: String, version: String, description: String? = nil) {
        self.id = id; self.name = name; self.version = version; self.description = description
    }

    // MARK: parts

    public enum Icon: Codable, Equatable, Sendable {
        /// A png/svg file in the plugin folder.
        case file(String)
        /// A Carbon icon name.
        case glyph(String)
        /// A DeckStudio logo name.
        case logo(String)
        public init(from d: Decoder) throws {
            if let s = try? d.singleValueContainer().decode(String.self) { self = .file(s); return }
            let o = try d.singleValueContainer().decode([String: String].self)
            if let g = o["glyph"] { self = .glyph(g) } else if let l = o["logo"] { self = .logo(l) } else { throw DeckError.invalid("icon") }
        }
        public func encode(to e: Encoder) throws {
            var c = e.singleValueContainer()
            switch self {
            case .file(let f): try c.encode(f)
            case .glyph(let g): try c.encode(["glyph": g])
            case .logo(let l): try c.encode(["logo": l])
            }
        }
    }

    public struct Detect: Codable, Equatable, Sendable {
        public var bundle: [String]?
        public var bin: [String]?
        public var paths: [String]?
        public init(bundle: [String]? = nil, bin: [String]? = nil, paths: [String]? = nil) { self.bundle = bundle; self.bin = bin; self.paths = paths }
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            func list(_ k: CodingKeys) -> [String]? { (try? c.decode([String].self, forKey: k)) ?? (try? c.decode(String.self, forKey: k)).map { [$0] } }
            bundle = list(.bundle); bin = list(.bin); paths = list(.paths)
        }
    }

    public struct Install: Codable, Equatable, Sendable {
        public var brew: String?
        public var url: String?
        public var note: String?
        public init(brew: String? = nil, url: String? = nil, note: String? = nil) { self.brew = brew; self.url = url; self.note = note }
    }

    /// argv (no shell) or a shell string (needs `permissions.shell` and the user's grant).
    public enum Command: Codable, Equatable, Sendable, ExpressibleByArrayLiteral {
        case argv([String])
        case shell(String)
        public init(arrayLiteral elements: String...) { self = .argv(elements) }
        public init(from d: Decoder) throws {
            let c = try d.singleValueContainer()
            if let a = try? c.decode([String].self) { self = .argv(a) } else { self = .shell(try c.decode(String.self)) }
        }
        public func encode(to e: Encoder) throws {
            var c = e.singleValueContainer()
            switch self { case .argv(let a): try c.encode(a); case .shell(let s): try c.encode(s) }
        }
    }

    /// One status (or bots) source. Times are seconds.
    public struct Transport: Codable, Equatable, Sendable {
        public var cmd: Command?
        public var http: String?
        public var file: String?
        public var interval: Double?
        public var timeout: Double?
        public var stale: Double?
        public var parse: String?
        public init(cmd: Command? = nil, http: String? = nil, file: String? = nil, interval: Double? = nil, timeout: Double? = nil, stale: Double? = nil, parse: String? = nil) {
            self.cmd = cmd; self.http = http; self.file = file; self.interval = interval; self.timeout = timeout; self.stale = stale; self.parse = parse
        }
        /// A status file written by `DeckStatus`. `stale` defaults to `DeckStatus.staleAfter` (95 s), matching `DeckStatusReader`.
        public static func file(_ path: String, interval: Double? = nil, stale: Double? = DeckStatus.staleAfter) -> Transport { .init(file: path, interval: interval, stale: stale) }
        /// A command printing the status (e.g. `["$bin", "status", "--json"]`).
        public static func cmd(_ argv: [String], interval: Double? = nil, timeout: Double? = nil, stale: Double? = nil) -> Transport { .init(cmd: .argv(argv), interval: interval, timeout: timeout, stale: stale) }
        /// A loopback http(s) URL returning the status.
        public static func http(_ url: String, interval: Double? = nil, stale: Double? = nil) -> Transport { .init(http: url, interval: interval, stale: stale) }
    }

    /// A template value: a JSONPath-lite string (`$.values.left`) or `{ path, default, stale, round, map }`, optionally with
    /// tests (`above`, `below`, `atLeast`, `atMost`, `equals`): then it shows `then` ("on") when every test holds, else `else` ("").
    public enum Value: Codable, Equatable, Sendable, ExpressibleByStringLiteral {
        case path(String)
        case spec(Spec)
        public struct Spec: Codable, Equatable, Sendable {
            public var path: String
            public var `default`: DeckValue?
            public var stale: DeckValue?
            public var round: Int?
            public var map: [String: DeckValue]?
            public var above: Double?
            public var below: Double?
            public var atLeast: Double?
            public var atMost: Double?
            public var equals: DeckValue?
            public var then: DeckValue?
            public var `else`: DeckValue?
            public init(path: String, default: DeckValue? = nil, stale: DeckValue? = nil, round: Int? = nil, map: [String: DeckValue]? = nil,
                        above: Double? = nil, below: Double? = nil, atLeast: Double? = nil, atMost: Double? = nil, equals: DeckValue? = nil,
                        then: DeckValue? = nil, else otherwise: DeckValue? = nil) {
                self.path = path; self.default = `default`; self.stale = stale; self.round = round; self.map = map
                self.above = above; self.below = below; self.atLeast = atLeast; self.atMost = atMost; self.equals = equals
                self.then = then; self.else = otherwise
            }
            /// Has at least one test (above / below / atLeast / atMost / equals).
            public var hasTest: Bool { above != nil || below != nil || atLeast != nil || atMost != nil || equals != nil }
        }
        public init(stringLiteral v: String) { self = .path(v) }
        /// e.g. `.spec(path: "$.pct", atLeast: 80)` → "on" from 80 (a lamp: `led: "{id.hot}"`).
        public static func spec(path: String, default: DeckValue? = nil, stale: DeckValue? = nil, round: Int? = nil, map: [String: DeckValue]? = nil,
                                above: Double? = nil, below: Double? = nil, atLeast: Double? = nil, atMost: Double? = nil, equals: DeckValue? = nil,
                                then: DeckValue? = nil, else otherwise: DeckValue? = nil) -> Value {
            .spec(Spec(path: path, default: `default`, stale: stale, round: round, map: map, above: above, below: below, atLeast: atLeast, atMost: atMost,
                       equals: equals, then: then, else: otherwise))
        }
        public var path: String { switch self { case .path(let p): return p; case .spec(let s): return s.path } }
        public init(from d: Decoder) throws {
            let c = try d.singleValueContainer()
            if let p = try? c.decode(String.self) { self = .path(p) } else { self = .spec(try c.decode(Spec.self)) }
        }
        public func encode(to e: Encoder) throws {
            var c = e.singleValueContainer()
            switch self { case .path(let p): try c.encode(p); case .spec(let s): try c.encode(s) }
        }
    }

    /// A user-editable setting (`type`: string, number or boolean; `default` of that type).
    public struct Setting: Codable, Equatable, Sendable {
        public var type: String?
        public var `default`: DeckValue?
        public var title: String?
        public var description: String?
        public init(type: String? = nil, default: DeckValue? = nil, title: String? = nil, description: String? = nil) {
            self.type = type; self.default = `default`; self.title = title; self.description = description
        }
    }

    /// One of: `cmd`, `http`, `url`, or `type: "app"` + `target`.
    public struct Action: Codable, Equatable, Sendable {
        public var title: String?
        public var params: [String]?
        public var refresh: Bool?
        public var cmd: Command?
        /// Seconds: cmd actions up to 1800 (default 15, detached 1800), http actions up to 60.
        public var timeout: Double?
        /// cmd actions only: run in the background (long builds), output to `~/.deckstudio/plugins-logs/<id>-<action>.log`.
        public var detach: Bool?
        public var toast: Bool?
        public var http: String?
        public var method: String?
        public var body: DeckValue?
        public var type: String?
        public var target: String?
        public var url: String?
        public init(title: String? = nil, params: [String]? = nil, refresh: Bool? = nil, cmd: Command? = nil, timeout: Double? = nil, detach: Bool? = nil, toast: Bool? = nil,
                    http: String? = nil, method: String? = nil, body: DeckValue? = nil, type: String? = nil, target: String? = nil, url: String? = nil) {
            self.title = title; self.params = params; self.refresh = refresh; self.cmd = cmd; self.timeout = timeout; self.detach = detach; self.toast = toast
            self.http = http; self.method = method; self.body = body; self.type = type; self.target = target; self.url = url
        }
        /// Run argv (no shell). Later elements may use `{value}`, `{<param>}`, `{<id>.<value>}`.
        public static func cmd(_ argv: [String], title: String? = nil, params: [String]? = nil, toast: Bool? = nil, timeout: Double? = nil, detach: Bool? = nil) -> Action {
            .init(title: title, params: params, cmd: .argv(argv), timeout: timeout, detach: detach, toast: toast)
        }
        /// Open the detected app (`"bundle"`) or a bundle id.
        public static func app(_ target: String = "bundle", title: String? = nil) -> Action { .init(title: title, type: "app", target: target) }
        /// Open a URL (https always; other schemes need `permissions.schemes` and the user's grant).
        public static func url(_ url: String, title: String? = nil) -> Action { .init(title: title, type: "url", url: url) }
        /// Call a loopback http endpoint.
        public static func http(_ url: String, method: String = "POST", body: DeckValue? = nil, title: String? = nil) -> Action { .init(title: title, http: url, method: method, body: body) }
    }

    public struct Templates: Codable, Equatable, Sendable {
        public var keys: [String: DeckValue]?
        public var dials: [String: DeckValue]?
        public var pages: [String: DeckValue]?
        public init(keys: [String: DeckValue]? = nil, dials: [String: DeckValue]? = nil, pages: [String: DeckValue]? = nil) { self.keys = keys; self.dials = dials; self.pages = pages }
    }

    public struct Permissions: Codable, Equatable, Sendable {
        public var shell: Bool?
        public var schemes: [String]?
        public var network: [String]?
        public init(shell: Bool? = nil, schemes: [String]? = nil, network: [String]? = nil) { self.shell = shell; self.schemes = schemes; self.network = network }
    }

    // MARK: I/O

    /// Pretty JSON with sorted keys.
    public func jsonData() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try e.encode(self) + Data("\n".utf8)
    }

    /// Writes `deckstudio.json`. `url` is the plugin folder or the file itself.
    @discardableResult
    public func write(to url: URL) throws -> URL {
        var isDir: ObjCBool = false
        let file = url.pathExtension == "json" ? url
            : (FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue ? url.appendingPathComponent(DeckManifest.fileName) : url)
        try jsonData().write(to: file, options: .atomic)
        return file
    }

    public static func read(from url: URL) throws -> DeckManifest {
        try JSONDecoder().decode(DeckManifest.self, from: Data(contentsOf: url.pathExtension == "json" ? url : url.appendingPathComponent(fileName)))
    }

    // MARK: offline checks (a subset of DeckStudio's validateManifest)

    static let interpreters = try! NSRegularExpression(pattern: "^(sh|bash|zsh|dash|ksh|fish|csh|tcsh|env|xargs|osascript|python[0-9.]*|node|perl|ruby|php|lua|deno|bun|swift|open|sudo|su|launchctl)$")
    static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }

    /// Errors DeckStudio would refuse the manifest for (empty: probably fine; run `deckctl plugin validate` to be sure).
    public func check() -> [String] {
        var e: [String] = []
        let shell = permissions?.shell == true
        let schemes = permissions?.schemes ?? []
        if deckstudio != DeckManifest.schemaVersion { e.append("\"deckstudio\" must be \"\(DeckManifest.schemaVersion)\"") }
        if !DeckManifest.matches(id, "^[a-z0-9][a-z0-9-]{0,31}$") || DeckManifest.reservedIds.contains(id) { e.append("id: a-z 0-9 -, up to 32, not a reserved word") }
        func cmd(_ c: Command, _ w: String) {
            switch c {
            case .shell: if !shell { e.append("\(w): a shell-string command needs permissions.shell") }
            case .argv(let a):
                guard let a0 = a.first else { e.append("\(w): empty argv"); return }
                if !(a0 == "$bin" || DeckManifest.matches(a0, "^(/|~/|\\$dir/)") || DeckManifest.matches(a0, "^[\\w.+-]{1,64}$")) { e.append("\(w): argv[0] must be \"$bin\", \"$dir/…\", an absolute or ~/ path, or a program name") }
                let base = String(a0.split(separator: "/").last ?? "")
                if !shell, DeckManifest.interpreters.firstMatch(in: base, range: NSRange(base.startIndex..., in: base)) != nil { e.append("\(w): running \(base) needs permissions.shell") }
            }
        }
        func transport(_ t: Transport, _ w: String) {
            let n = [t.cmd != nil, t.http != nil, t.file != nil].filter { $0 }.count
            if n != 1 { e.append("\(w): exactly one of cmd, http, file") }
            if let c = t.cmd { cmd(c, "\(w).cmd") }
            if let f = t.file, !DeckManifest.matches(f, "^(/|~/|\\$dir/|\\{settings\\.\\w+\\})") || f.split(separator: "/").contains("..") { e.append("\(w).file: an absolute, ~/ or $dir/ path (or one starting with {settings.<name>})") }
            if let h = t.http, !DeckManifest.matches(h, "^https?://") { e.append("\(w).http: http(s) urls only") }
        }
        if let s = status { transport(s, "status") }
        if let b = bots { transport(b, "bots") }
        for (k, v) in values ?? [:] {
            if !DeckManifest.matches(k, "^[a-z][a-z0-9_]{0,31}$") { e.append("values.\(k): names start with a-z, then a-z 0-9 _") }
            if !DeckManifest.matches(v.path, "^\\$((\\.[A-Za-z_$][\\w$-]*)|(\\[-?\\d+\\])|(\\['[^']*'\\])|(\\[\"[^\"]*\"\\]))*$") { e.append("values.\(k): bad path \(v.path)") }
            if case .spec(let sp) = v {
                if !sp.hasTest && (sp.then != nil || sp.else != nil) { e.append("values.\(k): then / else need a test (above, below, atLeast, atMost or equals)") }
                if let q = sp.equals, q.stringValue == nil && q.doubleValue == nil && q.boolValue == nil { e.append("values.\(k).equals: a string, number or boolean") }
            }
        }
        for (k, st) in settings ?? [:] {
            if !DeckManifest.matches(k, "^[a-z][a-z0-9_]{0,31}$") { e.append("settings.\(k): names start with a-z, then a-z 0-9 _") }
            let type = st.type ?? "string"
            if !["string", "number", "boolean"].contains(type) { e.append("settings.\(k).type: one of string, number, boolean") }
            else if let d = st.default {
                let ok = type == "string" ? d.stringValue != nil : type == "number" ? d.doubleValue != nil : d.boolValue != nil
                if !ok { e.append("settings.\(k).default: must be a \(type)") }
            }
        }
        // every {settings.x} / {self.settings.x} must be declared
        if let data = try? JSONEncoder().encode(self), let text = String(data: data, encoding: .utf8),
           let re = try? NSRegularExpression(pattern: "\\{(?:self\\.)?settings\\.(\\w+)(?:\\|path)?\\}") {
            let declared = Set((settings ?? [:]).keys)
            let used = Set(re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } })
            for k in used.subtracting(declared).sorted() { e.append("{settings.\(k)}: \"\(k)\" isn't declared in settings") }
        }
        if !(values ?? [:]).isEmpty && status == nil { e.append("values need a status source") }
        for (k, a) in actions ?? [:] {
            if !DeckManifest.matches(k, "^[a-z][a-z0-9_-]{0,31}$") { e.append("actions.\(k): names are a-z 0-9 _ -") }
            if a.detach != nil && a.cmd == nil { e.append("actions.\(k).detach: true / false, on cmd actions only") }
            if let c = a.cmd { cmd(c, "actions.\(k).cmd") }
            else if a.http != nil {}
            else if a.type == "app" { if !(a.target == "bundle" || DeckManifest.matches(a.target ?? "", "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$")) { e.append("actions.\(k).target: \"bundle\" or a bundle id") } }
            else if let u = a.url {
                let sc = u.split(separator: ":").first.map { $0.lowercased() } ?? ""
                if ["javascript", "data", "file", "vbscript", "blob", "view-source", "jar", "about", "filesystem"].contains(sc) || !u.contains(":") { e.append("actions.\(k).url: not an openable url") }
                else if sc != "https" && !schemes.contains(sc) { e.append("actions.\(k).url: \(sc): links need permissions.schemes") }
            } else { e.append("actions.\(k): one of cmd, http, url, { type: \"app\" }") }
        }
        let usesBin: (Command?) -> Bool = { if case .argv(let a)? = $0 { return a.contains("$bin") }; return false }
        if (usesBin(status?.cmd) || (actions ?? [:]).values.contains { usesBin($0.cmd) }) && (detect?.bin ?? []).isEmpty { e.append("\"$bin\" needs detect.bin") }
        if (actions ?? [:]).values.contains(where: { $0.target == "bundle" }) && (detect?.bundle ?? []).isEmpty { e.append("{ type: \"app\", target: \"bundle\" } needs detect.bundle") }
        return e.sorted()
    }
}
