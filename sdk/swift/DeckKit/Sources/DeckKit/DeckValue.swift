import Foundation

/// A JSON value: status `values`, template objects and action bodies.
///
/// Literals work directly: `["remaining": 1500, "phase": "focus", "paused": false]`.
public enum DeckValue: Codable, Equatable, Hashable, Sendable,
    ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([DeckValue])
    case object([String: DeckValue])

    public init(stringLiteral v: String) { self = .string(v) }
    public init(integerLiteral v: Int) { self = .number(Double(v)) }
    public init(floatLiteral v: Double) { self = .number(v) }
    public init(booleanLiteral v: Bool) { self = .bool(v) }
    public init(arrayLiteral v: DeckValue...) { self = .array(v) }
    public init(dictionaryLiteral v: (String, DeckValue)...) { self = .object(Dictionary(v, uniquingKeysWith: { _, b in b })) }
    public init(nilLiteral: ()) { self = .null }
    public init(_ v: Int) { self = .number(Double(v)) }
    public init(_ v: Double) { self = .number(v) }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([DeckValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: DeckValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            // whole numbers as integers (25, not 25.0), so `{id.value}` shows "25"
            if n.isFinite, n == n.rounded(), abs(n) < 9e15 { try c.encode(Int64(n)) } else if n.isFinite { try c.encode(n) } else { try c.encodeNil() }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var intValue: Int? { doubleValue.flatMap { $0.isFinite ? Int(exactly: $0.rounded()) : nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var objectValue: [String: DeckValue]? { if case .object(let o) = self { return o }; return nil }
    public subscript(key: String) -> DeckValue? { objectValue?[key] }

    /// Compact JSON with sorted keys.
    public func jsonString(pretty: Bool = false) -> String {
        let e = JSONEncoder()
        e.outputFormatting = pretty ? [.sortedKeys, .withoutEscapingSlashes, .prettyPrinted] : [.sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }

    public static func parse(_ data: Data) -> DeckValue? { try? JSONDecoder().decode(DeckValue.self, from: data) }
}

/// Where a tool keeps its DeckStudio files. `HOME` is honoured first (like Node's `os.homedir()`), so tests and
/// DeckStudio's own scratch runs resolve `~/` the same way.
public enum DeckPaths {
    public static var home: URL {
        if let h = ProcessInfo.processInfo.environment["HOME"], h.hasPrefix("/") { return URL(fileURLWithPath: h, isDirectory: true) }
        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }
    /// `~/Library/Application Support/<app>`
    public static func appSupport(_ app: String) -> URL {
        home.appendingPathComponent("Library/Application Support", isDirectory: true).appendingPathComponent(app, isDirectory: true)
    }
    /// `~/Library/Application Support/<app>/deckstudio-status.json`
    public static func statusFile(app: String) -> URL { appSupport(app).appendingPathComponent("deckstudio-status.json") }
    /// `~/Library/Application Support/<app>/control-token`
    public static func tokenFile(app: String) -> URL { appSupport(app).appendingPathComponent("control-token") }
    /// Expands a leading `~/`.
    public static func expand(_ path: String) -> URL {
        path.hasPrefix("~/") ? home.appendingPathComponent(String(path.dropFirst(2))) : URL(fileURLWithPath: path)
    }
}

/// Small file helpers shared by the status writer and the token.
enum DeckFS {
    /// Creates the folder 0700 when it doesn't exist yet (an existing folder keeps its mode).
    static func ensureDir(_ dir: URL) throws {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue { return }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    /// Atomic write: a temp file created 0600 next to the target, then rename(2). A reader never sees half a file.
    static func writeAtomic(_ data: Data, to file: URL) throws {
        try ensureDir(file.deletingLastPathComponent())
        let temp = file.path + ".\(getpid()).\(UInt32.random(in: 0 ... .max)).tmp"
        let fd = open(temp, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw DeckError.io("cannot create \(temp): \(String(cString: strerror(errno)))") }
        let bytes = [UInt8](data)
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n <= 0 { break }
            off += n
        }
        close(fd)
        guard off == bytes.count, rename(temp, file.path) == 0 else {
            unlink(temp)
            throw DeckError.io("cannot write \(file.path)")
        }
    }
}

public enum DeckError: Error, Equatable, CustomStringConvertible {
    case io(String)
    case invalid(String)
    public var description: String {
        switch self { case .io(let s), .invalid(let s): return s }
    }
}

/// ISO 8601 UTC with milliseconds: `2026-11-24T09:41:07.120Z` (what DeckStudio's `Date.parse` reads).
enum DeckTime {
    static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
    /// ISO (with or without fractions), or epoch seconds / milliseconds (number or digit string), like DeckStudio's `heartbeatAt`.
    static func parse(_ v: DeckValue?) -> Date? {
        let n: Double?
        switch v {
        case .number(let x)?: n = x
        case .string(let s)? where !s.isEmpty && s.allSatisfy(\.isASCIIDigit): n = Double(s)
        case .string(let s)?:
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: s)
        default: n = nil
        }
        guard let x = n, x.isFinite, x > 0 else { return nil }
        return Date(timeIntervalSince1970: x < 1e11 ? x : x / 1000)
    }
}

extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
