import Foundation

/// `mytool status [--line|--json]` in one call, with the deck contract:
///
/// - `--line`: exactly one word (the state, or `off` when not running / stale), exit 0.
/// - `--json`: the status document on one line (state replaced by `off` and `"stale": true` when stale), exit 0.
/// - no flag: the same JSON, pretty-printed.
///
/// Always exit 0 for a readable answer, so DeckStudio shows `off` rather than an error when the tool isn't running.
/// An unknown flag exits 2 with usage on stderr.
///
/// ```swift
/// let args = Array(CommandLine.arguments.dropFirst())
/// if args.first == "status" { exit(DeckCLI.status(Array(args.dropFirst()), file: DeckPaths.statusFile(app: "Pomodoro"))) }
/// ```
public enum DeckCLI {
    public enum Format: Equatable, Sendable { case line, json, pretty }

    /// The output format for the arguments after `status`, or nil for an unknown flag.
    public static func format(_ args: [String]) -> Format? {
        var f = Format.pretty
        for a in args {
            switch a {
            case "--line": f = .line
            case "--json": f = .json
            default: return nil
            }
        }
        return f
    }

    /// The text `status` prints and its exit code.
    public static func render(_ args: [String], file: URL, staleAfter: TimeInterval = DeckStatus.staleAfter, offState: String = "off",
                              now: Date = Date(), isAlive: (Int32) -> Bool = DeckStatusReader.alive) -> (output: String, code: Int32) {
        guard let f = format(args) else { return ("usage: status [--line|--json]", 2) }
        let s = DeckStatusReader.read(file: file, staleAfter: staleAfter, offState: offState, now: now, isAlive: isAlive)
        switch f {
        case .line: return (s.state, 0)
        case .json: return (s.document.jsonString(), 0)
        case .pretty: return (s.document.jsonString(pretty: true), 0)
        }
    }

    /// Prints the status (stdout, or usage on stderr) and returns the exit code.
    public static func status(_ args: [String], file: URL, staleAfter: TimeInterval = DeckStatus.staleAfter, offState: String = "off") -> Int32 {
        let (out, code) = render(args, file: file, staleAfter: staleAfter, offState: offState)
        if code == 0 { print(out) } else { FileHandle.standardError.write(Data((out + "\n").utf8)) }
        return code
    }

    /// Handles `status …` when it is the first argument (prints and exits); returns otherwise.
    public static func handleStatusIfRequested(_ arguments: [String] = Array(CommandLine.arguments.dropFirst()), file: URL,
                                               staleAfter: TimeInterval = DeckStatus.staleAfter, offState: String = "off") {
        guard arguments.first == "status" else { return }
        exit(status(Array(arguments.dropFirst()), file: file, staleAfter: staleAfter, offState: offState))
    }
}
