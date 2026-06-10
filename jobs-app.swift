// Jobs launcher + unread-LinkedIn-message Dock badge for linkedin-assistant.
//
// Replaces the former AppleScript applet (backed up to Jobs.app.orig). Behaviour:
//   - Stays running in the Dock with the "Вакансии" icon.
//   - Polls notify-state.json AND djinni-notify-state.json every ~3s and shows
//     the COMBINED unread count (LinkedIn messages + Djinni inbox) as a red Dock
//     badge (cleared when the total is 0).
//   - Opens the jobs dashboard (node dashboard.mjs --open) on a foreground
//     (user) launch and when its Dock icon is clicked — preserving the old
//     applet's behaviour.
//   - Launched with --background (by the login LaunchAgent or check.mjs) it runs
//     the badge daemon only and does NOT open the dashboard.
//
// Build with build-jobs.sh. Set JOBS_DEBUG=1 for stderr logging.

import Cocoa

let bundlePath = Bundle.main.bundlePath                       // <project>/Jobs.app
let projectDir = (bundlePath as NSString).deletingLastPathComponent
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
let djinniStatePath = (projectDir as NSString).appendingPathComponent("djinni-notify-state.json")
let dashboardScript = (projectDir as NSString).appendingPathComponent("dashboard.mjs")
let isBackground = CommandLine.arguments.contains("--background")

func dbg(_ s: String) {
    guard ProcessInfo.processInfo.environment["JOBS_DEBUG"] != nil else { return }
    FileHandle.standardError.write(("jobs: " + s + "\n").data(using: .utf8)!)
}

// Resolve a node binary: $NODE_BIN, then the applet's nvm path, then Homebrew,
// then fall back to `/usr/bin/env node` (uses PATH).
func nodeInvocation() -> (launch: String, args: [String]) {
    let env = ProcessInfo.processInfo.environment
    if let bin = env["NODE_BIN"], !bin.isEmpty, FileManager.default.isExecutableFile(atPath: bin) {
        return (bin, [dashboardScript, "--open"])
    }
    let candidates = [
        "\(NSHomeDirectory())/.nvm/versions/node/v20.14.0/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ]
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
        return (c, [dashboardScript, "--open"])
    }
    return ("/usr/bin/env", ["node", dashboardScript, "--open"])
}

func openDashboard() {
    let (launch, args) = nodeInvocation()
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: launch)
    proc.arguments = args
    do { try proc.run(); dbg("opened dashboard via \(launch)") }
    catch { dbg("openDashboard failed: \(error)") }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)            // show in Dock, own a dock tile
        dbg("launched; background=\(isBackground) state=\(statePath)")
        poll()                                          // immediate first pass
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in self?.poll() }
        // A foreground (user) launch opens the dashboard, like the old applet.
        if !isBackground { openDashboard() }
    }

    // Dock-icon click while already running -> open the dashboard.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openDashboard()
        return true
    }

    // Read the "count" field from one notify-state JSON file (missing/invalid -> 0).
    func unreadCount(at path: String) -> Int {
        guard let data = FileManager.default.contents(atPath: path),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let n = (obj["count"] as? NSNumber)?.intValue else { return 0 }
        return max(0, n)
    }

    func poll() {
        // Combined badge: unread LinkedIn message threads + unread Djinni inbox threads.
        let count = unreadCount(at: statePath) + unreadCount(at: djinniStatePath)
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
