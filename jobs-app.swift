// Jobs launcher + unread-LinkedIn-message Dock badge for linkedin-assistant.
//
// Behaviour:
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
//   - Posts macOS banners queued by lib/notify.mjs as banners/*.json
//     ({title, message}); each file is deleted once posted. Clicking a banner
//     behaves like a Dock-icon click (Djinni unread or the dashboard).
//
// Build with build-jobs.sh. Set JOBS_DEBUG=1 for stderr logging.

import Cocoa
import UserNotifications

let bundlePath = Bundle.main.bundlePath                       // <project>/Jobs.app
let projectDir = (bundlePath as NSString).deletingLastPathComponent
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
let djinniStatePath = (projectDir as NSString).appendingPathComponent("djinni-notify-state.json")
// Resolve the dashboard launcher script next to the app bundle.
let dashboardLauncher = (projectDir as NSString).appendingPathComponent("open-dashboard.sh")
let bannersDir = (projectDir as NSString).appendingPathComponent("banners")
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
        // Only a purely numeric id is safe to splice into a path; anything else
        // (junk in the state file) falls back to the unread bucket.
        let url = ids.count == 1 && !ids[0].isEmpty && Int(ids[0]) != nil
            ? "https://djinni.co/my/inbox/\(ids[0])/"
            : "https://djinni.co/my/inbox?bucket=unread"
        dbg("activation -> Djinni (count=\(count), ids=\(ids.count)) \(url)")
        openURL(url)
        return
    }
    openDashboard()
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var timer: Timer?
    var lastBadge: String? = "unset"
    var lastBadgeSetting: Int = -1
    var notifGranted = false
    let center = UNUserNotificationCenter.current()

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)            // show in Dock, own a dock tile
        // A .regular app launched in the background (open -g from launchd) is never
        // activated, and the Dock keeps showing the pinned static tile WITHOUT our
        // badge until the first activation (verified: badge appeared only after
        // `open -a`). Activate once and hand focus straight back; we own no windows,
        // so this is a sub-second focus blip at launch only.
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.hide(nil) }
        dbg("launched; background=\(isBackground) state=\(statePath)")
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge]) { [weak self] granted, err in
            DispatchQueue.main.async { self?.notifGranted = granted }
            dbg("notifications granted=\(granted) error=\(String(describing: err))")
        }
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
        // Permission can be granted/revoked in System Settings at any time: re-read
        // it every tick instead of latching the launch-time answer.
        center.getNotificationSettings { [weak self] st in
            DispatchQueue.main.async {
                self?.notifGranted = st.authorizationStatus == .authorized
                if self?.lastBadgeSetting != st.badgeSetting.rawValue {
                    self?.lastBadgeSetting = st.badgeSetting.rawValue
                    dbg("notification settings: auth=\(st.authorizationStatus.rawValue) alert=\(st.alertSetting.rawValue) badge=\(st.badgeSetting.rawValue)")
                }
            }
        }
        // Combined badge: unread LinkedIn message threads + unread Djinni inbox threads.
        let count = unreadCount(at: statePath) + unreadCount(at: djinniStatePath)
        // Re-apply every tick (cheap): the Dock forgets badges when it restarts,
        // and a background-launched .regular app does not always repaint its tile.
        let label: String? = count > 0 ? String(count) : nil
        NSApp.dockTile.badgeLabel = label
        NSApp.dockTile.display()
        if label != lastBadge { dbg("badge -> \(label ?? "nil")"); lastBadge = label }
        pruneOldBanners()
        postQueuedBanners()
    }

    // Drop banners/*.json older than 7 days (nothing drains them without
    // notification permission) and *.json.tmp older than 1 hour (a notify.mjs
    // write that died before its atomic rename).
    func pruneOldBanners() {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: bannersDir) else { return }
        let now = Date()
        for name in names {
            let maxAge: TimeInterval
            if name.hasSuffix(".json.tmp") { maxAge = 3600 } else if name.hasSuffix(".json") { maxAge = 7 * 86400 } else { continue }
            let path = (bannersDir as NSString).appendingPathComponent(name)
            if let mtime = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date, now.timeIntervalSince(mtime) > maxAge {
                try? fm.removeItem(atPath: path)
            }
        }
    }

    // Files handed to center.add whose completion has not fired yet; poll()
    // runs every 3 s and must not re-submit them meanwhile.
    var inFlight = Set<String>()

    // Post banners/*.json queued by lib/notify.mjs (at most 5 per tick so a
    // backlog trickles out instead of flooding the screen); a file is deleted only
    // once its banner was accepted. Without notification permission recent
    // files are left so they can be inspected or drained once granted.
    func postQueuedBanners() {
        guard notifGranted else { return }
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: bannersDir) else { return }
        let pending = names.sorted().filter { $0.hasSuffix(".json") && !inFlight.contains($0) }
        for name in pending.prefix(5) {
            let path = (bannersDir as NSString).appendingPathComponent(name)
            guard let data = fm.contents(atPath: path),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let message = obj["message"] as? String else {
                try? fm.removeItem(atPath: path)   // unreadable/malformed: drop, never retry
                continue
            }
            let content = UNMutableNotificationContent()
            content.title = (obj["title"] as? String) ?? "Вакансии"
            content.body = message
            inFlight.insert(name)
            center.add(UNNotificationRequest(identifier: name, content: content, trigger: nil)) { err in
                dbg("banner \(name) error=\(String(describing: err))")
                if err == nil { try? fm.removeItem(atPath: path) }
                DispatchQueue.main.async { self.inFlight.remove(name) }
            }
        }
    }

    // Show banners even while we are the "foreground" app (we own no windows).
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .list])
    }

    // Banner click == Dock-icon click.
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                withCompletionHandler h: @escaping () -> Void) {
        handleActivation()
        h()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
