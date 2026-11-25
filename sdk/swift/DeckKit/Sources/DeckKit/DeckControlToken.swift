import Foundation

/// A per-user secret that proves a control request came from your own CLI, not from a web page.
///
/// Any web page or app can open `mytool://start`. A verb that acts on the user's behalf (records, sends, captures)
/// should only run when the URL carries this token. The token lives in a 0600 file only this user can read, so only
/// your CLI (which DeckStudio runs as an argv command) can attach it:
///
/// ```swift
/// // CLI (`mytool start`, run by DeckStudio):
/// let url = try DeckControlToken(app: "MyTool").appendToken(to: URL(string: "mytool://start")!)
/// // App (URL handler):
/// if DeckControlToken(app: "MyTool").verify(url: url) { startRecording() } else { showWindowOnly() }
/// ```
public struct DeckControlToken: Sendable {
    public let file: URL

    /// `~/Library/Application Support/<app>/control-token`
    public init(app: String) { file = DeckPaths.tokenFile(app: app) }
    public init(file: URL) { self.file = file }

    /// 64 lowercase hex characters.
    public static func isWellFormed(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// The token, only when the file is a regular file owned by this user with no group/other permission bits.
    /// A loose or foreign file trusts nothing.
    public func read() -> String? {
        var st = stat()
        guard lstat(file.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_mode & 0o077 == 0, st.st_uid == getuid(),
              let s = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return DeckControlToken.isWellFormed(t) ? t : nil
    }

    /// The existing private token, or a new one (32 bytes from the system CSPRNG, written 0600 atomically).
    @discardableResult
    public func ensure() throws -> String {
        if let t = read() { return t }
        var bytes = [UInt8](repeating: 0, count: 32)
        bytes.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, $0.count) }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        try DeckFS.writeAtomic(Data((token + "\n").utf8), to: file)
        return token
    }

    /// Replaces the token (old URLs stop working).
    @discardableResult
    public func rotate() throws -> String {
        unlink(file.path)
        return try ensure()
    }

    /// True when `given` equals the private token (constant-time compare). Missing token file: false.
    public func verify(_ given: String?) -> Bool {
        guard let given, DeckControlToken.isWellFormed(given), let expected = read() else { return false }
        return DeckControlToken.constantTimeEquals(given, expected)
    }

    /// True when the URL's `token` query item is the private token.
    public func verify(url: URL) -> Bool { verify(DeckControlToken.token(in: url)) }

    /// The URL with `token=<token>` added (creating the token if needed). Use it in the CLI, never in a manifest.
    public func appendToken(to url: URL) throws -> URL {
        let token = try ensure()
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw DeckError.invalid("bad url \(url)") }
        c.queryItems = (c.queryItems ?? []).filter { $0.name != "token" } + [URLQueryItem(name: "token", value: token)]
        guard let out = c.url else { throw DeckError.invalid("bad url \(url)") }
        return out
    }

    /// The `token` query item of a URL.
    public static func token(in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value
    }

    /// Compares every byte whatever the first difference (lengths are not secret: tokens are always 64 characters).
    public static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
