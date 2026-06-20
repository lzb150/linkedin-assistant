// Jobs launcher + unread-LinkedIn-message Dock badge for linkedin-assistant.
//
// Replaces the former AppleScript applet (backed up to Jobs.app.orig). Behaviour:
//   - Stays running in the Dock with the "Вакансии" icon.
//   - Polls notify-state.json AND djinni-notify-state.json every ~3s and shows
//     the COMBINED unread count (LinkedIn messages + Djinni inbox) as a red Dock
//     badge (cleared when the total is 0).
//   - On a foreground (user) launch or a Dock-icon click: if Djinni has unread
//     messages it opens that conversation (a single unread opens the thread, a
//     few open Djinni's unread bucket); otherwise it opens the jobs dashboard
//     (node dashboard.mjs --open), preserving the old applet's behaviour.
//   - Launched with --background (by the login LaunchAgent or check.mjs) it runs
//     the badge daemon only and does NOT open the dashboard.
//
// Build with build-jobs.sh. Set JOBS_DEBUG=1 for stderr logging.

import Cocoa

let bundlePath = Bundle.main.bundlePath                       // <project>/Jobs.app
let projectDir = (bundlePath as NSString).deletingLastPathComponent
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
let djinniStatePath = (projectDir as NSString).appendingPathComponent("djinni-notify-state.json")
// Resolve the dashboard launcher script next to the app bundle.
let dashboardLauncher = (projectDir as NSString).appendingPathComponent("open-dashboard.sh")
let isBackground = CommandLine.arguments.contains("--background")

func dbg(_ s: String) {
    guard ProcessInfo.processInfo.environment["JOBS_DEBUG"] != nil else { return }
    FileHandle.standardError.write(("jobs: " + s + "\n").data(using: .utf8)!)
}

func openDashboard() {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [dashboardLauncher]
    do { try proc.run(); dbg("opened dashboard via \(dashboardLauncher)") }
    catch { dbg("openDashboard failed: \(error)") }
}

// Open a URL in the user's default browser.
func openURL(_ s: String) {
    guard let url = URL(string: s) else { dbg("openURL: bad url \(s)"); return }
    NSWorkspace.shared.open(url)
}

// Read the Djinni unread state: total count + the unread thread ids (from the
// `pending` array written by djinni-check.mjs). Missing/old files -> (0, []).
func djinniUnread() -> (count: Int, ids: [String]) {
    guard let data = FileManager.default.contents(atPath: djinniStatePath),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return (0, []) }
    let count = max(0, (obj["count"] as? NSNumber)?.intValue ?? 0)
    let pending = (obj["pending"] as? [[String: Any]]) ?? []
    let ids = pending.compactMap { ($0["id"] as? String) ?? ($0["id"] as? NSNumber)?.stringValue }
    return (count, ids)
}

// Decide what a Dock-icon activation (click or foreground launch) opens:
//   - Djinni has unread -> open that conversation (one unread opens the thread,
//     several open Djinni's unread bucket).
//   - otherwise -> open the jobs dashboard (the original behaviour).
func handleActivation() {
    let (count, ids) = djinniUnread()
    if count > 0 {
        let url = ids.count == 1
            ? "https://djinni.co/my/inbox/\(ids[0])/"
            : "https://djinni.co/my/inbox?bucket=unread"
        dbg("activation -> Djinni (count=\(count), ids=\(ids.count)) \(url)")
        openURL(url)
        return
    }
    openDashboard()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)            // show in Dock, own a dock tile
        dbg("launched; background=\(isBackground) state=\(statePath)")
        poll()                                          // immediate first pass
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in self?.poll() }
        // A foreground (user) launch opens Djinni if there are unread messages,
        // otherwise the dashboard.
        if !isBackground { handleActivation() }
    }

    // Dock-icon click while already running -> Djinni unread thread/bucket if any,
    // otherwise the dashboard.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        handleActivation()
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
