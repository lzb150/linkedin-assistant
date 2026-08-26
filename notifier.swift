// Tiny macOS notification helper for linkedin-assistant.
//
// Posts a single banner via the modern UserNotifications framework so it shows
// under THIS bundle's icon/name (the green Messages icon + "Messages" header,
// see Info.plist built by build-notifier.sh) — i.e. it looks like an incoming
// iPhone text. terminal-notifier's legacy API no longer renders banners on
// macOS 26, and osascript can't set a custom icon; a real .app bundle can.
//
// Usage:  notifier "<title>" "<body>"
// Silent by design (no sound). Best-effort; exits after delivery or an 8s cap.
//
// Clicking a banner relaunches this bundle with no arguments; that mode posts
// nothing and instead runs open-dashboard.sh, so a banner is a shortcut to the
// dashboard rather than a dead end.

import Foundation
import UserNotifications
import AppKit

let args = CommandLine.arguments
let title = args.count > 1 ? args[1] : "Messages"
let body  = args.count > 2 ? args[2] : ""
let DEBUG = ProcessInfo.processInfo.environment["NOTIFIER_DEBUG"] != nil

func dbg(_ s: String) {
    guard DEBUG else { return }
    FileHandle.standardError.write(("notifier: " + s + "\n").data(using: .utf8)!)
}

// `notifier --status`: read-only — print the current authorization status and
// exit WITHOUT calling requestAuthorization (which, in a non-app context, can
// poison the permission to "denied"). 0=notDetermined 1=denied 2=authorized 3=provisional
if args.count > 1 && args[1] == "--status" {
    let sema = DispatchSemaphore(value: 0)
    UNUserNotificationCenter.current().getNotificationSettings { s in
        print("authorizationStatus=\(s.authorizationStatus.rawValue) alertSetting=\(s.alertSetting.rawValue)")
        sema.signal()
    }
    _ = sema.wait(timeout: .now() + 3)
    exit(0)
}

// Launch the dashboard the same way Jobs.app does: the script next to the
// bundle regenerates index.html, starts the state server if needed, and opens
// the browser. Best-effort — a missing script must not crash the helper.
func openDashboard() {
    let projectDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    let script = (projectDir as NSString).appendingPathComponent("open-dashboard.sh")
    guard FileManager.default.fileExists(atPath: script) else { dbg("no open-dashboard.sh at \(script)"); return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [script]
    do { try proc.run(); proc.waitUntilExit(); dbg("opened dashboard") }
    catch { dbg("openDashboard failed: \(error)") }
}

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var done = false

    // Relaunched by a banner click (no title/body to post): open the dashboard
    // and exit. The delegate must be set before the system delivers the
    // response, so this stays in the same object.
    func runClickHandler() {
        center.delegate = self
        // The response callback is the reliable path, but a relaunch can also
        // arrive with no pending response at all — open after a short grace
        // period so the click still lands somewhere useful.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            guard !self.done else { return }
            self.done = true
            openDashboard()
        }
    }

    func userNotificationCenter(
        _ c: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler h: @escaping () -> Void
    ) {
        dbg("didReceive action=\(response.actionIdentifier)")
        if !done { done = true; openDashboard() }
        h()
    }

    func run() {
        dbg("bundleID=\(Bundle.main.bundleIdentifier ?? "nil") path=\(Bundle.main.bundlePath)")
        center.delegate = self
        center.getNotificationSettings { s in
            dbg("settings.authorizationStatus=\(s.authorizationStatus.rawValue) alertSetting=\(s.alertSetting.rawValue)")
        }
        // First run prompts for permission; later runs just post.
        center.requestAuthorization(options: [.alert]) { granted, error in
            dbg("requestAuthorization granted=\(granted) error=\(String(describing: error))")
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            // No content.sound — silent, like the rest of this tool.
            let req = UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil)
            self.center.add(req) { err in
                dbg("center.add error=\(String(describing: err))")
                // Give the system a beat to present before we exit.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.done = true }
            }
        }
    }

    // Present even though our helper is technically "foreground".
    func userNotificationCenter(
        _ c: UNUserNotificationCenter,
        willPresent n: UNNotification,
        withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        h([.banner, .list])
    }
}

let notifier = Notifier()
// No arguments means a banner click relaunched us — handle the click instead
// of posting a new (empty) notification.
if args.count > 1 { notifier.run() } else { notifier.runClickHandler() }

// Pump the run loop so the async callbacks fire; bail after 8s no matter what.
let deadline = Date().addingTimeInterval(8)
while !notifier.done && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
