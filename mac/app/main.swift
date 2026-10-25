// Moonstone.app: a standalone window around the Moonstone page, with its own Dock icon.
// Open it with a URL to point it somewhere else:  open Moonstone.app --args http://127.0.0.1:8899/
import Cocoa
import WebKit
import UniformTypeIdentifiers

let moonstoneURL: URL = {
    if let a = CommandLine.arguments.dropFirst().first(where: { $0.hasPrefix("http://") || $0.hasPrefix("https://") }),
       let u = URL(string: a) { return u }
    let port = ProcessInfo.processInfo.environment["DOCK_PORT"] ?? "8899"
    return URL(string: "http://127.0.0.1:\(port)/")!
}()

// A WKWebView swallows the first click into a window that is not in front (it only brings the window forward),
// so tapping an answer while working in another app did nothing. Take that first click.
class FirstClickWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // A web page never learns where a dropped Finder item lives, so the app takes file drops itself:
    // pictures go to the page as bytes (they attach like a pasted picture), anything else (file, folder,
    // .app) goes in as its full path, the way Terminal does. Other drags (text, links) stay with WebKit.
    private func fileURLs(_ s: NSDraggingInfo) -> [URL] {
        (s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { fileURLs(s).isEmpty ? super.draggingEntered(s) : .copy }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { fileURLs(s).isEmpty ? super.draggingUpdated(s) : .copy }
    override func prepareForDragOperation(_ s: NSDraggingInfo) -> Bool { fileURLs(s).isEmpty ? super.prepareForDragOperation(s) : true }
    override func concludeDragOperation(_ s: NSDraggingInfo?) { if let s = s, !fileURLs(s).isEmpty { return }; super.concludeDragOperation(s) }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let urls = fileURLs(s)
        if urls.isEmpty { return super.performDragOperation(s) }
        var paths: [String] = [], pics: [[String: String]] = []
        for u in urls {
            var dir: ObjCBool = false
            _ = FileManager.default.fileExists(atPath: u.path, isDirectory: &dir)
            let type = (try? u.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            if !dir.boolValue, let t = type, t.conforms(to: .image),
               let size = (try? u.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size <= 28_000_000,
               let data = try? Data(contentsOf: u) {
                pics.append(["name": u.lastPathComponent, "type": t.preferredMIMEType ?? "image/png", "data": data.base64EncodedString()])
            } else {
                paths.append(u.path)
            }
        }
        let drop: [String: Any] = ["paths": paths, "pics": pics]
        callAsyncJavaScript("return window.moonstoneNativeDrop ? window.moonstoneNativeDrop(d) : 'old page'",
                            arguments: ["d": drop], in: nil, in: .page) { r in
            if case .success(let v) = r, (v as? String) == "old page" {
                NSLog("Moonstone: the page has no moonstoneNativeDrop; drop ignored")
            }
        }
        return true
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var titleObs: NSKeyValueObservation?   // the window title follows the page ("● Your turn" shows in the Dock and Mission Control)

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let height = min(1000, screen.height)
        let frame = NSRect(x: screen.minX, y: screen.maxY - height, width: 420, height: height)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Moonstone"
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("Moonstone")

        web = FirstClickWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.navigationDelegate = self
        window.contentView!.addSubview(web)
        titleObs = web.observe(\.title, options: [.new]) { [weak self] w, _ in
            let t = w.title ?? ""; self?.window.title = t.isEmpty ? "Moonstone" : t
        }
        buildMenu()
        // --background (a quiet relaunch, e.g. after an update): open behind whatever you are using, take no focus
        if CommandLine.arguments.contains("--background") {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        web.load(URLRequest(url: moonstoneURL))
    }

    // Tap-to-talk needs the mic; this is your own Moonstone page, so grant it.
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == moonstoneURL.host ? .grant : .prompt)
    }

    // Links that open a new window go to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    @objc func reload() { web.load(URLRequest(url: moonstoneURL)) }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Moonstone", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
