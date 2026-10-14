using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Lucy.DesktopAutomation
{
    /// <summary>
    /// LucyUiaWorker
    /// High-performance native Windows UI Automation worker for L.U.C.Y.
    /// Communicates via STDIO using JSON lines.
    /// Handles WinSta0\default interactive desktop routing for isolated execution environments.
    /// </summary>
    public class LucyUiaWorker
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(
            string lpApplicationName, string lpCommandLine,
            IntPtr lpProcAttr, IntPtr lpThreadAttr,
            bool bInherit, uint dwFlags, IntPtr lpEnv,
            string lpDir, ref STARTUPINFO lpStartup, out PROCESS_INFORMATION lpProcInfo);

        private static JavaScriptSerializer _serializer = new JavaScriptSerializer { MaxJsonLength = 50 * 1024 * 1024 };

        public static AutomationElement FindTargetWindow(int pidTarget, string appId, string titleMatch)
        {
            AutomationElement root = AutomationElement.RootElement;
            AutomationElementCollection windows = root.FindAll(TreeScope.Children, Condition.TrueCondition);

            // First pass: exact PID or appId match
            foreach (AutomationElement win in windows)
            {
                try
                {
                    int winPid = win.Current.ProcessId;
                    if (pidTarget > 0 && winPid == pidTarget) return win;
                    if (!string.IsNullOrEmpty(appId) && ("app_" + winPid) == appId) return win;
                }
                catch { }
            }

            // Second pass: title match or process name match
            if (!string.IsNullOrEmpty(titleMatch))
            {
                foreach (AutomationElement win in windows)
                {
                    try
                    {
                        string winName = win.Current.Name ?? "";
                        if (winName.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) >= 0) return win;

                        int winPid = win.Current.ProcessId;
                        try
                        {
                            Process p = Process.GetProcessById(winPid);
                            if (p.ProcessName.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) >= 0) return win;
                        }
                        catch { }
                    }
                    catch { }
                }
            }

            return null;
        }

        public static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            // Switch thread to default interactive desktop before touching UIAutomation
            IntPtr hDefault = OpenDesktop("default", 0, false, 0x01FF);
            bool switched = false;
            if (hDefault != IntPtr.Zero)
            {
                switched = SetThreadDesktop(hDefault);
            }

            var readyMsg = new Dictionary<string, object>
            {
                { "status", "ready" },
                { "engine", "LUCY-Native-UIA-Worker" },
                { "switched", switched },
                { "version", "1.0.0" }
            };
            Console.WriteLine(_serializer.Serialize(readyMsg));

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                long reqId = 0;
                try
                {
                    var req = _serializer.Deserialize<Dictionary<string, object>>(line);
                    if (req.ContainsKey("id")) reqId = Convert.ToInt64(req["id"]);
                    string cmd = req.ContainsKey("cmd") ? Convert.ToString(req["cmd"]) : "";

                    HandleCommand(reqId, cmd, req);
                }
                catch (Exception ex)
                {
                    var errRes = new Dictionary<string, object>
                    {
                        { "id", reqId },
                        { "ok", false },
                        { "error", ex.Message }
                    };
                    Console.WriteLine(_serializer.Serialize(errRes));
                }
            }
        }

        private static void HandleCommand(long reqId, string cmd, Dictionary<string, object> req)
        {
            switch (cmd)
            {
                case "ping":
                    int count = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition).Count;
                    SendSuccess(reqId, new Dictionary<string, object> { { "pong", true }, { "windowsCount", count } });
                    break;

                case "list_apps":
                    var list = new List<Dictionary<string, object>>();
                    AutomationElement root = AutomationElement.RootElement;
                    AutomationElementCollection windows = root.FindAll(TreeScope.Children, Condition.TrueCondition);

                    foreach (AutomationElement win in windows)
                    {
                        try
                        {
                            string name = win.Current.Name ?? "";
                            string cls = win.Current.ClassName ?? "";
                            int pid = win.Current.ProcessId;
                            IntPtr handle = new IntPtr(win.Current.NativeWindowHandle);

                            if (string.IsNullOrWhiteSpace(name) && (cls.StartsWith("{") || cls == "Shell_TrayWnd")) continue;
                            if (name == "Program Manager") continue;

                            string procName = "Unknown";
                            try
                            {
                                Process p = Process.GetProcessById(pid);
                                procName = p.ProcessName;
                            }
                            catch { }

                            var item = new Dictionary<string, object>
                            {
                                { "name", name },
                                { "className", cls },
                                { "pid", pid },
                                { "processName", procName },
                                { "appId", "app_" + pid },
                                { "windowHandle", handle.ToInt64() },
                                { "isEnabled", win.Current.IsEnabled },
                                { "isOffscreen", win.Current.IsOffscreen }
                            };
                            list.Add(item);
                        }
                        catch { }
                    }
                    SendSuccess(reqId, list);
                    break;

                case "launch_app":
                    string exePath = req.ContainsKey("exe") ? Convert.ToString(req["exe"]) : "";
                    string cmdArgs = req.ContainsKey("args") ? Convert.ToString(req["args"]) : "";

                    STARTUPINFO si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(si);
                    si.lpDesktop = "WinSta0\\default";
                    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
                    string fullCmd = "\"" + exePath + "\" " + (cmdArgs ?? "");

                    bool created = CreateProcess(null, fullCmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
                    if (!created)
                    {
                        int err = Marshal.GetLastWin32Error();
                        SendError(reqId, "Failed to launch application (Win32 Error " + err + ")");
                    }
                    else
                    {
                        // Wait up to 3 seconds for window to appear
                        AutomationElement foundWin = null;
                        for (int attempt = 0; attempt < 15; attempt++)
                        {
                            Thread.Sleep(200);
                            foundWin = FindTargetWindow(pi.dwProcessId, "app_" + pi.dwProcessId, Path.GetFileNameWithoutExtension(exePath));
                            if (foundWin != null) break;
                        }

                        string winName = "";
                        int effectivePid = pi.dwProcessId;
                        try
                        {
                            if (foundWin != null)
                            {
                                winName = foundWin.Current.Name ?? "";
                                effectivePid = foundWin.Current.ProcessId;
                            }
                        }
                        catch { }

                        var launchInfo = new Dictionary<string, object>
                        {
                            { "pid", effectivePid },
                            { "appId", "app_" + effectivePid },
                            { "exe", exePath },
                            { "windowTitle", winName },
                            { "status", "launched" }
                        };
                        SendSuccess(reqId, launchInfo);
                    }
                    break;

                case "close_app":
                    int closePid = 0;
                    string closeTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    if (req.ContainsKey("pid")) closePid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out closePid);
                    }

                    if (closePid <= 0 && !string.IsNullOrEmpty(closeTitle))
                    {
                        AutomationElement w = FindTargetWindow(0, null, closeTitle);
                        if (w != null) closePid = w.Current.ProcessId;
                    }

                    if (closePid <= 0)
                    {
                        SendError(reqId, "Invalid target process ID or appId");
                        return;
                    }

                    try
                    {
                        Process p = Process.GetProcessById(closePid);
                        bool closed = false;
                        try { closed = p.CloseMainWindow(); } catch { }
                        if (!closed)
                        {
                            Thread.Sleep(300);
                            try { if (!p.HasExited) p.Kill(); } catch { }
                        }
                        SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                    }
                    catch (ArgumentException)
                    {
                        // Process is already terminated
                        SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                    }
                    catch (Exception ex)
                    {
                        SendError(reqId, "Failed to close application: " + ex.Message);
                    }
                    break;

                case "type_text":
                    string appIdText = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string targetTitleText = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string textToType = req.ContainsKey("text") ? Convert.ToString(req["text"]) : "";

                    int pidText = 0;
                    if (appIdText.StartsWith("app_")) int.TryParse(appIdText.Substring(4), out pidText);

                    AutomationElement winText = FindTargetWindow(pidText, appIdText, targetTitleText);
                    if (winText == null) throw new InvalidOperationException("Application window not found");

                    IntPtr hWnd = new IntPtr(winText.Current.NativeWindowHandle);
                    if (hWnd != IntPtr.Zero)
                    {
                        SetForegroundWindow(hWnd);
                        Thread.Sleep(100);
                    }

                    // Try finding Document or Edit control
                    AutomationElement edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                    if (edit == null)
                    {
                        edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                    }

                    if (edit != null)
                    {
                        object valPatternObj;
                        if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out valPatternObj))
                        {
                            ValuePattern valPattern = (ValuePattern)valPatternObj;
                            valPattern.SetValue(textToType);
                            string readVal = valPattern.Current.Value;
                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "verified", (readVal == textToType) },
                                { "method", "ValuePattern" },
                                { "readText", readVal },
                                { "controlName", edit.Current.Name },
                                { "controlType", edit.Current.ControlType.ProgrammaticName }
                            });
                            return;
                        }
                    }

                    throw new NotSupportedException("No editable Document or Edit control with ValuePattern found in target window");

                case "inspect_ui":
                    string inspectAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string inspectTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    int maxDepth = req.ContainsKey("maxDepth") ? Convert.ToInt32(req["maxDepth"]) : 3;

                    int inspectPid = 0;
                    if (inspectAppId.StartsWith("app_")) int.TryParse(inspectAppId.Substring(4), out inspectPid);

                    AutomationElement winInspect = FindTargetWindow(inspectPid, inspectAppId, inspectTitle);
                    if (winInspect == null) throw new InvalidOperationException("Application window not found");

                    var tree = BuildNode(winInspect, 1, maxDepth);
                    SendSuccess(reqId, tree);
                    break;

                case "find_element":
                    string findAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string findTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string elementName = req.ContainsKey("name") ? Convert.ToString(req["name"]) : "";
                    string automationId = req.ContainsKey("automationId") ? Convert.ToString(req["automationId"]) : "";

                    int findPid = 0;
                    if (findAppId.StartsWith("app_")) int.TryParse(findAppId.Substring(4), out findPid);

                    AutomationElement winFind = FindTargetWindow(findPid, findAppId, findTitle);
                    if (winFind == null) throw new InvalidOperationException("Application window not found");

                    AutomationElement target = null;
                    if (!string.IsNullOrEmpty(automationId))
                    {
                        target = winFind.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
                    }
                    if (target == null && !string.IsNullOrEmpty(elementName))
                    {
                        target = winFind.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, elementName));
                    }

                    if (target == null)
                    {
                        SendSuccess(reqId, null);
                        return;
                    }

                    var info = new Dictionary<string, object>
                    {
                        { "name", target.Current.Name },
                        { "automationId", target.Current.AutomationId },
                        { "controlType", target.Current.ControlType.ProgrammaticName },
                        { "className", target.Current.ClassName },
                        { "isEnabled", target.Current.IsEnabled },
                        { "isOffscreen", target.Current.IsOffscreen }
                    };

                    object valObj;
                    if (target.TryGetCurrentPattern(ValuePattern.Pattern, out valObj))
                    {
                        info["value"] = ((ValuePattern)valObj).Current.Value;
                    }

                    SendSuccess(reqId, info);
                    break;

                case "click_element":
                    string clickAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string clickTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string clickName = req.ContainsKey("name") ? Convert.ToString(req["name"]) : "";
                    string clickAutoId = req.ContainsKey("automationId") ? Convert.ToString(req["automationId"]) : "";

                    int clickPid = 0;
                    if (clickAppId.StartsWith("app_")) int.TryParse(clickAppId.Substring(4), out clickPid);

                    AutomationElement winClick = FindTargetWindow(clickPid, clickAppId, clickTitle);
                    if (winClick == null) throw new InvalidOperationException("Application window not found");

                    AutomationElement clickTarget = null;
                    if (!string.IsNullOrEmpty(clickAutoId))
                    {
                        clickTarget = winClick.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, clickAutoId));
                    }
                    if (clickTarget == null && !string.IsNullOrEmpty(clickName))
                    {
                        clickTarget = winClick.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, clickName));
                    }

                    if (clickTarget == null) throw new InvalidOperationException("Element not found: " + (clickAutoId ?? clickName));

                    // 1. InvokePattern
                    object invokeObj;
                    if (clickTarget.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObj))
                    {
                        ((InvokePattern)invokeObj).Invoke();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "invoked" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName }
                        });
                        return;
                    }

                    // 2. TogglePattern
                    object toggleObj;
                    if (clickTarget.TryGetCurrentPattern(TogglePattern.Pattern, out toggleObj))
                    {
                        ((TogglePattern)toggleObj).Toggle();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "toggled" },
                            { "name", clickTarget.Current.Name }
                        });
                        return;
                    }

                    // 3. SelectionItemPattern
                    object selObj;
                    if (clickTarget.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selObj))
                    {
                        ((SelectionItemPattern)selObj).Select();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "selected" },
                            { "name", clickTarget.Current.Name }
                        });
                        return;
                    }

                    throw new NotSupportedException("Control does not support Invoke, Toggle, or SelectionItem pattern");

                case "take_screenshot":
                    string shotAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string shotTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";

                    int shotPid = 0;
                    if (shotAppId.StartsWith("app_")) int.TryParse(shotAppId.Substring(4), out shotPid);

                    AutomationElement winShot = FindTargetWindow(shotPid, shotAppId, shotTitle);
                    if (winShot == null) throw new InvalidOperationException("Window not found");

                    var rect = winShot.Current.BoundingRectangle;
                    int width = (int)rect.Width;
                    int height = (int)rect.Height;
                    if (width <= 0 || height <= 0) throw new InvalidOperationException("Window has zero dimensions");

                    using (Bitmap bmp = new Bitmap(width, height))
                    {
                        using (Graphics g = Graphics.FromImage(bmp))
                        {
                            g.CopyFromScreen((int)rect.X, (int)rect.Y, 0, 0, new Size(width, height));
                        }
                        using (MemoryStream ms = new MemoryStream())
                        {
                            bmp.Save(ms, ImageFormat.Png);
                            string base64 = Convert.ToBase64String(ms.ToArray());
                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "format", "png" },
                                { "width", width },
                                { "height", height },
                                { "base64", base64 }
                            });
                        }
                    }
                    break;

                case "exit":
                    SendSuccess(reqId, "exiting");
                    Environment.Exit(0);
                    break;

                default:
                    SendError(reqId, "Unknown command: " + cmd);
                    break;
            }
        }

        private static Dictionary<string, object> BuildNode(AutomationElement el, int currentDepth, int maxDepth)
        {
            if (el == null || currentDepth > maxDepth) return null;

            try
            {
                var node = new Dictionary<string, object>
                {
                    { "name", el.Current.Name ?? "" },
                    { "controlType", el.Current.ControlType.ProgrammaticName },
                    { "automationId", el.Current.AutomationId ?? "" },
                    { "className", el.Current.ClassName ?? "" },
                    { "isEnabled", el.Current.IsEnabled },
                    { "isOffscreen", el.Current.IsOffscreen }
                };

                object valObj;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out valObj))
                {
                    node["value"] = ((ValuePattern)valObj).Current.Value;
                }

                if (currentDepth < maxDepth)
                {
                    var childList = new List<Dictionary<string, object>>();
                    AutomationElementCollection children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                    foreach (AutomationElement child in children)
                    {
                        var cNode = BuildNode(child, currentDepth + 1, maxDepth);
                        if (cNode != null) childList.Add(cNode);
                    }
                    node["children"] = childList;
                }

                return node;
            }
            catch
            {
                return null;
            }
        }

        private static void SendSuccess(long reqId, object result)
        {
            var res = new Dictionary<string, object>
            {
                { "id", reqId },
                { "ok", true },
                { "result", result }
            };
            Console.WriteLine(_serializer.Serialize(res));
        }

        private static void SendError(long reqId, string error)
        {
            var res = new Dictionary<string, object>
            {
                { "id", reqId },
                { "ok", false },
                { "error", error }
            };
            Console.WriteLine(_serializer.Serialize(res));
        }
    }
}
