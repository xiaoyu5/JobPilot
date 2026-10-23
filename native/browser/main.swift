import Foundation
import AppKit

func four(_ value: String) -> UInt32 { value.utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } }
func object(_ kind: String, _ form: String, _ selection: NSAppleEventDescriptor, _ container: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
    let record = NSAppleEventDescriptor.record()
    record.setDescriptor(NSAppleEventDescriptor(typeCode: four(kind)), forKeyword: four("want"))
    record.setDescriptor(NSAppleEventDescriptor(enumCode: four(form)), forKeyword: four("form"))
    record.setDescriptor(selection, forKeyword: four("seld"))
    record.setDescriptor(container, forKeyword: four("from"))
    return record.coerce(toDescriptorType: four("obj "))!
}
func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data) }
}
struct BrowserError: Error { let code: String; let message: String }
func run() throws -> [String: Any] {
    let args = CommandLine.arguments
    guard args.count >= 4, let pid = pid_t(args[1]), pid > 1,
          NSRunningApplication(processIdentifier: pid)?.bundleURL?.path == "/Applications/Google Chrome.app",
          ["ready", "read", "navigate", "scroll", "greeting-prepare", "greeting-submit", "greeting-verify", "greeting-contact-submit", "greeting-contact-verify", "greeting-chat-open", "greeting-chat-history", "greeting-chat-contacts", "greeting-search-next", "greeting-chat-continue"].contains(args[2]) else {
        throw BrowserError(code: "INVALID_BROWSER_TARGET", message: "专用浏览器目标无效。")
    }
    if args[2] == "ready" { return ["ready": NSRunningApplication(processIdentifier: pid)?.isFinishedLaunching ?? false] }
    let target = NSAppleEventDescriptor(processIdentifier: pid)
    let window = object("cwin", "indx", NSAppleEventDescriptor(int32: 1), .null())
    let tab = object("prop", "prop", NSAppleEventDescriptor(typeCode: four("acTa")), window)
    let urlProperty = object("prop", "prop", NSAppleEventDescriptor(typeCode: four("URL ")), tab)
    func send(_ eventID: String, _ direct: NSAppleEventDescriptor, _ params: [String: NSAppleEventDescriptor] = [:], suite: String = "core") throws -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(eventClass: four(suite), eventID: four(eventID), targetDescriptor: target, returnID: -1, transactionID: 0)
        event.setParam(direct, forKeyword: four("----"))
        for (key, value) in params { event.setParam(value, forKeyword: four(key)) }
        let reply: NSAppleEventDescriptor
        do { reply = try event.sendEvent(options: [.waitForReply, .canInteract], timeout: 8) }
        catch {
            let code = (error as NSError).code
            if code == -1743 { throw BrowserError(code: "BROWSER_AUTOMATION_PERMISSION", message: "请在系统设置的隐私与安全性 → 自动化中允许 JobPilot 控制 Google Chrome。") }
            throw BrowserError(code: "BROWSER_READ_FAILED", message: "Chrome 原生请求未完成，请检查专用窗口是否仍然打开。")
        }
        let error = reply.paramDescriptor(forKeyword: four("errn"))?.int32Value ?? 0
        if error == -1743 { throw BrowserError(code: "BROWSER_AUTOMATION_PERMISSION", message: "请在系统设置的隐私与安全性 → 自动化中允许 JobPilot 控制 Google Chrome。") }
        if error != 0 {
            let message = reply.paramDescriptor(forKeyword: four("errs"))?.stringValue ?? ""
            if message.localizedCaseInsensitiveContains("JavaScript") {
                throw BrowserError(code: "CHROME_JAVASCRIPT_PERMISSION", message: "请在专用 Chrome 的菜单栏选择：显示 → 开发者 → 允许来自 Apple 事件的 JavaScript。")
            }
            throw BrowserError(code: "BROWSER_READ_FAILED", message: "无法读取专用 Chrome 当前页面，请保持 BOSS 标签页在该窗口前台。")
        }
        return reply.paramDescriptor(forKeyword: four("----")) ?? .null()
    }
    if args[2] == "navigate" {
        guard args.count == 5, let url = URLComponents(string: args[4]), url.scheme == "https", url.host == "www.zhipin.com", url.user == nil, url.password == nil, url.port == nil,
              url.path == "/" || url.path.hasPrefix("/web/") || url.path.hasPrefix("/job_detail/") else {
            throw BrowserError(code: "INVALID_JOB_URL", message: "只允许导航至 BOSS 官网岗位或登录页面。")
        }
        _ = try send("setd", urlProperty, ["data": NSAppleEventDescriptor(string: args[4])])
        return ["ok": true]
    }
    let current = try send("getd", urlProperty).stringValue ?? ""
    guard let url = URLComponents(string: current), url.scheme == "https", url.host == "www.zhipin.com" else { return ["url": current.components(separatedBy: "?")[0], "state": "UNKNOWN", "message": "请在专用窗口中打开 BOSS 页面。"] }
    let script: String
    if args[2] == "scroll" { script = "(() => { const roots=[...document.querySelectorAll('.job-list-box,.job-list-wrapper,.search-job-result')].filter(n=>n.getClientRects().length&&n.scrollHeight>n.clientHeight); const root=roots.find(n=>!roots.some(o=>o!==n&&n.contains(o))); if(root){root.scrollBy(0,Math.max(500,root.clientHeight*.8));root.dispatchEvent(new Event('scroll'));}else window.scrollBy(0,Math.max(500,window.innerHeight*.8));return 'ok';})()" }
    else {
        let data = try Data(contentsOf: URL(fileURLWithPath: args[3]))
        guard data.count < 256 * 1024, let source = String(data: data, encoding: .utf8) else { throw BrowserError(code: "BROWSER_RESOURCE_INVALID", message: "浏览器读取资源无效。") }
        if args[2].hasPrefix("greeting-") {
            let payload=FileHandle.standardInput.readData(ofLength:16385)
            guard payload.count<=16384,var input=(try? JSONSerialization.jsonObject(with:payload)) as? [String:Any] else { throw BrowserError(code:"INVALID_SEND_INPUT",message:"发送上下文无效。") }
            input["operation"]=String(args[2].dropFirst("greeting-".count))
            guard let encoded=try? JSONSerialization.data(withJSONObject:input),let encodedText=String(data:encoded,encoding:.utf8) else { throw BrowserError(code:"INVALID_SEND_INPUT",message:"发送上下文编码失败。") }
            script=source.replacingOccurrences(of:"__JOBPILOT_INPUT__",with:encodedText)
        } else { script = source }
    }
    let result = try send("ExJa", tab, ["JvSc": NSAppleEventDescriptor(string: script)], suite: "CrSu").stringValue ?? ""
    if args[2] == "scroll" { return ["ok": true] }
    guard let data = result.data(using: .utf8), data.count <= 900_000, let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BrowserError(code: "BROWSER_READ_FAILED", message: "页面读取结果无效。") }
    if args[2].hasPrefix("greeting-") {
        if snapshot["ok"] as? Bool != true { throw BrowserError(code:snapshot["code"] as? String ?? "ADAPTER_CHANGED",message:snapshot["message"] as? String ?? "沟通页面结构不符合预期。") }
        return snapshot["data"] as? [String:Any] ?? [:]
    }
    return snapshot
}
do { output(["ok": true, "data": try run()]) }
catch let error as BrowserError { output(["ok": false, "code": error.code, "message": error.message]); exit(1) }
catch { output(["ok": false, "code": "BROWSER_READ_FAILED", "message": "专用 Chrome 读取失败，请检查页面与权限。"]); exit(1) }
