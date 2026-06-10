// macOS notification helper + Dock badge daemon for linkedin-assistant.
//
// Modes (selected by argv):
//   notifier                 -> DAEMON: stays in the Dock (green Messages icon),
//                               reads notify-state.json every ~3s, sets the red
//                               Dock badge to the unread count, posts a banner
//                               for each new pending message, and opens LinkedIn
//                               messaging on Dock-click.
//   notifier "title" "body"  -> one-shot banner (used by build-notifier.sh test).
//   notifier --status        -> print authorization status and exit.
//
// Banners use UserNotifications so they render under THIS bundle's green
// "Messages" icon. Silent by design (no sound).

import Cocoa
import UserNotifications

let args = CommandLine.arguments
let DEBUG = ProcessInfo.processInfo.environment["NOTIFIER_DEBUG"] != nil

func dbg(_ s: String) {
    guard DEBUG else { return }
    FileHandle.standardError.write(("notifier: " + s + "\n").data(using: .utf8)!)
}

// ---- notifier --status : read-only; never call requestAuthorization here -----
if args.count > 1 && args[1] == "--status" {
    let sema = DispatchSemaphore(value: 0)
    UNUserNotificationCenter.current().getNotificationSettings { s in
        print("authorizationStatus=\(s.authorizationStatus.rawValue) alertSetting=\(s.alertSetting.rawValue)")
        sema.signal()
    }
    _ = sema.wait(timeout: .now() + 3)
    exit(0)
}

// ---- One-shot banner: `notifier "title" "body"` (kept for manual testing) ----
if args.count >= 3 {
    let title = args[1]
    let body = args[2]
    final class OneShot: NSObject, UNUserNotificationCenterDelegate {
        let center = UNUserNotificationCenter.current()
        var done = false
        let title: String, body: String
        init(title: String, body: String) { self.title = title; self.body = body }
        func run() {
            center.delegate = self
            center.requestAuthorization(options: [.alert]) { granted, error in
                dbg("requestAuthorization granted=\(granted) error=\(String(describing: error))")
                let content = UNMutableNotificationContent()
                content.title = self.title
                content.body = self.body
                let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
                self.center.add(req) { _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.done = true }
                }
            }
        }
        func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                    withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
            h([.banner, .list])
        }
    }
    let one = OneShot(title: title, body: body)
    one.run()
    let deadline = Date().addingTimeInterval(8)
    while !one.done && Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    exit(0)
}

// ---- Daemon: `notifier` (no args). Persistent Dock app + badge. -------------

// notify-state.json lives next to the .app bundle, in the project directory.
let bundlePath = Bundle.main.bundlePath                       // <project>/Notifier.app
let projectDir = (bundlePath as NSString).deletingLastPathComponent
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
let messagingURL = URL(string: "https://www.linkedin.com/messaging/")!

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var delivered = Set<String>()
    var seeded = false
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)            // show in Dock, own a dock tile
        center.delegate = self
        center.requestAuthorization(options: [.alert]) { granted, error in
            dbg("daemon auth granted=\(granted) error=\(String(describing: error))")
        }
        dbg("daemon started; state=\(statePath)")
        poll()                                          // immediate first pass
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in self?.poll() }
    }

    // Dock-icon click -> open LinkedIn messaging.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        NSWorkspace.shared.open(messagingURL)
        return true
    }

    func poll() {
        guard let data = FileManager.default.contents(atPath: statePath) else {
            setBadge(0); return
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return                                       // partial/garbled; retry next tick
        }
        let count = (obj["count"] as? NSNumber)?.intValue ?? 0
        setBadge(count)

        let pending = (obj["pending"] as? [[String: Any]]) ?? []
        // First poll after launch: seed `delivered` with whatever is already in
        // the file so a daemon restart does not replay old banners.
        if !seeded {
            for p in pending { if let id = p["id"] as? String { delivered.insert(id) } }
            seeded = true
            return
        }
        for p in pending {
            guard let id = p["id"] as? String, !delivered.contains(id) else { continue }
            delivered.insert(id)
            let sender = (p["sender"] as? String) ?? "LinkedIn"
            let text = (p["text"] as? String) ?? "New message"
            postBanner(title: sender, body: text)
        }
    }

    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }

    func postBanner(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(req) { err in dbg("banner add err=\(String(describing: err))") }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .list])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
