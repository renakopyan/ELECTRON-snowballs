// Помощник для macOS: 30 раз в секунду смотрит, где на экране окна и Dock,
// и при каждом изменении печатает строку JSON:
//   {"w":[[id,x,y,width,height],...],"d":[x,y,width,height],"h":[id,...]}
// w — видимые окна от переднего к заднему; d — Dock (или null);
// h — окна, которые есть, но не видны (свёрнуты или на другом рабочем столе);
// s:1 — набор окон меняется прямо сейчас (например, листают рабочие столы): помощник
// не трогает WindowServer лишний раз, держит прежний список и ждёт, пока всё уляжется.
// Собирается командой `npm run build`.

import ApplicationServices
import Cocoa

let pollInterval: useconds_t = 33_000
let dockRefreshEvery = 30   // границы Dock меняются редко — спрашиваем раз в секунду
let hiddenRefreshEvery = 30 // список скрытых окон обновляем раз в секунду и после каждой смены набора окон
let settlingPollInterval: useconds_t = 100_000 // пока набор окон меняется, опрашиваем реже
let settleDelay: TimeInterval = 0.3 // набор окон не менялся столько — считаем, что всё улеглось
let settleLimit: TimeInterval = 1.5 // но дольше ждать нельзя, иначе снег застынет

/// Видимые обычные окна (слой 0) от переднего к заднему
func visibleWindows() -> [(Int, CGRect)] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    var result: [(Int, CGRect)] = []
    for window in info {
        // Слой 0 — обычные окна программ; меню, Dock и оверлеи лежат в других слоях
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        let alpha = (window[kCGWindowAlpha as String] as? Double) ?? 1
        guard alpha > 0 else { continue }
        guard let number = window[kCGWindowNumber as String] as? Int,
              let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }
        result.append((number, rect))
    }
    return result
}

/// Номера всех обычных окон, включая свёрнутые и окна на других рабочих столах
func allWindowNumbers() -> Set<Int> {
    guard let info = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var numbers = Set<Int>()
    for window in info {
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
              let number = window[kCGWindowNumber as String] as? Int
        else { continue }
        numbers.insert(number)
    }
    return numbers
}

/// Границы Dock. Доступны только с разрешением «Универсальный доступ»; без него — null.
func dockJSON() -> String {
    guard AXIsProcessTrusted(),
          let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
    else { return "null" }

    let app = AXUIElementCreateApplication(dock.processIdentifier)
    // Во время анимации рабочих столов Dock может отвечать долго — не ждём его дольше четверти секунды
    AXUIElementSetMessagingTimeout(app, 0.25)
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement],
          let list = children.first
    else { return "null" }

    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(list, kAXPositionAttribute as CFString, &positionRef) == .success,
          AXUIElementCopyAttributeValue(list, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let positionValue = positionRef, let sizeValue = sizeRef,
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else { return "null" }

    var position = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
    AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    guard size.width > 0, size.height > 0 else { return "null" }

    return "[\(Int(position.x)),\(Int(position.y)),\(Int(size.width)),\(Int(size.height))]"
}

setvbuf(stdout, nil, _IOLBF, 0)

var previousLine = ""
var previousIds = Set<Int>()
var hidden: [Int] = []
var dock = "null"
var tick = 0
var stableWindows = ""        // последний список окон, в котором мы уверены
var settlingSince: Date? = nil
var lastIdChange = Date()

while true {
    // Родитель завершился — помощнику тоже незачем жить
    if getppid() == 1 { exit(0) }

    var settling = false
    autoreleasepool {
        let now = Date()
        let windows = visibleWindows()
        let ids = Set(windows.map { $0.0 })

        // Окна появились или пропали: закрыты, свёрнуты или это листают рабочие столы.
        // Пока набор меняется каждый кадр, дорогие запросы к WindowServer не делаем
        // и прежний список не трогаем — иначе анимация перехода начинает подвисать.
        if ids != previousIds {
            previousIds = ids
            lastIdChange = now
            if settlingSince == nil { settlingSince = now }
        }

        if let since = settlingSince {
            if now.timeIntervalSince(lastIdChange) >= settleDelay || now.timeIntervalSince(since) >= settleLimit {
                settlingSince = nil
                hidden = allWindowNumbers().subtracting(ids).sorted()
                dock = dockJSON()
            } else {
                settling = true
            }
        } else {
            if tick % dockRefreshEvery == 0 { dock = dockJSON() }
            if tick % hiddenRefreshEvery == 0 { hidden = allWindowNumbers().subtracting(ids).sorted() }
        }

        if !settling {
            stableWindows = windows
                .map { "[\($0.0),\(Int($0.1.origin.x)),\(Int($0.1.origin.y)),\(Int($0.1.size.width)),\(Int($0.1.size.height))]" }
                .joined(separator: ",")
        }
        let h = hidden.map(String.init).joined(separator: ",")
        let flag = settling ? ",\"s\":1" : ""
        let line = "{\"w\":[\(stableWindows)],\"d\":\(dock),\"h\":[\(h)]\(flag)}"
        if line != previousLine {
            previousLine = line
            print(line)
        }
    }
    tick += 1
    usleep(settling ? settlingPollInterval : pollInterval)
}
