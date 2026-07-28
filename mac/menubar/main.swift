// Site → Figma — иконка в строке меню.
// Показывает состояние локального сервера рендеринга и позволяет
// перезапустить его, выключить и открыть логи.
//
// Сборка: mac/build-menubar.sh

import Cocoa

let kLabel = "com.sitetofigma.server"
let kPort = ProcessInfo.processInfo.environment["PORT"] ?? "4511"
let kPlist = NSHomeDirectory() + "/Library/LaunchAgents/\(kLabel).plist"
let kLogOut = NSHomeDirectory() + "/Library/Logs/site-to-figma.log"
let kLogErr = NSHomeDirectory() + "/Library/Logs/site-to-figma.error.log"

enum ServerState {
    case up          // отвечает на /health
    case starting    // сервис загружен, но порт ещё молчит
    case stopped     // сервис выгружен вручную
}

@discardableResult
func runLaunchctl(_ args: [String]) -> Int32 {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = args
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return -1 }
    task.waitUntilExit()
    return task.terminationStatus
}

var domainTarget: String { "gui/\(getuid())" }
var serviceTarget: String { "\(domainTarget)/\(kLabel)" }

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var state: ServerState = .starting

    private let headerItem = NSMenuItem(title: "Проверяю…", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "Выключить сервер", action: nil, keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "Перезапустить сервер", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        render()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: - меню

    private func buildMenu() {
        let menu = NSMenu()

        headerItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(.separator())

        restartItem.target = self
        restartItem.action = #selector(restartServer)
        menu.addItem(restartItem)

        toggleItem.target = self
        toggleItem.action = #selector(toggleServer)
        menu.addItem(toggleItem)

        menu.addItem(.separator())

        let copyItem = NSMenuItem(title: "Скопировать адрес сервера", action: #selector(copyAddress), keyEquivalent: "c")
        copyItem.target = self
        menu.addItem(copyItem)

        let logItem = NSMenuItem(title: "Открыть логи", action: #selector(openLog), keyEquivalent: "l")
        logItem.target = self
        menu.addItem(logItem)

        let errItem = NSMenuItem(title: "Открыть лог ошибок", action: #selector(openErrorLog), keyEquivalent: "")
        errItem.target = self
        menu.addItem(errItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Скрыть иконку до перезагрузки", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - состояние

    private func refresh() {
        // сервис вообще загружен в launchd?
        let loaded = runLaunchctl(["print", serviceTarget]) == 0
        guard loaded else {
            apply(.stopped)
            return
        }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(kPort)/health")!)
        request.timeoutInterval = 2.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 && data != nil
            DispatchQueue.main.async { self?.apply(ok ? .up : .starting) }
        }.resume()
    }

    private func apply(_ newState: ServerState) {
        state = newState
        render()
    }

    private func render() {
        let symbol: String
        let description: String
        switch state {
        case .up:
            symbol = "square.stack.3d.up.fill"
            description = "Сервер работает — 127.0.0.1:\(kPort)"
        case .starting:
            symbol = "square.stack.3d.up"
            description = "Сервер запускается…"
        case .stopped:
            symbol = "square.stack.3d.up.slash"
            description = "Сервер выключен"
        }

        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Site → Figma")
            image?.isTemplate = true
            button.image = image
            if image == nil { button.title = state == .up ? "S→F" : "S→F ✕" }
            button.toolTip = "Site → Figma · " + description
        }

        headerItem.title = description
        restartItem.isEnabled = state != .stopped
        toggleItem.title = state == .stopped ? "Включить сервер" : "Выключить сервер"
    }

    // MARK: - действия

    @objc private func restartServer() {
        runLaunchctl(["kickstart", "-k", serviceTarget])
        apply(.starting)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }

    @objc private func toggleServer() {
        if state == .stopped {
            runLaunchctl(["bootstrap", domainTarget, kPlist])
            runLaunchctl(["enable", serviceTarget])
            apply(.starting)
        } else {
            runLaunchctl(["bootout", serviceTarget])
            apply(.stopped)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }

    @objc private func copyAddress() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString("http://127.0.0.1:\(kPort)", forType: .string)
    }

    @objc private func openLog() { open(kLogOut) }
    @objc private func openErrorLog() { open(kLogErr) }

    private func open(_ path: String) {
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: Data())
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
