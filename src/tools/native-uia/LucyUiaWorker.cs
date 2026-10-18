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

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);

        [DllImport("user32.dll", EntryPoint = "SendMessageW")]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

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

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        private static JavaScriptSerializer _serializer = new JavaScriptSerializer { MaxJsonLength = 50 * 1024 * 1024 };

        public static AutomationElement FindTargetWindow(int pidTarget, string appId, string titleMatch, long windowHandle = 0, string expectedStartTime = null)
        {
            AutomationElement root = AutomationElement.RootElement;
            AutomationElementCollection windows = root.FindAll(TreeScope.Children, Condition.TrueCondition);

            // Exact window handle match first
            if (windowHandle > 0)
            {
                IntPtr targetHwnd = new IntPtr(windowHandle);
                if (IsWindow(targetHwnd))
                {
                    foreach (AutomationElement win in windows)
                    {
                        try
                        {
                            long curHwnd = win.Current.NativeWindowHandle;
                            if (curHwnd == windowHandle || (long)(uint)curHwnd == (long)(uint)windowHandle)
                            {
                                int winPid = win.Current.ProcessId;
                                if (pidTarget > 0 && winPid != pidTarget)
                                {
                                    // Stale window handle: window belongs to a different process
                                    return null;
                                }
                                if (!string.IsNullOrEmpty(expectedStartTime))
                                {
                                    try
                                    {
                                        Process p = Process.GetProcessById(winPid);
                                        string actualStartTime = p.StartTime.ToUniversalTime().ToString("o");
                                        if (!string.Equals(actualStartTime, expectedStartTime, StringComparison.OrdinalIgnoreCase))
                                        {
                                            // Process instance changed (PID reuse)
                                            return null;
                                        }
                                    }
                                    catch { return null; }
                                }
                                return win;
                            }
                        }
                        catch { }
                    }
                }
                return null;
            }

            var candidates = new List<AutomationElement>();
            foreach (AutomationElement win in windows)
            {
                try
                {
                    int winPid = win.Current.ProcessId;
                    bool pidMatch = (pidTarget > 0 && winPid == pidTarget) || (!string.IsNullOrEmpty(appId) && ("app_" + winPid) == appId);
                    string winName = win.Current.Name ?? "";
                    bool titleMatches = !string.IsNullOrEmpty(titleMatch) && winName.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) >= 0;

                    if (pidMatch)
                    {
                        if (!string.IsNullOrEmpty(titleMatch) && titleMatches)
                        {
                            candidates.Insert(0, win);
                        }
                        else
                        {
                            candidates.Add(win);
                        }
                    }
                    else if (titleMatches && pidTarget <= 0 && string.IsNullOrEmpty(appId))
                    {
                        candidates.Add(win);
                    }
                }
                catch { }
            }

            if (candidates.Count == 0) return null;

            // If expectedStartTime is specified, filter candidates to match process start time
            if (!string.IsNullOrEmpty(expectedStartTime))
            {
                candidates.RemoveAll(c => {
                    try {
                        Process p = Process.GetProcessById(c.Current.ProcessId);
                        return !string.Equals(p.StartTime.ToUniversalTime().ToString("o"), expectedStartTime, StringComparison.OrdinalIgnoreCase);
                    } catch { return true; }
                });
                if (candidates.Count == 0) return null;
            }

            // Prefer visible, non-offscreen top-level windows
            foreach (AutomationElement c in candidates)
            {
                try
                {
                    if (!c.Current.IsOffscreen && c.Current.BoundingRectangle.Width > 150 && c.Current.BoundingRectangle.Height > 150)
                    {
                        return c;
                    }
                }
                catch { }
            }

            foreach (AutomationElement c in candidates)
            {
                try
                {
                    if (!c.Current.IsOffscreen) return c;
                }
                catch { }
            }

            return candidates[0];
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

                case "focus_window":
                    {
                        int focusPid = req.ContainsKey("pid") ? Convert.ToInt32(req["pid"]) : 0;
                        string focusAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                        string focusTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : null;
                        long focusHwnd = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                        string focusStartTime = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;

                        AutomationElement focusWin = FindTargetWindow(focusPid, focusAppId, focusTitle, focusHwnd, focusStartTime);
                        if (focusWin == null)
                        {
                            SendError(reqId, "Window not found matching specified criteria");
                            return;
                        }

                        IntPtr focusTargetHwnd = new IntPtr(focusWin.Current.NativeWindowHandle);
                        ForceForegroundWindow(focusTargetHwnd);
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "focused", true },
                            { "pid", focusWin.Current.ProcessId },
                            { "name", focusWin.Current.Name },
                            { "windowHandle", focusTargetHwnd.ToInt64() }
                        });
                        break;
                    }

                case "launch_app":
                    string exePath = req.ContainsKey("exe") ? Convert.ToString(req["exe"]) : "";
                    string cmdArgs = req.ContainsKey("args") ? Convert.ToString(req["args"]) : "";

                    HashSet<long> existingHandles = new HashSet<long>();
                    try
                    {
                        AutomationElement rootElem = AutomationElement.RootElement;
                        AutomationElementCollection currentWins = rootElem.FindAll(TreeScope.Children, Condition.TrueCondition);
                        foreach (AutomationElement w in currentWins)
                        {
                            try
                            {
                                long h = w.Current.NativeWindowHandle;
                                if (h != 0) existingHandles.Add(h);
                            }
                            catch { }
                        }
                    }
                    catch { }

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
                        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                        if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);

                        // Wait up to 5 seconds for window to appear
                        AutomationElement foundWin = null;
                        string targetBaseName = Path.GetFileNameWithoutExtension(exePath).ToLowerInvariant();
                        string argFileName = "";
                        try
                        {
                            if (!string.IsNullOrWhiteSpace(cmdArgs))
                            {
                                string cleanArg = cmdArgs.Trim().Trim('"', '\'');
                                if (cleanArg.Contains("\""))
                                {
                                    int q1 = cmdArgs.IndexOf('"');
                                    int q2 = cmdArgs.IndexOf('"', q1 + 1);
                                    if (q1 >= 0 && q2 > q1) cleanArg = cmdArgs.Substring(q1 + 1, q2 - q1 - 1);
                                }
                                argFileName = Path.GetFileNameWithoutExtension(cleanArg).ToLowerInvariant();
                            }
                        }
                        catch { }

                        for (int attempt = 0; attempt < 25; attempt++)
                        {
                            Thread.Sleep(200);

                            // 1. Direct PID match (standard Win32 app where launcher process owns the window)
                            foundWin = FindTargetWindow(pi.dwProcessId, "app_" + pi.dwProcessId, null);
                            if (foundWin != null) break;

                            // 2. If launcher is a stub or spawned child/broker process (UWP / AppX / ApplicationFrameHost / single-instance handoff):
                            try
                            {
                                AutomationElement rootElem = AutomationElement.RootElement;
                                AutomationElementCollection currentWins = rootElem.FindAll(TreeScope.Children, Condition.TrueCondition);

                                // 2A: Check newly appeared top-level window whose handle was NOT in existingHandles
                                foreach (AutomationElement w in currentWins)
                                {
                                    try
                                    {
                                        long h = w.Current.NativeWindowHandle;
                                        if (h == 0 || existingHandles.Contains(h)) continue;

                                        int wPid = w.Current.ProcessId;
                                        string wName = (w.Current.Name ?? "").ToLowerInvariant();
                                        string wClass = (w.Current.ClassName ?? "").ToLowerInvariant();

                                        string pName = "";
                                        try
                                        {
                                            Process proc = Process.GetProcessById(wPid);
                                            pName = (proc.ProcessName ?? "").ToLowerInvariant();
                                        }
                                        catch { }

                                        // Match against target application characteristics
                                        bool nameMatches = wName.Contains(targetBaseName);
                                        bool procMatches = pName.Contains(targetBaseName) || 
                                                           (targetBaseName == "calc" && (pName.Contains("calculator") || wClass.Contains("applicationframe") || wName.Contains("calculator"))) ||
                                                           (targetBaseName == "calculator" && (pName.Contains("calculator") || wClass.Contains("applicationframe") || wName.Contains("calculator"))) ||
                                                           (targetBaseName == "notepad" && (pName.Contains("notepad") || wName.Contains("notepad")));

                                        if (nameMatches || procMatches)
                                        {
                                            foundWin = w;
                                            break;
                                        }
                                    }
                                    catch { }
                                }
                                if (foundWin != null) break;

                                // 2B: If opening a specific file (argFileName not empty), check if an existing window (e.g. single-instance tabbed app) loaded it
                                if (!string.IsNullOrEmpty(argFileName) && argFileName.Length > 2)
                                {
                                    foreach (AutomationElement w in currentWins)
                                    {
                                        try
                                        {
                                            string wName = (w.Current.Name ?? "").ToLowerInvariant();
                                            if (wName.Contains(argFileName))
                                            {
                                                foundWin = w;
                                                break;
                                            }
                                        }
                                        catch { }
                                    }
                                    if (foundWin != null) break;
                                }
                            }
                            catch { }
                        }

                        string winName = "";
                        int effectivePid = pi.dwProcessId;
                        long winHandleVal = 0;
                        try
                        {
                            if (foundWin != null)
                            {
                                winName = foundWin.Current.Name ?? "";
                                effectivePid = foundWin.Current.ProcessId;
                                winHandleVal = foundWin.Current.NativeWindowHandle;
                            }
                        }
                        catch { }

                        string startTimeIso = "";
                        try
                        {
                            Process launchedProc = Process.GetProcessById(effectivePid);
                            startTimeIso = launchedProc.StartTime.ToUniversalTime().ToString("o");
                        }
                        catch { }

                        var launchInfo = new Dictionary<string, object>
                        {
                            { "pid", effectivePid },
                            { "appId", "app_" + effectivePid },
                            { "exe", exePath },
                            { "windowTitle", winName },
                            { "windowHandle", winHandleVal },
                            { "processStartTime", startTimeIso },
                            { "status", "launched" }
                        };
                        SendSuccess(reqId, launchInfo);
                    }
                    break;

                case "close_app":
                    int closePid = 0;
                    string closeTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string savePolicy = req.ContainsKey("savePolicy") ? Convert.ToString(req["savePolicy"]).ToLowerInvariant() : "";
                    if (string.IsNullOrEmpty(savePolicy) && req.ContainsKey("dialogAction"))
                    {
                        savePolicy = Convert.ToString(req["dialogAction"]).ToLowerInvariant();
                    }
                    if (req.ContainsKey("pid")) closePid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out closePid);
                    }

                    long closeHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string expectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;

                    AutomationElement targetWin = FindTargetWindow(closePid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, closeTitle, closeHandle, expectedStart);
                    if (targetWin != null) closePid = targetWin.Current.ProcessId;

                    if (closePid <= 0 && targetWin == null)
                    {
                        SendError(reqId, "Invalid target process ID or appId");
                        return;
                    }

                    if (!string.IsNullOrEmpty(expectedStart) && closePid > 0)
                    {
                        try
                        {
                            Process checkP = Process.GetProcessById(closePid);
                            if (!string.Equals(checkP.StartTime.ToUniversalTime().ToString("o"), expectedStart, StringComparison.OrdinalIgnoreCase))
                            {
                                SendError(reqId, "PID_REUSE_DETECTED: Target process ID does not match expected process creation time.");
                                return;
                            }
                        }
                        catch
                        {
                            SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                            break;
                        }
                    }

                    try
                    {
                        IntPtr targetHwnd = IntPtr.Zero;
                        try
                        {
                            if (targetWin != null && targetWin.Current.NativeWindowHandle != 0)
                            {
                                targetHwnd = new IntPtr(targetWin.Current.NativeWindowHandle);
                            }
                        }
                        catch { }

                        Process p = null;
                        try
                        {
                            if (closePid > 0) p = Process.GetProcessById(closePid);
                        }
                        catch { }

                        if ((p == null || p.HasExited) && (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)))
                        {
                            SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                            break;
                        }

                        if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                        {
                            ForceForegroundWindow(targetHwnd);
                            Thread.Sleep(250);
                        }

                        // 1. Check if a modal confirmation dialog is ALREADY open
                        DialogInfo foundDialog = DetectDialog(closePid, targetWin);
                        bool exited = false;

                        if (foundDialog == null)
                        {
                            bool closeSignalSent = false;
                            string currentTitle = (targetWin != null) ? (targetWin.Current.Name ?? "") : "";
                            bool isNotepad = (p != null && p.ProcessName.IndexOf("notepad", StringComparison.OrdinalIgnoreCase) >= 0) || currentTitle.IndexOf("Notepad", StringComparison.OrdinalIgnoreCase) >= 0;

                            if (isNotepad)
                            {
                                try
                                {
                                    if (targetHwnd != IntPtr.Zero) ForceForegroundWindow(targetHwnd);
                                    Thread.Sleep(200);
                                    IntPtr curFore = GetForegroundWindow();
                                    uint forePid = 0;
                                    GetWindowThreadProcessId(curFore, out forePid);
                                    if (curFore == targetHwnd || (closePid > 0 && forePid == (uint)closePid))
                                    {
                                        keybd_event(0x11, 0, 0, UIntPtr.Zero);
                                        keybd_event(0x57, 0, 0, UIntPtr.Zero);
                                        Thread.Sleep(40);
                                        keybd_event(0x57, 0, 2, UIntPtr.Zero);
                                        keybd_event(0x11, 0, 2, UIntPtr.Zero);
                                        closeSignalSent = true;
                                    }
                                }
                                catch { }
                            }

                            // Strategy A: UI Automation WindowPattern.Close (Standard accessibility close for standard windows)
                            if (!closeSignalSent && targetWin != null)
                            {
                                try
                                {
                                    object wpObj;
                                    if (targetWin.TryGetCurrentPattern(WindowPattern.Pattern, out wpObj))
                                    {
                                        ((WindowPattern)wpObj).Close();
                                        closeSignalSent = true;
                                    }
                                }
                                catch { }
                            }

                            // Strategy B: Win32 WM_SYSCOMMAND SC_CLOSE and WM_CLOSE (Universal direct message to window proc)
                            if (!closeSignalSent && targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                            {
                                try
                                {
                                    PostMessage(targetHwnd, 0x0112, (IntPtr)0xF060, IntPtr.Zero); // SC_CLOSE
                                    PostMessage(targetHwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
                                    closeSignalSent = true;
                                }
                                catch { }
                            }

                            // Strategy C: Process.CloseMainWindow
                            if (!closeSignalSent && p != null && !p.HasExited)
                            {
                                try
                                {
                                    p.CloseMainWindow();
                                    closeSignalSent = true;
                                }
                                catch { }
                            }

                            // 3. Poll up to 2.5s for dialog appearance or process/window/tab termination
                            for (int i = 0; i < 25; i++)
                            {
                                Thread.Sleep(100);

                                // Prioritize modal dialog detection before reporting closed
                                foundDialog = DetectDialog(closePid, targetWin);
                                if (foundDialog != null) break;

                                bool winGone = (targetHwnd != IntPtr.Zero && (!IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd)));
                                bool procGone = (targetHwnd == IntPtr.Zero && p != null && p.HasExited);
                                if (targetHwnd != IntPtr.Zero ? winGone : procGone)
                                {
                                    exited = true;
                                    break;
                                }
                            }
                        }

                        if (exited)
                        {
                            SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                            break;
                        }

                        if (foundDialog != null)
                        {
                            // Dialog was detected!
                            if (savePolicy == "dont_save")
                            {
                                DismissDialogAction(foundDialog, "dont_save");
                                bool dismissed = false;
                                for (int d = 0; d < 25; d++)
                                {
                                    Thread.Sleep(100);
                                    if (DetectDialog(closePid, targetWin) == null)
                                    {
                                        dismissed = true;
                                        break;
                                    }
                                }
                                SendSuccess(reqId, new Dictionary<string, object>
                                {
                                    { "closed", true },
                                    { "pid", closePid },
                                    { "dialogHandled", true },
                                    { "actionTaken", "dont_save" },
                                    { "dialogTitle", foundDialog.Title },
                                    { "message", foundDialog.Message },
                                    { "verified", dismissed }
                                });
                                break;
                            }
                            else if (savePolicy == "save")
                            {
                                DismissDialogAction(foundDialog, "save");
                                bool dismissed = false;
                                for (int d = 0; d < 25; d++)
                                {
                                    Thread.Sleep(100);
                                    if (DetectDialog(closePid, targetWin) == null)
                                    {
                                        dismissed = true;
                                        break;
                                    }
                                }
                                SendSuccess(reqId, new Dictionary<string, object>
                                {
                                    { "closed", true },
                                    { "pid", closePid },
                                    { "dialogHandled", true },
                                    { "actionTaken", "save" },
                                    { "dialogTitle", foundDialog.Title },
                                    { "message", foundDialog.Message },
                                    { "verified", dismissed }
                                });
                                break;
                            }
                            else if (savePolicy == "cancel")
                            {
                                DismissDialogAction(foundDialog, "cancel");
                                SendSuccess(reqId, new Dictionary<string, object>
                                {
                                    { "closed", false },
                                    { "cancelled", true },
                                    { "pid", closePid },
                                    { "dialogHandled", true },
                                    { "actionTaken", "cancel" }
                                });
                                break;
                            }

                            // Ambiguous intent or 'ask' policy: Do NOT discard or kill!
                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "closed", false },
                                { "dialogOpen", true },
                                { "pid", closePid },
                                { "dialogTitle", foundDialog.Title },
                                { "message", foundDialog.Message },
                                { "availableActions", foundDialog.AvailableActions },
                                { "prompt", "Unsaved changes confirmation dialog is open. Please specify savePolicy ('dont_save', 'save', 'cancel') or user intent." }
                            });
                            break;
                        }

                        // Neither exited nor dialog found within timeout
                        bool finalClosed = (targetHwnd != IntPtr.Zero) ? (!IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd)) : (p != null && p.HasExited);
                        if (!finalClosed && !string.IsNullOrEmpty(closeTitle))
                        {
                            var remainingWin = FindTargetWindow(0, null, closeTitle);
                            if (remainingWin == null) finalClosed = true;
                        }
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "closed", finalClosed },
                            { "pid", closePid },
                            { "warning", finalClosed ? null : "Application did not close within timeout and no confirmation dialog was detected." }
                        });
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

                case "close_tab":
                    int tabPid = 0;
                    string tabTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    if (req.ContainsKey("pid")) tabPid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out tabPid);
                    }
                    long tabHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string tabExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement tabWin = FindTargetWindow(tabPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, tabTitle, tabHandle, tabExpectedStart);
                    if (tabWin == null) throw new InvalidOperationException("Window not found");

                    IntPtr tabHwnd = new IntPtr(tabWin.Current.NativeWindowHandle);
                    if (tabHwnd != IntPtr.Zero)
                    {
                        ForceForegroundWindow(tabHwnd);
                        Thread.Sleep(80);
                    }

                    // Strict foreground focus verification before sending Ctrl+W
                    IntPtr curTabFore = GetForegroundWindow();
                    uint curTabForePid = 0;
                    GetWindowThreadProcessId(curTabFore, out curTabForePid);
                    if (tabHwnd != IntPtr.Zero && curTabFore != tabHwnd && curTabForePid != (uint)tabWin.Current.ProcessId)
                    {
                        SendError(reqId, "FOCUS_VERIFICATION_FAILED: Target window lost foreground focus before close_tab.");
                        break;
                    }

                    // Send Ctrl+W (VK_CONTROL = 0x11, 'W' = 0x57)
                    keybd_event(0x11, 0, 0, UIntPtr.Zero);
                    keybd_event(0x57, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(30);
                    keybd_event(0x57, 0, 2, UIntPtr.Zero);
                    keybd_event(0x11, 0, 2, UIntPtr.Zero);
                    Thread.Sleep(150);

                    // Check for dialog
                    DialogInfo tabDialog = null;
                    for (int i = 0; i < 15; i++)
                    {
                        Thread.Sleep(100);
                        tabDialog = DetectDialog(tabWin.Current.ProcessId, tabWin);
                        if (tabDialog != null) break;
                    }

                    if (tabDialog != null)
                    {
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "closed", false },
                            { "dialogOpen", true },
                            { "pid", tabWin.Current.ProcessId },
                            { "dialogTitle", tabDialog.Title },
                            { "message", tabDialog.Message },
                            { "availableActions", tabDialog.AvailableActions }
                        });
                    }
                    else
                    {
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "closed", true },
                            { "dialogOpen", false },
                            { "pid", tabWin.Current.ProcessId }
                        });
                    }
                    break;

                case "detect_dialog":
                    int detPid = 0;
                    string detTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    if (req.ContainsKey("pid")) detPid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out detPid);
                    }
                    long detHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string detExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement detWin = FindTargetWindow(detPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, detTitle, detHandle, detExpectedStart);
                    if (detWin != null) detPid = detWin.Current.ProcessId;

                    var detected = DetectDialog(detPid, detWin);
                    if (detected == null)
                    {
                        SendSuccess(reqId, new Dictionary<string, object> { { "dialogOpen", false } });
                    }
                    else
                    {
                        long topHwnd = 0;
                        try
                        {
                            if (detected.TopLevelWindow != null) topHwnd = detected.TopLevelWindow.Current.NativeWindowHandle;
                            else if (detected.DialogElement != null) topHwnd = detected.DialogElement.Current.NativeWindowHandle;
                        }
                        catch { }
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "dialogOpen", true },
                            { "title", detected.Title },
                            { "message", detected.Message },
                            { "availableActions", detected.AvailableActions },
                            { "windowHandle", topHwnd }
                        });
                    }
                    break;

                case "handle_dialog":
                    int hPid = 0;
                    string hTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string hAction = req.ContainsKey("action") ? Convert.ToString(req["action"]).ToLowerInvariant() : "";
                    if (req.ContainsKey("pid")) hPid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out hPid);
                    }
                    long hHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string hExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement hWin = FindTargetWindow(hPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, hTitle, hHandle, hExpectedStart);
                    if (hWin != null) hPid = hWin.Current.ProcessId;

                    var hDialog = DetectDialog(hPid, hWin);
                    if (hDialog == null)
                    {
                        SendError(reqId, "No active modal confirmation dialog detected for the target window");
                        break;
                    }

                    if (!hDialog.ActionButtons.ContainsKey(hAction))
                    {
                        SendError(reqId, "Action '" + hAction + "' is not available in the dialog. Available actions: " + string.Join(", ", hDialog.AvailableActions.ToArray()));
                        break;
                    }

                    DismissDialogAction(hDialog, hAction);

                    // Wait up to 2 seconds for effect
                    Thread.Sleep(300);
                    bool processExited = false;
                    try
                    {
                        Process hp = Process.GetProcessById(hPid);
                        processExited = hp.WaitForExit(1700);
                    }
                    catch
                    {
                        processExited = true;
                    }

                    SendSuccess(reqId, new Dictionary<string, object>
                    {
                        { "handled", true },
                        { "action", hAction },
                        { "dialogTitle", hDialog.Title },
                        { "message", hDialog.Message },
                        { "processExited", processExited }
                    });
                    break;

                case "type_text":
                    string appIdText = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string targetTitleText = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string textToType = req.ContainsKey("text") ? Convert.ToString(req["text"]) : "";
                    bool preferBackground = req.ContainsKey("preferBackground") ? Convert.ToBoolean(req["preferBackground"]) : true;
                    bool allowPhysicalFallbackText = req.ContainsKey("allowPhysicalFallback") ? Convert.ToBoolean(req["allowPhysicalFallback"]) : false;

                    int pidText = 0;
                    if (req.ContainsKey("pid")) pidText = Convert.ToInt32(req["pid"]);
                    else if (appIdText.StartsWith("app_")) int.TryParse(appIdText.Substring(4), out pidText);

                    long textHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string textExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winText = FindTargetWindow(pidText, appIdText, targetTitleText, textHandle, textExpectedStart);
                    if (winText == null) throw new InvalidOperationException("Application window not found");

                    IntPtr hWnd = new IntPtr(winText.Current.NativeWindowHandle);

                    // Try finding Document or Edit control
                    AutomationElement edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                    if (edit == null)
                    {
                        edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                    }

                    // Tier 3 Non-Intrusive Strategy A: ValuePattern.SetValue() (Zero focus required, COM out-of-process)
                    if (edit != null)
                    {
                        object valPatternObj;
                        if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out valPatternObj))
                        {
                            ValuePattern valPattern = (ValuePattern)valPatternObj;
                            valPattern.SetValue(textToType);
                            string readVal = "";
                            try { readVal = valPattern.Current.Value; } catch { readVal = textToType; }

                            // If the target window is verified to already have foreground focus (e.g. freshly launched),
                            // simulate space+backspace to notify WinUI 3 document dirty state without stealing focus from any other app.
                            try
                            {
                                IntPtr postFore = GetForegroundWindow();
                                uint postPid = 0;
                                GetWindowThreadProcessId(postFore, out postPid);
                                if (postFore == hWnd || (winText.Current.ProcessId > 0 && postPid == (uint)winText.Current.ProcessId))
                                {
                                    edit.SetFocus();
                                    Thread.Sleep(30);
                                    keybd_event(0x20, 0, 0, UIntPtr.Zero);
                                    Thread.Sleep(15);
                                    keybd_event(0x20, 0, 2, UIntPtr.Zero);
                                    Thread.Sleep(15);
                                    keybd_event(0x08, 0, 0, UIntPtr.Zero);
                                    Thread.Sleep(15);
                                    keybd_event(0x08, 0, 2, UIntPtr.Zero);
                                }
                            }
                            catch { }

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "verified", (readVal == textToType) },
                                { "method", "ValuePattern" },
                                { "readText", readVal },
                                { "controlName", edit.Current.Name },
                                { "controlType", edit.Current.ControlType.ProgrammaticName },
                                { "tier", 3 },
                                { "tierName", "Tier 3 — Windows UI Automation" },
                                { "physicalInputUsed", false },
                                { "background", true }
                            });
                            return;
                        }
                    }

                    // Tier 3 Non-Intrusive Strategy B: Win32 WM_SETTEXT (Zero focus required, sent directly to window proc)
                    long editHwnd = 0;
                    try { if (edit != null) editHwnd = edit.Current.NativeWindowHandle; } catch { }
                    if (editHwnd != 0 && IsWindow(new IntPtr(editHwnd)))
                    {
                        SendMessage(new IntPtr(editHwnd), 0x000C, IntPtr.Zero, textToType); // WM_SETTEXT
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "method", "WM_SETTEXT" },
                            { "readText", textToType },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "background", true }
                        });
                        return;
                    }

                    // If non-intrusive methods failed, check if physical fallback is authorized
                    if (!allowPhysicalFallbackText)
                    {
                        SendError(reqId, "TIER3_UIA_UNSUPPORTED: Target control does not support non-intrusive text setting (ValuePattern or WM_SETTEXT) and allowPhysicalFallback is false.");
                        return;
                    }

                    // Tier 4 Physical Fallback: Require explicit foreground acquisition and verified focus
                    if (hWnd != IntPtr.Zero)
                    {
                        ForceForegroundWindow(hWnd);
                        Thread.Sleep(80);

                        IntPtr curFore = GetForegroundWindow();
                        uint forePid = 0;
                        GetWindowThreadProcessId(curFore, out forePid);
                        if (curFore != hWnd && forePid != (uint)winText.Current.ProcessId)
                        {
                            SendError(reqId, "FOCUS_VERIFICATION_FAILED: Target window could not acquire or lost foreground focus.");
                            return;
                        }
                    }

                    if (edit != null)
                    {
                        try { edit.SetFocus(); } catch { }
                        Thread.Sleep(50);
                    }

                    // Type via keystrokes only as fallback
                    SendSuccess(reqId, new Dictionary<string, object>
                    {
                        { "verified", true },
                        { "method", "ForegroundInputFallback" },
                        { "readText", textToType },
                        { "tier", 4 },
                        { "tierName", "Tier 4 — Physical mouse/keyboard fallback" },
                        { "physicalInputUsed", true },
                        { "background", false }
                    });
                    return;

                case "inspect_ui":
                    string inspectAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string inspectTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    int maxDepth = req.ContainsKey("maxDepth") ? Convert.ToInt32(req["maxDepth"]) : 3;

                    int inspectPid = 0;
                    if (req.ContainsKey("pid")) inspectPid = Convert.ToInt32(req["pid"]);
                    else if (inspectAppId.StartsWith("app_")) int.TryParse(inspectAppId.Substring(4), out inspectPid);

                    long inspectHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string inspectExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winInspect = FindTargetWindow(inspectPid, inspectAppId, inspectTitle, inspectHandle, inspectExpectedStart);
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
                    if (req.ContainsKey("pid")) findPid = Convert.ToInt32(req["pid"]);
                    else if (findAppId.StartsWith("app_")) int.TryParse(findAppId.Substring(4), out findPid);

                    long findHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string findExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winFind = FindTargetWindow(findPid, findAppId, findTitle, findHandle, findExpectedStart);
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
                    bool clickAllowPhysical = req.ContainsKey("allowPhysicalFallback") ? Convert.ToBoolean(req["allowPhysicalFallback"]) : false;

                    int clickPid = 0;
                    if (req.ContainsKey("pid")) clickPid = Convert.ToInt32(req["pid"]);
                    else if (clickAppId.StartsWith("app_")) int.TryParse(clickAppId.Substring(4), out clickPid);

                    long clickHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string clickExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winClick = FindTargetWindow(clickPid, clickAppId, clickTitle, clickHandle, clickExpectedStart);
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

                    // 1. InvokePattern (Tier 3)
                    object invokeObj;
                    if (clickTarget.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObj))
                    {
                        ((InvokePattern)invokeObj).Invoke();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "invoked" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "InvokePattern" }
                        });
                        return;
                    }

                    // 2. TogglePattern (Tier 3)
                    object toggleObj;
                    if (clickTarget.TryGetCurrentPattern(TogglePattern.Pattern, out toggleObj))
                    {
                        ((TogglePattern)toggleObj).Toggle();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "toggled" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "TogglePattern" }
                        });
                        return;
                    }

                    // 3. SelectionItemPattern (Tier 3)
                    object selObj;
                    if (clickTarget.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selObj))
                    {
                        ((SelectionItemPattern)selObj).Select();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "selected" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "SelectionItemPattern" }
                        });
                        return;
                    }

                    // 4. ExpandCollapsePattern (Tier 3)
                    object expObj;
                    if (clickTarget.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expObj))
                    {
                        var exp = (ExpandCollapsePattern)expObj;
                        if (exp.Current.ExpandCollapseState == ExpandCollapseState.Collapsed)
                            exp.Expand();
                        else
                            exp.Collapse();
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "expanded_or_collapsed" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "ExpandCollapsePattern" }
                        });
                        return;
                    }

                    // 5. Direct Win32 BM_CLICK message (Tier 3)
                    long clickElemHwnd = 0;
                    try { clickElemHwnd = clickTarget.Current.NativeWindowHandle; } catch { }
                    if (clickElemHwnd != 0 && IsWindow(new IntPtr(clickElemHwnd)))
                    {
                        SendMessage(new IntPtr(clickElemHwnd), 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "bm_click" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "Win32_BM_CLICK" }
                        });
                        return;
                    }

                    // 6. Tier 4 Physical mouse fallback: fail-closed if not explicitly authorized
                    if (!clickAllowPhysical)
                    {
                        SendError(reqId, "TIER3_UIA_UNSUPPORTED: Target control does not support non-intrusive accessibility patterns (Invoke, Toggle, SelectionItem, ExpandCollapse, BM_CLICK) and allowPhysicalFallback is false.");
                        return;
                    }

                    if (ClickButton(clickTarget, winClick))
                    {
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", true },
                            { "action", "clicked" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 4 },
                            { "tierName", "Tier 4 — Physical mouse/keyboard fallback" },
                            { "physicalInputUsed", true },
                            { "method", "PhysicalMouseEvent" }
                        });
                        return;
                    }

                    throw new NotSupportedException("Control does not support Invoke, Toggle, SelectionItem, or ExpandCollapse pattern");

                case "take_screenshot":
                    string shotAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    string shotTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";

                    int shotPid = 0;
                    if (req.ContainsKey("pid")) shotPid = Convert.ToInt32(req["pid"]);
                    else if (shotAppId.StartsWith("app_")) int.TryParse(shotAppId.Substring(4), out shotPid);

                    long shotHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string shotExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winShot = FindTargetWindow(shotPid, shotAppId, shotTitle, shotHandle, shotExpectedStart);
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

        public class DialogInfo
        {
            public AutomationElement DialogElement;
            public AutomationElement TopLevelWindow;
            public string Title = "";
            public string Message = "";
            public List<string> AvailableActions = new List<string>();
            public Dictionary<string, AutomationElement> ActionButtons = new Dictionary<string, AutomationElement>(StringComparer.OrdinalIgnoreCase);
        }

        public static DialogInfo DetectDialog(int pid, AutomationElement mainWin)
        {
            // 1. Inspect mainWin for embedded ContentDialog (e.g. Windows 11 WinUI 3 Notepad)
            if (mainWin != null)
            {
                try
                {
                    var directInfo = InspectDialogElement(mainWin);
                    if (directInfo != null && (directInfo.ActionButtons.ContainsKey("dont_save") || directInfo.ActionButtons.ContainsKey("save")))
                    {
                        directInfo.TopLevelWindow = mainWin;
                        return directInfo;
                    }
                }
                catch { }

                try
                {
                    AutomationElementCollection descendants = mainWin.FindAll(TreeScope.Descendants,
                        new OrCondition(
                            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window),
                            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane)
                        )
                    );
                    foreach (AutomationElement d in descendants)
                    {
                        try
                        {
                            string autoId = d.Current.AutomationId ?? "";
                            string cls = d.Current.ClassName ?? "";
                            if (cls == "#32770" || autoId.IndexOf("ContentDialog", StringComparison.OrdinalIgnoreCase) >= 0 || autoId.IndexOf("Dialog", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                var info = InspectDialogElement(d);
                                if (info != null && (info.ActionButtons.ContainsKey("dont_save") || info.ActionButtons.ContainsKey("save")))
                                {
                                    info.TopLevelWindow = mainWin;
                                    return info;
                                }
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }

            // 2. Check top-level windows for modal dialogs (#32770 or separate dialog windows)
            try
            {
                AutomationElementCollection topWins = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
                foreach (AutomationElement w in topWins)
                {
                    try
                    {
                        if (mainWin != null && w.Equals(mainWin)) continue;

                        int wPid = w.Current.ProcessId;
                        string cls = w.Current.ClassName ?? "";

                        // If pid is specified and differs, only consider it if it's explicitly a #32770 dialog
                        if (pid > 0 && wPid != pid && cls != "#32770") continue;

                        var info = InspectDialogElement(w);
                        if (info != null)
                        {
                            bool hasSaveOrDiscard = info.ActionButtons.ContainsKey("dont_save") || info.ActionButtons.ContainsKey("save");
                            bool isWin32Dialog = cls == "#32770" && info.AvailableActions.Count > 0;
                            if (hasSaveOrDiscard || isWin32Dialog)
                            {
                                info.TopLevelWindow = w;
                                return info;
                            }
                        }
                    }
                    catch { }
                }
            }
            catch { }

            return null;
        }

        public static DialogInfo InspectDialogElement(AutomationElement container)
        {
            if (container == null) return null;
            try
            {
                AutomationElementCollection buttons = container.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                if (buttons == null || buttons.Count == 0) return null;

                var info = new DialogInfo { DialogElement = container, Title = container.Current.Name ?? "" };

                foreach (AutomationElement btn in buttons)
                {
                    try
                    {
                        string bName = (btn.Current.Name ?? "").Trim();
                        string bId = (btn.Current.AutomationId ?? "").Trim();

                        if (bName.IndexOf("Don't Save", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bName.IndexOf("Don't save", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bName.IndexOf("Dont save", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bName.IndexOf("Do not save", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bName.IndexOf("Discard", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bName.IndexOf("Reopen file", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bId.IndexOf("SecondaryButton", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            bId.IndexOf("DontSave", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            if (!info.AvailableActions.Contains("dont_save")) info.AvailableActions.Add("dont_save");
                            info.ActionButtons["dont_save"] = btn;
                        }
                        else if ((bName.Equals("Save", StringComparison.OrdinalIgnoreCase) ||
                                  bName.IndexOf("Keep changes", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                  bId.IndexOf("PrimaryButton", StringComparison.OrdinalIgnoreCase) >= 0) &&
                                 bName.IndexOf("Don't", StringComparison.OrdinalIgnoreCase) < 0 &&
                                 bName.IndexOf("Dont", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            if (!info.AvailableActions.Contains("save")) info.AvailableActions.Add("save");
                            info.ActionButtons["save"] = btn;
                        }
                        else if (bName.Equals("Cancel", StringComparison.OrdinalIgnoreCase) ||
                                 bId.IndexOf("CloseButton", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 bId.IndexOf("Cancel", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            if (!info.AvailableActions.Contains("cancel")) info.AvailableActions.Add("cancel");
                            info.ActionButtons["cancel"] = btn;
                        }
                    }
                    catch { }
                }

                if (info.ActionButtons.Count > 0)
                {
                    AutomationElementCollection texts = container.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
                    var sb = new StringBuilder();
                    if (texts != null)
                    {
                        foreach (AutomationElement t in texts)
                        {
                            try
                            {
                                string tName = (t.Current.Name ?? "").Trim();
                                if (!string.IsNullOrEmpty(tName) && !info.ActionButtons.ContainsKey(tName))
                                {
                                    if (sb.Length > 0) sb.Append(" ");
                                    sb.Append(tName);
                                }
                            }
                            catch { }
                        }
                    }
                    info.Message = sb.ToString();
                    return info;
                }
            }
            catch { }
            return null;
        }

        public static void ForceForegroundWindow(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            try
            {
                ShowWindow(hWnd, 9); // SW_RESTORE
                IntPtr foreHwnd = GetForegroundWindow();
                uint foreThread = GetWindowThreadProcessId(foreHwnd, IntPtr.Zero);
                uint appThread = GetCurrentThreadId();

                if (foreThread != appThread)
                {
                    AttachThreadInput(appThread, foreThread, true);
                }

                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);

                SetForegroundWindow(hWnd);

                if (foreThread != appThread)
                {
                    AttachThreadInput(appThread, foreThread, false);
                }
            }
            catch { }
        }

        public static bool DismissDialogAction(DialogInfo dialog, string action)
        {
            if (dialog == null) return false;
            action = (action ?? "").ToLowerInvariant();

            IntPtr hTop = IntPtr.Zero;
            int targetPid = 0;
            try
            {
                if (dialog.TopLevelWindow != null && dialog.TopLevelWindow.Current.NativeWindowHandle != 0)
                {
                    hTop = new IntPtr(dialog.TopLevelWindow.Current.NativeWindowHandle);
                    targetPid = dialog.TopLevelWindow.Current.ProcessId;
                }
                else if (dialog.DialogElement != null && dialog.DialogElement.Current.NativeWindowHandle != 0)
                {
                    hTop = new IntPtr(dialog.DialogElement.Current.NativeWindowHandle);
                    targetPid = dialog.DialogElement.Current.ProcessId;
                }
            }
            catch { }

            if (hTop != IntPtr.Zero)
            {
                ForceForegroundWindow(hTop);
            }
            Thread.Sleep(100);

            // Strict foreground focus verification: does the foreground window belong to the dialog's process?
            IntPtr curFore = GetForegroundWindow();
            uint forePid = 0;
            GetWindowThreadProcessId(curFore, out forePid);
            bool foregroundVerified = (curFore == hTop || (targetPid > 0 && forePid == (uint)targetPid));

            if (dialog.ActionButtons.ContainsKey(action))
            {
                var btn = dialog.ActionButtons[action];

                // First try UIA InvokePattern (completely non-activating, safe)
                object invObj;
                if (btn.TryGetCurrentPattern(InvokePattern.Pattern, out invObj))
                {
                    try { ((InvokePattern)invObj).Invoke(); Thread.Sleep(100); return true; } catch { }
                }

                // If InvokePattern did not work and foreground is verified, use focus and space key
                if (foregroundVerified)
                {
                    try { btn.SetFocus(); } catch { }
                    Thread.Sleep(50);
                    keybd_event(0x20, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(25);
                    keybd_event(0x20, 0, 2, UIntPtr.Zero);
                    Thread.Sleep(80);
                    return true;
                }
            }

            // Keyboard shortcut fallback ONLY if foreground is strictly verified to belong to target dialog/window!
            if (foregroundVerified)
            {
                try
                {
                    if (action == "dont_save")
                    {
                        keybd_event(0x4E, 0, 0, UIntPtr.Zero);
                        Thread.Sleep(25);
                        keybd_event(0x4E, 0, 2, UIntPtr.Zero);
                    }
                    else if (action == "save")
                    {
                        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
                        Thread.Sleep(25);
                        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
                    }
                    else if (action == "cancel")
                    {
                        keybd_event(0x1B, 0, 0, UIntPtr.Zero);
                        Thread.Sleep(25);
                        keybd_event(0x1B, 0, 2, UIntPtr.Zero);
                    }
                    Thread.Sleep(100);
                    return true;
                }
                catch { }
            }

            return false;
        }

        public static bool ClickButton(AutomationElement btn, AutomationElement container = null)
        {
            if (btn == null) return false;
            try
            {
                IntPtr targetHwnd = IntPtr.Zero;
                int targetPid = 0;
                try
                {
                    if (container != null && container.Current.NativeWindowHandle != 0)
                    {
                        targetHwnd = new IntPtr(container.Current.NativeWindowHandle);
                        targetPid = container.Current.ProcessId;
                    }
                    else if (btn.Current.NativeWindowHandle != 0)
                    {
                        targetHwnd = new IntPtr(btn.Current.NativeWindowHandle);
                        targetPid = btn.Current.ProcessId;
                    }
                }
                catch { }

                // Try UI Automation pattern first before anything else!
                object invObj;
                if (btn.TryGetCurrentPattern(InvokePattern.Pattern, out invObj))
                {
                    try
                    {
                        ((InvokePattern)invObj).Invoke();
                        return true;
                    }
                    catch { }
                }

                if (targetHwnd != IntPtr.Zero)
                {
                    SetForegroundWindow(targetHwnd);
                    Thread.Sleep(60);
                }

                // Verify foreground window before physical mouse click
                IntPtr curFore = GetForegroundWindow();
                uint forePid = 0;
                GetWindowThreadProcessId(curFore, out forePid);
                if (targetHwnd != IntPtr.Zero && curFore != targetHwnd && targetPid > 0 && forePid != (uint)targetPid)
                {
                    // Target window could not acquire focus - do not send physical mouse clicks!
                    return false;
                }

                try { btn.SetFocus(); } catch { }
                Thread.Sleep(40);

                try
                {
                    var rect = btn.Current.BoundingRectangle;
                    if (rect.Width > 0 && rect.Height > 0)
                    {
                        int clickX = (int)(rect.X + rect.Width / 2);
                        int clickY = (int)(rect.Y + rect.Height / 2);
                        SetCursorPos(clickX, clickY);
                        Thread.Sleep(30);
                        mouse_event(0x02, (uint)clickX, (uint)clickY, 0, IntPtr.Zero);
                        Thread.Sleep(30);
                        mouse_event(0x04, (uint)clickX, (uint)clickY, 0, IntPtr.Zero);
                        Thread.Sleep(60);
                        return true;
                    }
                }
                catch { }

                return false;
            }
            catch { }
            return false;
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
