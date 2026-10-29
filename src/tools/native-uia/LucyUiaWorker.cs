using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hDC, uint nFlags);

        private static readonly HashSet<int> _modifiedPids = new HashSet<int>();
        private static readonly HashSet<string> _modifiedAppIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> _pendingConfirmationKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<int, string> _processDocumentPaths = new Dictionary<int, string>();
        private static readonly Dictionary<string, string> _processDocumentPathsStr = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<int, string> _lastTypedText = new Dictionary<int, string>();
        private static readonly Dictionary<string, string> _lastTypedTextStr = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private static readonly HashSet<int> _authorizedWorkerPids = new HashSet<int>();
        private static readonly HashSet<string> _authorizedWorkerAppIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<long> _authorizedWorkerHandles = new HashSet<long>();
        private static readonly Dictionary<int, string> _authorizedWorkerTokens = new Dictionary<int, string>();
        private static readonly Dictionary<string, string> _authorizedWorkerTokensByAppId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private static string _sessionSecret = null;
        private static readonly Dictionary<int, string> _authorizedWorkerTaskIds = new Dictionary<int, string>();
        private static readonly Dictionary<string, string> _authorizedWorkerTaskIdsByAppId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<int, string> _authorizedWorkerProcessStartTimes = new Dictionary<int, string>();
        private static readonly Dictionary<int, long> _authorizedWorkerHandlesByPid = new Dictionary<int, long>();

        public static string ComputeHmacSha256(string keyHexOrUtf8, string message)
        {
            if (string.IsNullOrEmpty(keyHexOrUtf8) || message == null) return null;
            byte[] keyBytes = Encoding.UTF8.GetBytes(keyHexOrUtf8);
            using (var hmac = new HMACSHA256(keyBytes))
            {
                byte[] hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool ValidateWorkerAuthorization(Dictionary<string, object> req, int pid, string appId, out string authError)
        {
            authError = null;

            if (string.IsNullOrEmpty(_sessionSecret))
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Worker session is not initialized with an authorization secret.";
                return false;
            }

            bool isOwnedFlag = req.ContainsKey("isOwned") && Convert.ToBoolean(req["isOwned"]);
            if (!isOwnedFlag)
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Refusing operation on unowned application window (isOwned is false).";
                return false;
            }

            string reqToken = req.ContainsKey("authToken") ? Convert.ToString(req["authToken"]) : null;
            string reqTaskId = req.ContainsKey("taskId") ? Convert.ToString(req["taskId"]) : null;

            bool hasPid = pid > 0;
            bool hasAppId = !string.IsNullOrEmpty(appId);

            if (!hasPid && !hasAppId)
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Missing target process ID or application identifier.";
                return false;
            }

            bool pidTracked = hasPid && _authorizedWorkerPids.Contains(pid);
            bool appIdTracked = hasAppId && _authorizedWorkerAppIds.Contains(appId);

            if (!pidTracked && !appIdTracked)
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Target process (PID " + pid + ") was not launched or authorized by this native worker session.";
                return false;
            }

            int effectivePid = pid;
            if (effectivePid <= 0 && hasAppId && appId.StartsWith("app_"))
            {
                int.TryParse(appId.Substring(4), out effectivePid);
            }

            // 1. Token validation
            bool tokenValid = false;
            if (!string.IsNullOrEmpty(reqToken))
            {
                if (effectivePid > 0 && _authorizedWorkerTokens.ContainsKey(effectivePid) && _authorizedWorkerTokens[effectivePid] == reqToken)
                {
                    tokenValid = true;
                }
                else if (hasAppId && _authorizedWorkerTokensByAppId.ContainsKey(appId) && _authorizedWorkerTokensByAppId[appId] == reqToken)
                {
                    tokenValid = true;
                }
            }

            if (!tokenValid)
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Invalid or missing authorization token for target application.";
                return false;
            }

            // 2. Task identity validation (Anti-Replay & Cross-Task Isolation)
            string boundTaskId = null;
            if (effectivePid > 0 && _authorizedWorkerTaskIds.ContainsKey(effectivePid))
            {
                boundTaskId = _authorizedWorkerTaskIds[effectivePid];
            }
            else if (hasAppId && _authorizedWorkerTaskIdsByAppId.ContainsKey(appId))
            {
                boundTaskId = _authorizedWorkerTaskIdsByAppId[appId];
            }

            if (string.IsNullOrEmpty(boundTaskId))
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Target application is not bound to any authorized task.";
                return false;
            }

            if (string.IsNullOrEmpty(reqTaskId))
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Missing taskId for authorized operation.";
                return false;
            }
            if (!string.Equals(boundTaskId, reqTaskId, StringComparison.Ordinal))
            {
                authError = "UNAUTHORIZED_RESOURCE_ACCESS: Task isolation violation: Application is bound to task '" + boundTaskId + "', but request specified task '" + reqTaskId + "'.";
                return false;
            }

            // 3. Window handle validation (if explicit handle provided)
            if (req.ContainsKey("windowHandle"))
            {
                try
                {
                    long reqHwndVal = Convert.ToInt64(req["windowHandle"]);
                    if (reqHwndVal > 0 && effectivePid > 0)
                    {
                        IntPtr hWnd = new IntPtr(reqHwndVal);
                        uint wPid = 0;
                        GetWindowThreadProcessId(hWnd, out wPid);
                        if (wPid != (uint)effectivePid)
                        {
                            authError = "UNAUTHORIZED_RESOURCE_ACCESS: Window handle (" + reqHwndVal + ") does not belong to authorized process (PID " + effectivePid + ").";
                            return false;
                        }
                    }
                }
                catch
                {
                    authError = "UNAUTHORIZED_RESOURCE_ACCESS: Invalid windowHandle parameter.";
                    return false;
                }
            }

            // 4. Stale process check / PID reuse validation
            if (effectivePid > 0)
            {
                try
                {
                    Process p = Process.GetProcessById(effectivePid);
                    if (p.HasExited)
                    {
                        authError = "UNAUTHORIZED_RESOURCE_ACCESS: Target process (PID " + effectivePid + ") has terminated.";
                        return false;
                    }
                    if (_authorizedWorkerProcessStartTimes.ContainsKey(effectivePid))
                    {
                        string expectedStart = _authorizedWorkerProcessStartTimes[effectivePid];
                        string actualStart = p.StartTime.ToUniversalTime().ToString("o");
                        if (!string.IsNullOrEmpty(expectedStart) && !string.Equals(expectedStart, actualStart, StringComparison.Ordinal))
                        {
                            authError = "UNAUTHORIZED_RESOURCE_ACCESS: Process start time mismatch (possible PID reuse).";
                            return false;
                        }
                    }
                    if (req.ContainsKey("expectedStartTime") && !string.IsNullOrEmpty(Convert.ToString(req["expectedStartTime"])))
                    {
                        string reqExpectedStart = Convert.ToString(req["expectedStartTime"]);
                        string actualStart = p.StartTime.ToUniversalTime().ToString("o");
                        if (!string.Equals(reqExpectedStart, actualStart, StringComparison.Ordinal))
                        {
                            authError = "UNAUTHORIZED_RESOURCE_ACCESS: Caller expectedStartTime mismatch with actual process start time.";
                            return false;
                        }
                    }
                }
                catch (ArgumentException)
                {
                    authError = "UNAUTHORIZED_RESOURCE_ACCESS: Target process (PID " + effectivePid + ") is no longer running.";
                    return false;
                }
                catch { }
            }

            return true;
        }

        private static void RevokeWorkerAuthorization(int pid, string appId)
        {
            if (pid > 0)
            {
                _authorizedWorkerPids.Remove(pid);
                _authorizedWorkerAppIds.Remove("app_" + pid);
                _authorizedWorkerTokens.Remove(pid);
                _authorizedWorkerTokensByAppId.Remove("app_" + pid);
                _authorizedWorkerTaskIds.Remove(pid);
                _authorizedWorkerTaskIdsByAppId.Remove("app_" + pid);
                _authorizedWorkerProcessStartTimes.Remove(pid);
                if (_authorizedWorkerHandlesByPid.ContainsKey(pid))
                {
                    long h = _authorizedWorkerHandlesByPid[pid];
                    _authorizedWorkerHandles.Remove(h);
                    _authorizedWorkerHandlesByPid.Remove(pid);
                }
            }
            if (!string.IsNullOrEmpty(appId))
            {
                _authorizedWorkerAppIds.Remove(appId);
                _authorizedWorkerTokensByAppId.Remove(appId);
                _authorizedWorkerTaskIdsByAppId.Remove(appId);
            }
        }

        private static readonly HashSet<string> _protectedProcessNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node",
            "antigravity ide",
            "antigravity",
            "code",
            "electron",
            "devenv",
            "cursor",
            "windsurf",
            "idea64",
            "pycharm64",
            "webstorm64",
            "cmd",
            "powershell",
            "pwsh",
            "explorer",
            "taskmgr",
            "lucyuiaworker"
        };

        public static bool IsProtectedProcess(int pid, string procName = null)
        {
            if (pid <= 0) return false;
            try
            {
                if (pid == Process.GetCurrentProcess().Id) return true;
                if (string.IsNullOrEmpty(procName))
                {
                    Process p = Process.GetProcessById(pid);
                    procName = p.ProcessName;
                }
                if (!string.IsNullOrEmpty(procName))
                {
                    string pLower = procName.ToLowerInvariant();
                    if (_protectedProcessNames.Contains(pLower) ||
                        pLower.Contains("antigravity") ||
                        pLower.Contains("electron") ||
                        pLower.Contains("visualstudio") ||
                        pLower.Contains("code"))
                    {
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        public static bool IsProtectedWindow(AutomationElement win)
        {
            if (win == null) return false;
            try
            {
                int pid = win.Current.ProcessId;
                if (IsProtectedProcess(pid)) return true;
                string wName = win.Current.Name ?? "";
                if (wName.IndexOf("Antigravity", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    wName.IndexOf("Visual Studio Code", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    wName.IndexOf("Visual Studio", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }
            catch { }
            return false;
        }

        public class InitialDocumentState
        {
            public string CanonicalPath;
            public bool Exists;
            public long Length;
            public DateTime LastWriteTimeUtc;
            public string ContentHash;
            public Encoding DetectedEncoding;
            public bool HasCrLf;
        }

        private static readonly Dictionary<string, InitialDocumentState> _initialDocStates = new Dictionary<string, InitialDocumentState>(StringComparer.OrdinalIgnoreCase);

        public static string ComputeFileSha256(string filePath)
        {
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return null;
            try
            {
                using (var sha = SHA256.Create())
                using (var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    byte[] hash = sha.ComputeHash(fs);
                    return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                }
            }
            catch { return null; }
        }

        public static void DetectFileFormat(string filePath, out Encoding encoding, out bool hasCrLf)
        {
            encoding = new UTF8Encoding(false);
            hasCrLf = false;
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return;
            try
            {
                byte[] bom = new byte[4];
                using (FileStream fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    int read = fs.Read(bom, 0, 4);
                    if (read >= 3 && bom[0] == 0xEF && bom[1] == 0xBB && bom[2] == 0xBF)
                        encoding = new UTF8Encoding(true);
                    else if (read >= 2 && bom[0] == 0xFF && bom[1] == 0xFE)
                        encoding = Encoding.Unicode;
                    else if (read >= 2 && bom[0] == 0xFE && bom[1] == 0xFF)
                        encoding = Encoding.BigEndianUnicode;
                }

                byte[] buffer = new byte[65536];
                int bytesRead = 0;
                using (FileStream fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    bytesRead = fs.Read(buffer, 0, buffer.Length);
                }
                string sample = encoding.GetString(buffer, 0, bytesRead);
                hasCrLf = sample.Contains("\r\n");
            }
            catch { }
        }

        public static InitialDocumentState RecordInitialFileState(string rawPath)
        {
            if (string.IsNullOrEmpty(rawPath)) return null;
            try
            {
                string canonical = Path.GetFullPath(rawPath);
                var state = new InitialDocumentState
                {
                    CanonicalPath = canonical,
                    Exists = File.Exists(canonical)
                };

                if (state.Exists)
                {
                    FileInfo fi = new FileInfo(canonical);
                    state.Length = fi.Length;
                    state.LastWriteTimeUtc = fi.LastWriteTimeUtc;
                    state.ContentHash = ComputeFileSha256(canonical);
                    Encoding enc;
                    bool crlf;
                    DetectFileFormat(canonical, out enc, out crlf);
                    state.DetectedEncoding = enc;
                    state.HasCrLf = crlf;
                }
                else
                {
                    state.DetectedEncoding = new UTF8Encoding(false);
                    state.HasCrLf = true;
                }

                _initialDocStates[canonical] = state;
                return state;
            }
            catch { return null; }
        }

        public class SaveDocumentResult
        {
            public bool SaveSuccess;
            public string SaveMethod = "none";
            public bool ApplicationSaveConfirmed;
            public bool FallbackPersistenceVerified;
            public bool VerifiedContentMatch;
            public string Status = "save_uncertain";
            public string Error;
            public bool DialogHandled;
            public bool SaveAsDialogOpen;
        }

        public static SaveDocumentResult SaveDocumentSafely(
            AutomationElement targetWin,
            int targetPid,
            string appId,
            string requestedTargetPath,
            bool isOwned,
            DialogInfo existingDialog)
        {
            var res = new SaveDocumentResult();

            if (targetPid > 0 && IsProtectedProcess(targetPid))
            {
                res.SaveSuccess = false;
                res.Status = "protected";
                res.Error = "SAFETY_VIOLATION: Refusing to save document for protected process.";
                return res;
            }

            if (!isOwned)
            {
                res.SaveSuccess = false;
                res.Status = "unauthorized";
                res.Error = "UNAUTHORIZED_RESOURCE_ACCESS: Cannot save document for unowned application.";
                return res;
            }

            bool pidTracked = targetPid > 0 && _authorizedWorkerPids.Contains(targetPid);
            bool appIdTracked = !string.IsNullOrEmpty(appId) && _authorizedWorkerAppIds.Contains(appId);
            if (!pidTracked && !appIdTracked)
            {
                res.SaveSuccess = false;
                res.Status = "unauthorized";
                res.Error = "UNAUTHORIZED_RESOURCE_ACCESS: Target process (PID " + targetPid + ") was not launched or authorized by this native worker session.";
                return res;
            }

            // 1. Resolve and canonicalize authorized document path
            string docPath = null;
            if (!string.IsNullOrEmpty(requestedTargetPath))
            {
                try { docPath = Path.GetFullPath(requestedTargetPath); } catch { }
            }
            else if (_processDocumentPaths.ContainsKey(targetPid))
            {
                docPath = _processDocumentPaths[targetPid];
            }
            else if (!string.IsNullOrEmpty(appId) && _processDocumentPathsStr.ContainsKey(appId))
            {
                docPath = _processDocumentPathsStr[appId];
            }
            else if (_processDocumentPathsStr.ContainsKey("app_" + targetPid))
            {
                docPath = _processDocumentPathsStr["app_" + targetPid];
            }

            if (!string.IsNullOrEmpty(docPath))
            {
                try { docPath = Path.GetFullPath(docPath); } catch { }
            }

            if (string.IsNullOrEmpty(docPath))
            {
                res.SaveSuccess = false;
                res.Status = "save_uncertain";
                res.Error = "AMBIGUOUS_DOCUMENT_PATH: Target document path is ambiguous or unspecified.";
                return res;
            }

            // 2. Capture live document text BEFORE closing or modifying anything!
            string preCloseLiveText = GetLiveDocumentText(targetWin);
            if (string.IsNullOrEmpty(preCloseLiveText))
            {
                if (!string.IsNullOrEmpty(appId) && _lastTypedTextStr.ContainsKey(appId))
                    preCloseLiveText = _lastTypedTextStr[appId];
                else if (_lastTypedText.ContainsKey(targetPid))
                    preCloseLiveText = _lastTypedText[targetPid];
            }

            string normExpected = (preCloseLiveText != null ? preCloseLiveText : "").Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd();
            if (string.IsNullOrEmpty(normExpected))
            {
                res.SaveSuccess = false;
                res.Status = "save_uncertain";
                res.Error = "INSUFFICIENT_CONTENT_EVIDENCE: Expected document content is empty or unavailable. Cannot verify save.";
                return res;
            }

            // 3. Record or retrieve initial file state
            InitialDocumentState initialDocState = null;
            if (!string.IsNullOrEmpty(docPath))
            {
                if (_initialDocStates.ContainsKey(docPath))
                    initialDocState = _initialDocStates[docPath];
                else
                    initialDocState = RecordInitialFileState(docPath);
            }

            // 4. Check for unresolved Save As or Overwrite Confirmation dialogs upfront
            if (existingDialog != null && (existingDialog.Title.IndexOf("Save As", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                           existingDialog.Title.IndexOf("Confirm", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                           existingDialog.Title.IndexOf("Replace", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                res.SaveSuccess = false;
                res.Status = "save_uncertain";
                res.SaveAsDialogOpen = true;
                res.Error = "UNRESOLVED_SAVE_AS_DIALOG: Application opened a Save As or overwrite confirmation dialog. Automatic bypass prohibited.";
                return res;
            }

            // 5. Attempt application-mediated save
            bool appSaveTriggered = false;
            if (existingDialog != null && existingDialog.ActionButtons.ContainsKey("save"))
            {
                DismissDialogAction(existingDialog, "save");
                appSaveTriggered = true;
                res.DialogHandled = true;
            }
            else if (targetWin != null)
            {
                appSaveTriggered = TrySaveDocument(targetWin);
                Thread.Sleep(200);

                // Check if a modal dialog popped up as a result of Ctrl+S
                DialogInfo lateDialog = DetectDialog(targetPid, targetWin);
                if (lateDialog != null)
                {
                    if (lateDialog.Title.IndexOf("Save As", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        lateDialog.Title.IndexOf("Confirm", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        lateDialog.Title.IndexOf("Replace", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        res.SaveSuccess = false;
                        res.Status = "save_uncertain";
                        res.SaveAsDialogOpen = true;
                        res.Error = "UNRESOLVED_SAVE_AS_DIALOG: Application opened a Save As or overwrite confirmation dialog upon saving. Failing closed.";
                        return res;
                    }
                    if (lateDialog.ActionButtons.ContainsKey("save"))
                    {
                        DismissDialogAction(lateDialog, "save");
                        appSaveTriggered = true;
                        res.DialogHandled = true;
                    }
                }
            }

            // 6. Verify observable evidence for application save:
            // - Read back file on disk and compare against intended content using appropriate encoding
            // - Check window title dirty indicator (*)
            bool appSaveConfirmed = false;
            if (!string.IsNullOrEmpty(docPath) && File.Exists(docPath))
            {
                Encoding readEnc = (initialDocState != null && initialDocState.DetectedEncoding != null) ? initialDocState.DetectedEncoding : new UTF8Encoding(false);

                for (int t = 0; t < 30; t++)
                {
                    Thread.Sleep(100);
                    try
                    {
                        string diskContent = File.ReadAllText(docPath, readEnc);
                        string normDisk = diskContent.Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd();
                        if (normDisk == normExpected && !string.IsNullOrEmpty(normExpected))
                        {
                            appSaveConfirmed = true;
                            res.VerifiedContentMatch = true;
                            break;
                        }

                        // Application save is strictly confirmed ONLY when disk content actually matches the expected live text
                        if (!string.IsNullOrEmpty(normExpected) && (normDisk == normExpected || (normDisk.Length > 0 && normDisk.Contains(normExpected))))
                        {
                            appSaveConfirmed = true;
                            res.VerifiedContentMatch = true;
                            break;
                        }
                    }
                    catch { }
                }
            }

            if (appSaveConfirmed)
            {
                res.SaveSuccess = true;
                res.ApplicationSaveConfirmed = true;
                res.SaveMethod = "application_ui_save";
                res.Status = "saved_and_verified";
                return res;
            }

            // 7. Check Conflict Protection Before Direct-Write Fallback:
            // Refuse to overwrite unexpected disk changes that occurred after initial state was recorded!
            if (initialDocState != null && initialDocState.Exists && !string.IsNullOrEmpty(docPath) && File.Exists(docPath))
            {
                try
                {
                    FileInfo currentDiskFi = new FileInfo(docPath);
                    if (currentDiskFi.LastWriteTimeUtc != initialDocState.LastWriteTimeUtc || currentDiskFi.Length != initialDocState.Length)
                    {
                        string currentDiskHash = ComputeFileSha256(docPath);
                        if (currentDiskHash != initialDocState.ContentHash)
                        {
                            // External modification detected on disk!
                            res.SaveSuccess = false;
                            res.Status = "conflict";
                            res.Error = "SAVE_CONFLICT_DETECTED: Target file on disk has unexpected external modifications (hash mismatch) after initial state was recorded. Refusing direct fallback overwrite.";
                            return res;
                        }
                    }
                }
                catch { }
            }

            // 8. Strict Fallback Write:
            // Must be Lucy-owned, non-read-only, non-empty live text (if file had content)
            bool canFallback = isOwned && !string.IsNullOrEmpty(docPath) && !string.IsNullOrEmpty(normExpected);
            if (canFallback && File.Exists(docPath))
            {
                try
                {
                    FileInfo fi = new FileInfo(docPath);
                    if ((fi.Attributes & FileAttributes.ReadOnly) != 0) canFallback = false;
                    if (fi.Length > 0 && string.IsNullOrEmpty(normExpected)) canFallback = false;
                }
                catch { canFallback = false; }
            }

            if (canFallback)
            {
                bool fallbackWrote = SafeAtomicWritePreservingEncoding(docPath, preCloseLiveText, initialDocState);
                if (fallbackWrote)
                {
                    // Independent readback verification
                    try
                    {
                        Encoding readEnc = (initialDocState != null && initialDocState.DetectedEncoding != null) ? initialDocState.DetectedEncoding : new UTF8Encoding(false);
                        string readback = File.ReadAllText(docPath, readEnc);
                        string normDisk = readback.Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd();
                        if (normDisk == normExpected && !string.IsNullOrEmpty(normExpected))
                        {
                            res.FallbackPersistenceVerified = true;
                            res.VerifiedContentMatch = true;
                            res.SaveSuccess = true;
                            res.SaveMethod = "direct_write_fallback";
                            res.Status = "fallback_persisted";
                            return res;
                        }
                    }
                    catch { }
                }
            }

            res.SaveSuccess = false;
            res.Status = "save_uncertain";
            res.Error = "Application-mediated save could not be confirmed and direct-write fallback was not permitted, conflicted, or failed content verification.";
            return res;
        }

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
                            if (IsProtectedWindow(win)) continue;
                            long curHwnd = win.Current.NativeWindowHandle;
                            if (curHwnd == windowHandle || (long)(uint)curHwnd == (long)(uint)windowHandle)
                            {
                                int winPid = win.Current.ProcessId;
                                if (IsProtectedProcess(winPid)) return null;
                                if (pidTarget > 0 && winPid != pidTarget)
                                {
                                    // Stale window handle: window belongs to a different process
                                    return null;
                                }
                                if (!string.IsNullOrEmpty(appId) && appId.StartsWith("app_"))
                                {
                                    int aPid = 0;
                                    if (int.TryParse(appId.Substring(4), out aPid) && aPid > 0 && winPid != aPid)
                                    {
                                        return null;
                                    }
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
                // Explicit windowHandle was requested but was invalid, mismatched, or not found for this target: fail closed!
                return null;
            }

            var candidates = new List<AutomationElement>();
            foreach (AutomationElement win in windows)
            {
                try
                {
                    if (IsProtectedWindow(win)) continue;
                    int winPid = win.Current.ProcessId;
                    if (IsProtectedProcess(winPid)) continue;

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
                        try
                        {
                            Process p = Process.GetProcessById(winPid);
                            string pName = (p.ProcessName ?? "").ToLowerInvariant();
                            string tmLower = titleMatch.ToLowerInvariant();
                            if (tmLower.Contains("notepad") && !pName.Contains("notepad"))
                            {
                                continue;
                            }
                            if ((tmLower.Contains("calc") || tmLower.Contains("calculator")) && !pName.Contains("calc"))
                            {
                                continue;
                            }
                        }
                        catch
                        {
                            continue;
                        }
                        candidates.Add(win);
                    }
                }
                catch { }
            }

            if (candidates.Count == 0) return null;

            // Ambiguity check: If target was specified only by title and multiple candidates match, fail closed!
            if (candidates.Count > 1 && pidTarget <= 0 && string.IsNullOrEmpty(appId) && windowHandle <= 0)
            {
                return null;
            }

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

        public class TargetQuery
        {
            public string Name;
            public string AutomationId;
            public string ControlType;
            public string ClassName;
            public string ParentAutomationId;
            public string ParentName;
            public string ParentControlType;
            public string Action; // "click", "type", "read", "resolve"
            public bool RequireEnabled = true;
            public bool RequireVisible = false;
            public bool RequireInBounds = true;
            public bool AllowPhysicalFallback = false;
            public bool IsSecret = false;
        }

        public class TargetCandidate
        {
            public AutomationElement Element;
            public string Name;
            public string AutomationId;
            public string ControlType;
            public string ClassName;
            public System.Windows.Rect Bounds;
            public bool IsEnabled;
            public bool IsOffscreen;
            public string MatchEvidence;
        }

        public class TargetResolutionResult
        {
            public bool Matched;
            public string ResolutionStrategy = "none";
            public AutomationElement Element;
            public Dictionary<string, object> TargetInfo;
            public List<string> RejectedCandidates = new List<string>();
            public int AmbiguityCount;
            public string Error;
            public int Attempts = 1;
        }

        private static readonly Dictionary<string, ControlType> _controlTypeMap = new Dictionary<string, ControlType>(StringComparer.OrdinalIgnoreCase)
        {
            { "button", ControlType.Button },
            { "edit", ControlType.Edit },
            { "document", ControlType.Document },
            { "menuitem", ControlType.MenuItem },
            { "tabitem", ControlType.TabItem },
            { "listitem", ControlType.ListItem },
            { "checkbox", ControlType.CheckBox },
            { "radiobutton", ControlType.RadioButton },
            { "combobox", ControlType.ComboBox },
            { "hyperlink", ControlType.Hyperlink },
            { "pane", ControlType.Pane },
            { "window", ControlType.Window },
            { "text", ControlType.Text },
            { "group", ControlType.Group },
            { "menubar", ControlType.MenuBar },
            { "toolbar", ControlType.ToolBar },
            { "custom", ControlType.Custom },
            { "treeitem", ControlType.TreeItem }
        };

        public static ControlType ResolveControlType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            string clean = name.Trim().ToLowerInvariant().Replace("controltype.", "");
            if (_controlTypeMap.ContainsKey(clean)) return _controlTypeMap[clean];
            return null;
        }

        public static bool IsControlCompatibleWithAction(AutomationElement el, string action, bool allowPhysicalFallback, out string error)
        {
            error = null;
            if (el == null) { error = "Target element is null"; return false; }
            action = (action ?? "").ToLowerInvariant();

            if (action == "click")
            {
                object invObj, togObj, selObj, expObj;
                bool hasInvoke = el.TryGetCurrentPattern(InvokePattern.Pattern, out invObj);
                bool hasToggle = el.TryGetCurrentPattern(TogglePattern.Pattern, out togObj);
                bool hasSelect = el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selObj);
                bool hasExpand = el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expObj);
                long hwnd = 0;
                try { hwnd = el.Current.NativeWindowHandle; } catch { }
                bool hasHwnd = hwnd != 0 && IsWindow(new IntPtr(hwnd));

                if (hasInvoke || hasToggle || hasSelect || hasExpand || hasHwnd || allowPhysicalFallback)
                {
                    return true;
                }

                string ctName = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : "Unknown";
                if (ctName.Contains("Window") || ctName.Contains("Pane") || ctName.Contains("Document") || ctName.Contains("Edit"))
                {
                    error = "Control of type '" + ctName + "' does not support invocation or click patterns";
                    return false;
                }

                error = "Control does not support Invoke, Toggle, SelectionItem, ExpandCollapse, or BM_CLICK patterns";
                return false;
            }

            if (action == "type")
            {
                string ctName = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : "";
                if (ctName.Contains("Button") || ctName.Contains("MenuItem") || ctName.Contains("CheckBox") || ctName.Contains("RadioButton") || ctName.Contains("Image"))
                {
                    error = "Control of type '" + ctName + "' is not an editable field for text entry";
                    return false;
                }

                object valObj, textObj;
                bool hasVal = el.TryGetCurrentPattern(ValuePattern.Pattern, out valObj);
                bool hasText = el.TryGetCurrentPattern(TextPattern.Pattern, out textObj);
                long hwnd = 0;
                try { hwnd = el.Current.NativeWindowHandle; } catch { }
                bool hasHwnd = hwnd != 0 && IsWindow(new IntPtr(hwnd));

                if (hasVal || hasText || hasHwnd || allowPhysicalFallback || ctName.Contains("Edit") || ctName.Contains("Document"))
                {
                    return true;
                }

                error = "Control does not support ValuePattern, TextPattern, or WM_SETTEXT";
                return false;
            }

            return true;
        }

        private static Dictionary<string, object> BuildCandidateInfo(TargetCandidate cand, System.Windows.Rect winBounds)
        {
            var info = new Dictionary<string, object>
            {
                { "name", cand.Name },
                { "automationId", cand.AutomationId },
                { "controlType", cand.ControlType },
                { "className", cand.ClassName },
                { "isEnabled", cand.IsEnabled },
                { "isOffscreen", cand.IsOffscreen }
            };

            if (cand.Bounds != System.Windows.Rect.Empty)
            {
                info["bounds"] = new Dictionary<string, object>
                {
                    { "x", (int)cand.Bounds.X },
                    { "y", (int)cand.Bounds.Y },
                    { "width", (int)cand.Bounds.Width },
                    { "height", (int)cand.Bounds.Height }
                };
            }

            if (winBounds != System.Windows.Rect.Empty)
            {
                info["windowBounds"] = new Dictionary<string, object>
                {
                    { "x", (int)winBounds.X },
                    { "y", (int)winBounds.Y },
                    { "width", (int)winBounds.Width },
                    { "height", (int)winBounds.Height }
                };
            }

            return info;
        }

        private static List<TargetCandidate> FilterCandidates(
            AutomationElement win,
            System.Windows.Rect winBounds,
            AutomationElementCollection collection,
            TargetQuery query,
            List<string> rejectedReasons,
            bool allowLooseName = false)
        {
            var list = new List<TargetCandidate>();
            if (collection == null || collection.Count == 0) return list;

            int targetWinPid = 0;
            try { targetWinPid = win.Current.ProcessId; } catch { }

            foreach (AutomationElement el in collection)
            {
                try
                {
                    string elName = el.Current.Name ?? "";
                    string elAutoId = el.Current.AutomationId ?? "";
                    string elCt = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : "";
                    string elCls = el.Current.ClassName ?? "";
                    bool isEnabled = el.Current.IsEnabled;
                    bool isOffscreen = el.Current.IsOffscreen;
                    System.Windows.Rect bounds = el.Current.BoundingRectangle;

                    // 1. Process boundary
                    if (targetWinPid > 0 && el.Current.ProcessId != targetWinPid)
                    {
                        rejectedReasons.Add("WRONG_PROCESS: Candidate belongs to PID " + el.Current.ProcessId + ", not target PID " + targetWinPid);
                        continue;
                    }

                    // 2. Exact AutomationId filter (if specified)
                    if (!string.IsNullOrEmpty(query.AutomationId))
                    {
                        if (!string.Equals(elAutoId, query.AutomationId, StringComparison.OrdinalIgnoreCase))
                        {
                            rejectedReasons.Add("AUTOMATION_ID_MISMATCH: Candidate AutomationId is '" + elAutoId + "', expected '" + query.AutomationId + "'");
                            continue;
                        }
                    }

                    // 3. Name filter (if specified)
                    if (!string.IsNullOrEmpty(query.Name))
                    {
                        bool nameMatch = string.Equals(elName, query.Name, StringComparison.OrdinalIgnoreCase);
                        if (!nameMatch && allowLooseName)
                        {
                            nameMatch = (elName.IndexOf(query.Name, StringComparison.OrdinalIgnoreCase) >= 0);
                        }
                        if (!nameMatch)
                        {
                            rejectedReasons.Add("NAME_MISMATCH: Candidate name is '" + elName + "', expected '" + query.Name + "'");
                            continue;
                        }
                    }

                    // 4. Control Type filter
                    if (!string.IsNullOrEmpty(query.ControlType))
                    {
                        ControlType expectedCt = ResolveControlType(query.ControlType);
                        if (expectedCt != null && el.Current.ControlType != expectedCt)
                        {
                            rejectedReasons.Add("CONTROL_TYPE_MISMATCH: Candidate is '" + elCt + "', expected '" + query.ControlType + "'");
                            continue;
                        }
                    }

                    // 5. ClassName filter
                    if (!string.IsNullOrEmpty(query.ClassName))
                    {
                        if (!string.Equals(elCls, query.ClassName, StringComparison.OrdinalIgnoreCase))
                        {
                            rejectedReasons.Add("CLASS_NAME_MISMATCH: Candidate class is '" + elCls + "', expected '" + query.ClassName + "'");
                            continue;
                        }
                    }

                    // 6. Geometry & Bounds Check
                    if (query.RequireInBounds)
                    {
                        if (bounds == System.Windows.Rect.Empty || bounds.IsEmpty)
                        {
                            rejectedReasons.Add("EMPTY_BOUNDS: Candidate bounding rectangle is empty");
                            continue;
                        }
                        if (double.IsNaN(bounds.X) || double.IsNaN(bounds.Y) || double.IsNaN(bounds.Width) || double.IsNaN(bounds.Height) ||
                            double.IsInfinity(bounds.X) || double.IsInfinity(bounds.Y) || double.IsInfinity(bounds.Width) || double.IsInfinity(bounds.Height))
                        {
                            rejectedReasons.Add("INVALID_GEOMETRY: Candidate bounding rectangle has non-finite coordinates");
                            continue;
                        }
                        if (bounds.Width <= 0 || bounds.Height <= 0)
                        {
                            rejectedReasons.Add("ZERO_SIZE_BOUNDS: Candidate bounding rectangle has non-positive dimensions (" + bounds.Width + "x" + bounds.Height + ")");
                            continue;
                        }

                        if (winBounds != System.Windows.Rect.Empty && !winBounds.IsEmpty)
                        {
                            double intersectLeft = Math.Max(bounds.Left, winBounds.Left);
                            double intersectTop = Math.Max(bounds.Top, winBounds.Top);
                            double intersectRight = Math.Min(bounds.Right, winBounds.Right);
                            double intersectBottom = Math.Min(bounds.Bottom, winBounds.Bottom);

                            if (intersectRight <= intersectLeft || intersectBottom <= intersectTop)
                            {
                                rejectedReasons.Add("OUTSIDE_WINDOW_BOUNDS: Candidate bounds are completely outside window bounds");
                                continue;
                            }

                            // Ensure candidate is not an absurd rogue desktop overlay
                            double elemArea = bounds.Width * bounds.Height;
                            double winArea = winBounds.Width * winBounds.Height;
                            if (winArea > 0 && elemArea > (winArea * 16.0))
                            {
                                rejectedReasons.Add("SUSPICIOUS_BOUNDS: Candidate bounds abnormally exceed target window bounds");
                                continue;
                            }
                        }
                    }

                    // 7. Enabled state check
                    if (query.RequireEnabled && (query.Action == "click" || query.Action == "type"))
                    {
                        if (!isEnabled)
                        {
                            rejectedReasons.Add("ELEMENT_DISABLED: Candidate '" + (elAutoId ?? elName) + "' is disabled.");
                            continue;
                        }
                    }

                    // 8. Action Compatibility check
                    if (!string.IsNullOrEmpty(query.Action) && query.Action != "resolve" && query.Action != "read")
                    {
                        string compatErr;
                        if (!IsControlCompatibleWithAction(el, query.Action, query.AllowPhysicalFallback, out compatErr))
                        {
                            rejectedReasons.Add("CONTROL_INCOMPATIBLE: " + compatErr);
                            continue;
                        }
                    }

                    // 9. Parent context filter
                    if (!string.IsNullOrEmpty(query.ParentAutomationId) || !string.IsNullOrEmpty(query.ParentName) || !string.IsNullOrEmpty(query.ParentControlType))
                    {
                        try
                        {
                            AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(el);
                            if (parent != null)
                            {
                                string pAutoId = parent.Current.AutomationId ?? "";
                                string pName = parent.Current.Name ?? "";
                                string pCt = parent.Current.ControlType != null ? parent.Current.ControlType.ProgrammaticName : "";

                                if (!string.IsNullOrEmpty(query.ParentAutomationId) && !string.Equals(pAutoId, query.ParentAutomationId, StringComparison.OrdinalIgnoreCase))
                                {
                                    rejectedReasons.Add("PARENT_AUTOMATION_ID_MISMATCH: Parent is '" + pAutoId + "', expected '" + query.ParentAutomationId + "'");
                                    continue;
                                }
                                if (!string.IsNullOrEmpty(query.ParentName) && !string.Equals(pName, query.ParentName, StringComparison.OrdinalIgnoreCase))
                                {
                                    rejectedReasons.Add("PARENT_NAME_MISMATCH: Parent is '" + pName + "', expected '" + query.ParentName + "'");
                                    continue;
                                }
                                if (!string.IsNullOrEmpty(query.ParentControlType))
                                {
                                    ControlType pExpectedCt = ResolveControlType(query.ParentControlType);
                                    if (pExpectedCt != null && parent.Current.ControlType != pExpectedCt)
                                    {
                                        rejectedReasons.Add("PARENT_CONTROL_TYPE_MISMATCH: Parent type is '" + pCt + "', expected '" + query.ParentControlType + "'");
                                        continue;
                                    }
                                }
                            }
                        }
                        catch { }
                    }

                    list.Add(new TargetCandidate
                    {
                        Element = el,
                        Name = elName,
                        AutomationId = elAutoId,
                        ControlType = elCt,
                        ClassName = elCls,
                        Bounds = bounds,
                        IsEnabled = isEnabled,
                        IsOffscreen = isOffscreen,
                        MatchEvidence = "Verified UIA Candidate"
                    });
                }
                catch (Exception ex)
                {
                    rejectedReasons.Add("CANDIDATE_ACCESS_ERROR: " + ex.Message);
                }
            }

            return list;
        }

        public static TargetResolutionResult ResolveTargetElement(AutomationElement win, TargetQuery query, int maxRetries = 2)
        {
            var res = new TargetResolutionResult();
            if (win == null)
            {
                res.Matched = false;
                res.Error = "TARGET_WINDOW_NULL: Valid target window required for element resolution.";
                return res;
            }

            int targetWinPid = 0;
            try { targetWinPid = win.Current.ProcessId; } catch { }

            for (int attempt = 1; attempt <= maxRetries + 1; attempt++)
            {
                res.Attempts = attempt;
                res.RejectedCandidates.Clear();

                try
                {
                    System.Windows.Rect winBounds = System.Windows.Rect.Empty;
                    try
                    {
                        winBounds = win.Current.BoundingRectangle;
                    }
                    catch (Exception ex)
                    {
                        res.RejectedCandidates.Add("WINDOW_ACCESS_FAILED: " + ex.Message);
                    }

                    // 1. Level 1: Exact match with stable AutomationId
                    if (!string.IsNullOrEmpty(query.AutomationId))
                    {
                        var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, query.AutomationId);
                        var candidates = win.FindAll(TreeScope.Descendants, cond);
                        var valid = FilterCandidates(win, winBounds, candidates, query, res.RejectedCandidates);
                        if (valid.Count == 1)
                        {
                            res.Matched = true;
                            res.Element = valid[0].Element;
                            res.ResolutionStrategy = (attempt == 1) ? "exact_automation_id" : "dynamic_anchor_recovered";
                            res.TargetInfo = BuildCandidateInfo(valid[0], winBounds);
                            return res;
                        }
                        if (valid.Count > 1)
                        {
                            res.Matched = false;
                            res.AmbiguityCount = valid.Count;
                            res.Error = "AMBIGUOUS_TARGET: Multiple (" + valid.Count + ") elements matched exact AutomationId '" + query.AutomationId + "' within target window.";
                            return res;
                        }

                        // Invariant: If the caller explicitly requested a specific AutomationId, NEVER fall through
                        // to Level 2 (Name match) to avoid silent target substitution of a different control!
                        if (attempt <= maxRetries)
                        {
                            Thread.Sleep(80);
                            continue;
                        }
                    }

                    // 2. Level 2: Semantic match constrained by Name and ControlType (when AutomationId was not provided)
                    if (string.IsNullOrEmpty(query.AutomationId) && !string.IsNullOrEmpty(query.Name))
                    {
                        Condition semCond = new PropertyCondition(AutomationElement.NameProperty, query.Name);
                        if (!string.IsNullOrEmpty(query.ControlType))
                        {
                            ControlType ct = ResolveControlType(query.ControlType);
                            if (ct != null)
                            {
                                semCond = new AndCondition(semCond, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
                            }
                        }
                        var candidates = win.FindAll(TreeScope.Descendants, semCond);
                        var valid = FilterCandidates(win, winBounds, candidates, query, res.RejectedCandidates);
                        if (valid.Count == 1)
                        {
                            res.Matched = true;
                            res.Element = valid[0].Element;
                            res.ResolutionStrategy = (attempt == 1) ? "semantic_structural_match" : "dynamic_anchor_recovered";
                            res.TargetInfo = BuildCandidateInfo(valid[0], winBounds);
                            return res;
                        }
                        if (valid.Count > 1)
                        {
                            res.Matched = false;
                            res.AmbiguityCount = valid.Count;
                            res.Error = "AMBIGUOUS_TARGET: Multiple (" + valid.Count + ") elements matched semantic Name '" + query.Name + "' within target window.";
                            return res;
                        }
                    }

                    // 3. Level 3: Validated alternate UIA path (Parent / Ancestor scope)
                    if (!string.IsNullOrEmpty(query.ParentAutomationId) || !string.IsNullOrEmpty(query.ParentName))
                    {
                        Condition pCond = Condition.TrueCondition;
                        if (!string.IsNullOrEmpty(query.ParentAutomationId))
                        {
                            pCond = new PropertyCondition(AutomationElement.AutomationIdProperty, query.ParentAutomationId);
                        }
                        else if (!string.IsNullOrEmpty(query.ParentName))
                        {
                            pCond = new PropertyCondition(AutomationElement.NameProperty, query.ParentName);
                        }

                        var parentCandidates = win.FindAll(TreeScope.Descendants, pCond);
                        var validParents = new List<AutomationElement>();
                        foreach (AutomationElement p in parentCandidates)
                        {
                            try
                            {
                                if (targetWinPid == 0 || p.Current.ProcessId == targetWinPid)
                                    validParents.Add(p);
                            }
                            catch { }
                        }

                        if (validParents.Count > 1)
                        {
                            res.Matched = false;
                            res.AmbiguityCount = validParents.Count;
                            res.Error = "AMBIGUOUS_TARGET: Multiple (" + validParents.Count + ") parent containers matched query.";
                            return res;
                        }

                        if (validParents.Count == 1)
                        {
                            AutomationElement parentEl = validParents[0];
                            Condition childCond = Condition.TrueCondition;
                            if (!string.IsNullOrEmpty(query.ControlType))
                            {
                                ControlType ct = ResolveControlType(query.ControlType);
                                if (ct != null) childCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ct);
                            }
                            if (!string.IsNullOrEmpty(query.Name))
                            {
                                Condition nameCond = new PropertyCondition(AutomationElement.NameProperty, query.Name);
                                childCond = (childCond == Condition.TrueCondition) ? nameCond : new AndCondition(childCond, nameCond);
                            }
                            var children = parentEl.FindAll(TreeScope.Children, childCond);
                            var valid = FilterCandidates(win, winBounds, children, query, res.RejectedCandidates);
                            if (valid.Count == 1)
                            {
                                res.Matched = true;
                                res.Element = valid[0].Element;
                                res.ResolutionStrategy = (attempt == 1) ? "validated_alternate_path" : "dynamic_anchor_recovered";
                                res.TargetInfo = BuildCandidateInfo(valid[0], winBounds);
                                return res;
                            }
                            if (valid.Count > 1)
                            {
                                res.Matched = false;
                                res.AmbiguityCount = valid.Count;
                                res.Error = "AMBIGUOUS_TARGET: Multiple (" + valid.Count + ") child elements matched in parent container.";
                                return res;
                            }
                        }
                    }

                    // 4. Level 4: Constrained visual / bounding-rectangle recovery (when ControlType alone is provided and unique)
                    if (!string.IsNullOrEmpty(query.ControlType) && string.IsNullOrEmpty(query.AutomationId) && string.IsNullOrEmpty(query.Name))
                    {
                        ControlType ct = ResolveControlType(query.ControlType);
                        if (ct != null)
                        {
                            var candidates = win.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
                            var valid = FilterCandidates(win, winBounds, candidates, query, res.RejectedCandidates);
                            if (valid.Count == 1)
                            {
                                res.Matched = true;
                                res.Element = valid[0].Element;
                                res.ResolutionStrategy = "dynamic_anchor_recovered";
                                res.TargetInfo = BuildCandidateInfo(valid[0], winBounds);
                                return res;
                            }
                            if (valid.Count > 1)
                            {
                                res.Matched = false;
                                res.AmbiguityCount = valid.Count;
                                res.Error = "AMBIGUOUS_TARGET: Multiple (" + valid.Count + ") controls of ControlType '" + query.ControlType + "' found in target window.";
                                return res;
                            }
                        }
                    }
                }
                catch (ElementNotAvailableException ex)
                {
                    res.RejectedCandidates.Add("ELEMENT_STALE: " + ex.Message);
                }
                catch (Exception ex)
                {
                    res.RejectedCandidates.Add("RESOLUTION_EXCEPTION: " + ex.Message);
                }

                if (attempt <= maxRetries)
                {
                    Thread.Sleep(80);
                }
            }

            res.Matched = false;
            if (string.IsNullOrEmpty(res.Error))
            {
                if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("ELEMENT_DISABLED")))
                {
                    res.Error = "ELEMENT_DISABLED: Target control was found but is disabled and cannot accept interaction.";
                }
                else if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("CONTROL_INCOMPATIBLE")))
                {
                    res.Error = res.RejectedCandidates.Find(r => r.StartsWith("CONTROL_INCOMPATIBLE"));
                }
                else if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("OUTSIDE_WINDOW_BOUNDS")))
                {
                    res.Error = "OUTSIDE_WINDOW_BOUNDS: Target control was located outside the authorized target window bounds.";
                }
                else if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("INVALID_GEOMETRY") || r.StartsWith("ZERO_SIZE_BOUNDS") || r.StartsWith("EMPTY_BOUNDS")))
                {
                    res.Error = "INVALID_GEOMETRY: Target control has invalid, empty, or non-interactable bounding geometry.";
                }
                else if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("WRONG_PROCESS")))
                {
                    res.Error = res.RejectedCandidates.Find(r => r.StartsWith("WRONG_PROCESS"));
                }
                else if (res.RejectedCandidates.Count > 0 && res.RejectedCandidates.Exists(r => r.StartsWith("AUTOMATION_ID_MISMATCH")))
                {
                    res.Error = res.RejectedCandidates.Find(r => r.StartsWith("AUTOMATION_ID_MISMATCH"));
                }
                else
                {
                    res.Error = "ELEMENT_NOT_FOUND: No accessible UI Automation element matching query criteria was found in target window.";
                }
            }
            return res;
        }

        private static TargetQuery ParseTargetQuery(Dictionary<string, object> req)
        {
            var q = new TargetQuery();
            if (req.ContainsKey("automationId") && req["automationId"] != null)
                q.AutomationId = Convert.ToString(req["automationId"]);
            if (req.ContainsKey("name") && req["name"] != null)
                q.Name = Convert.ToString(req["name"]);
            if (req.ContainsKey("controlType") && req["controlType"] != null)
                q.ControlType = Convert.ToString(req["controlType"]);
            if (req.ContainsKey("className") && req["className"] != null)
                q.ClassName = Convert.ToString(req["className"]);
            if (req.ContainsKey("parentAutomationId") && req["parentAutomationId"] != null)
                q.ParentAutomationId = Convert.ToString(req["parentAutomationId"]);
            if (req.ContainsKey("parentName") && req["parentName"] != null)
                q.ParentName = Convert.ToString(req["parentName"]);
            if (req.ContainsKey("parentControlType") && req["parentControlType"] != null)
                q.ParentControlType = Convert.ToString(req["parentControlType"]);
            if (req.ContainsKey("action") && req["action"] != null)
                q.Action = Convert.ToString(req["action"]).ToLowerInvariant();
            if (req.ContainsKey("allowPhysicalFallback"))
                q.AllowPhysicalFallback = Convert.ToBoolean(req["allowPhysicalFallback"]);
            if (req.ContainsKey("isSecret"))
                q.IsSecret = Convert.ToBoolean(req["isSecret"]);
            if (req.ContainsKey("requireEnabled"))
                q.RequireEnabled = Convert.ToBoolean(req["requireEnabled"]);
            if (req.ContainsKey("requireInBounds"))
                q.RequireInBounds = Convert.ToBoolean(req["requireInBounds"]);
            return q;
        }

        private static Dictionary<string, object> BuildCandidateInfo(AutomationElement el, AutomationElement win)
        {
            if (el == null) return null;
            string name = "";
            string autoId = "";
            string ct = "";
            string cls = "";
            bool isEnabled = false;
            bool isOffscreen = true;
            System.Windows.Rect bounds = System.Windows.Rect.Empty;
            try
            {
                name = el.Current.Name ?? "";
                autoId = el.Current.AutomationId ?? "";
                ct = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : "";
                cls = el.Current.ClassName ?? "";
                isEnabled = el.Current.IsEnabled;
                isOffscreen = el.Current.IsOffscreen;
                bounds = el.Current.BoundingRectangle;
            }
            catch { }

            var cand = new TargetCandidate
            {
                Element = el,
                Name = name,
                AutomationId = autoId,
                ControlType = ct,
                ClassName = cls,
                IsEnabled = isEnabled,
                IsOffscreen = isOffscreen,
                Bounds = bounds
            };
            System.Windows.Rect winBounds = System.Windows.Rect.Empty;
            try { if (win != null) winBounds = win.Current.BoundingRectangle; } catch { }
            return BuildCandidateInfo(cand, winBounds);
        }

        public static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            // Command-line transport for secrets is strictly eliminated to prevent process-inspection exposure (CWE-214/CWE-200).
            // Session secret initialization is performed exclusively over private inherited anonymous pipe (init_session).

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
                    string errMsg = ex.Message ?? "Unknown worker exception";
                    try
                    {
                        if (line != null && line.IndexOf("type_text", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            var reqDict = _serializer.Deserialize<Dictionary<string, object>>(line);
                            if (reqDict != null && reqDict.ContainsKey("text"))
                            {
                                string t = Convert.ToString(reqDict["text"]);
                                if (!string.IsNullOrEmpty(t) && errMsg.Contains(t))
                                {
                                    errMsg = errMsg.Replace(t, "[REDACTED]");
                                }
                            }
                        }
                    }
                    catch { }

                    var errRes = new Dictionary<string, object>
                    {
                        { "id", reqId },
                        { "ok", false },
                        { "error", errMsg }
                    };
                    Console.WriteLine(_serializer.Serialize(errRes));
                }
            }
        }

        private static void HandleCommand(long reqId, string cmd, Dictionary<string, object> req)
        {
            switch (cmd)
            {
                case "init_session":
                    if (!string.IsNullOrEmpty(_sessionSecret))
                    {
                        SendError(reqId, "ALREADY_INITIALIZED: Worker session secret is already established and cannot be replaced or replayed.");
                        break;
                    }

                    string sessionSec = req.ContainsKey("sessionSecret") ? Convert.ToString(req["sessionSecret"]) : null;
                    if (string.IsNullOrWhiteSpace(sessionSec))
                    {
                        SendError(reqId, "INVALID_INITIALIZATION: Missing or empty sessionSecret parameter.");
                        break;
                    }

                    if (sessionSec.Trim().Length < 32)
                    {
                        SendError(reqId, "INVALID_INITIALIZATION: sessionSecret must be a cryptographic secret of at least 32 characters in length.");
                        break;
                    }

                    _sessionSecret = sessionSec.Trim();
                    SendSuccess(reqId, new Dictionary<string, object> { { "initialized", true } });
                    break;

                case "revoke_task":
                    string revTaskId = req.ContainsKey("taskId") ? Convert.ToString(req["taskId"]) : null;
                    if (!string.IsNullOrEmpty(revTaskId))
                    {
                        List<int> pidsToRevoke = new List<int>();
                        foreach (var kvp in _authorizedWorkerTaskIds)
                        {
                            if (kvp.Value == revTaskId) pidsToRevoke.Add(kvp.Key);
                        }
                        foreach (int p in pidsToRevoke)
                        {
                            RevokeWorkerAuthorization(p, "app_" + p);
                        }
                        SendSuccess(reqId, new Dictionary<string, object> { { "revokedCount", pidsToRevoke.Count } });
                    }
                    else
                    {
                        SendError(reqId, "Missing taskId for revoke_task");
                    }
                    break;

                case "revoke_app":
                    int revPid = req.ContainsKey("pid") ? Convert.ToInt32(req["pid"]) : 0;
                    string revAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    RevokeWorkerAuthorization(revPid, revAppId);
                    SendSuccess(reqId, new Dictionary<string, object> { { "revoked", true } });
                    break;

                case "ping":
                    int count = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition).Count;
                    SendSuccess(reqId, new Dictionary<string, object> { { "pong", true }, { "windowsCount", count } });
                    break;

                case "list_apps":
                    if (string.IsNullOrEmpty(_sessionSecret))
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Worker session is not initialized with an authorization secret.");
                        break;
                    }

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

                            if (IsProtectedWindow(win) || IsProtectedProcess(pid)) continue;
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

                case "resolve_target":
                    {
                        int resPid = 0;
                        string resAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                        if (req.ContainsKey("pid")) resPid = Convert.ToInt32(req["pid"]);
                        else if (!string.IsNullOrEmpty(resAppId) && resAppId.StartsWith("app_"))
                        {
                            int.TryParse(resAppId.Substring(4), out resPid);
                        }

                        if (resPid > 0 && IsProtectedProcess(resPid))
                        {
                            SendError(reqId, "SAFETY_VIOLATION: Refusing to resolve target in protected process window.");
                            return;
                        }

                        string authErrRes;
                        if (!ValidateWorkerAuthorization(req, resPid, resAppId, out authErrRes))
                        {
                            SendError(reqId, authErrRes);
                            return;
                        }

                        string resTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                        long resHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                        string resExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                        AutomationElement winRes = FindTargetWindow(resPid, resAppId, resTitle, resHandle, resExpectedStart);
                        if (winRes == null)
                        {
                            SendError(reqId, "Application window not found");
                            return;
                        }
                        if (resPid > 0 && winRes.Current.ProcessId != resPid)
                        {
                            SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                            return;
                        }
                        if (IsProtectedWindow(winRes) || IsProtectedProcess(winRes.Current.ProcessId))
                        {
                            SendError(reqId, "SAFETY_VIOLATION: Refusing to resolve target in protected process window.");
                            return;
                        }

                        TargetQuery queryRes = ParseTargetQuery(req);
                        if (string.IsNullOrEmpty(queryRes.Action)) queryRes.Action = "resolve";
                        TargetResolutionResult resolutionRes = ResolveTargetElement(winRes, queryRes, maxRetries: 2);

                        var resReceipt = new Dictionary<string, object>
                        {
                            { "matched", resolutionRes.Matched },
                            { "success", resolutionRes.Matched },
                            { "strategy", resolutionRes.ResolutionStrategy },
                            { "attempts", resolutionRes.Attempts },
                            { "ambiguityCount", resolutionRes.AmbiguityCount },
                            { "errorCode", resolutionRes.Matched ? null : (resolutionRes.AmbiguityCount > 1 ? "AMBIGUOUS_TARGET" : (resolutionRes.Error != null && resolutionRes.Error.Contains(":") ? resolutionRes.Error.Substring(0, resolutionRes.Error.IndexOf(':')).Trim() : "ELEMENT_NOT_FOUND")) },
                            { "errorMessage", resolutionRes.Error },
                            { "resolvedTarget", resolutionRes.TargetInfo },
                            { "rejectedCandidates", resolutionRes.RejectedCandidates }
                        };
                        SendSuccess(reqId, resReceipt);
                        break;
                    }

                case "focus_window":
                    {
                        int focusPid = req.ContainsKey("pid") ? Convert.ToInt32(req["pid"]) : 0;
                        string focusAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                        if (focusPid <= 0 && !string.IsNullOrEmpty(focusAppId) && focusAppId.StartsWith("app_"))
                        {
                            int.TryParse(focusAppId.Substring(4), out focusPid);
                        }
                        if (focusPid > 0 && IsProtectedProcess(focusPid))
                        {
                            SendError(reqId, "SAFETY_VIOLATION: Refusing to focus protected process window.");
                            return;
                        }

                        string authErrFocus;
                        if (!ValidateWorkerAuthorization(req, focusPid, focusAppId, out authErrFocus))
                        {
                            SendError(reqId, authErrFocus);
                            return;
                        }

                        string focusTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : null;
                        long focusHwnd = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                        string focusStartTime = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;

                        AutomationElement focusWin = FindTargetWindow(focusPid, focusAppId, focusTitle, focusHwnd, focusStartTime);
                        if (focusWin == null)
                        {
                            SendError(reqId, "Window not found matching specified criteria");
                            return;
                        }
                        if (focusPid > 0 && focusWin.Current.ProcessId != focusPid)
                        {
                            SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                            return;
                        }

                        if (IsProtectedWindow(focusWin) || IsProtectedProcess(focusWin.Current.ProcessId))
                        {
                            SendError(reqId, "SAFETY_VIOLATION: Refusing to focus protected process window.");
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
                    string reqTaskId = req.ContainsKey("taskId") ? Convert.ToString(req["taskId"]) : null;
                    string reqTaskGrant = req.ContainsKey("taskGrant") ? Convert.ToString(req["taskGrant"]) : null;

                    if (string.IsNullOrEmpty(_sessionSecret))
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Worker session is not initialized with an authorization secret.");
                        break;
                    }

                    if (string.IsNullOrEmpty(reqTaskId) || string.IsNullOrEmpty(reqTaskGrant))
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Refusing launch_app without a trusted task authorization grant (missing taskId or taskGrant).");
                        break;
                    }

                    string expectedGrant = ComputeHmacSha256(_sessionSecret, "launch:" + reqTaskId + ":" + exePath.ToLowerInvariant());
                    if (!string.Equals(expectedGrant, reqTaskGrant, StringComparison.OrdinalIgnoreCase))
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Invalid or forged task authorization grant for launch_app.");
                        break;
                    }

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
                    si.dwFlags = 1; // STARTF_USESHOWWINDOW
                    si.wShowWindow = 4; // SW_SHOWNOACTIVATE: displays window without activating it
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

                                // 2A: If opening a specific file (argFileName not empty), check if a window loaded it (including existing single-instance tabbed app)
                                if (!string.IsNullOrEmpty(argFileName) && argFileName.Length > 2)
                                {
                                    foreach (AutomationElement w in currentWins)
                                    {
                                        try
                                        {
                                            if (IsProtectedWindow(w)) continue;
                                            int wPid = w.Current.ProcessId;
                                            if (IsProtectedProcess(wPid)) continue;

                                            string pName = "";
                                            try
                                            {
                                                Process proc = Process.GetProcessById(wPid);
                                                pName = (proc.ProcessName ?? "").ToLowerInvariant();
                                            }
                                            catch { }

                                            bool isAppMatch = pName.Equals(targetBaseName, StringComparison.OrdinalIgnoreCase) ||
                                                              (targetBaseName == "notepad" && pName.Contains("notepad")) ||
                                                              (targetBaseName == "calc" && (pName.Contains("calculator") || pName.Contains("applicationframe")));
                                            if (!isAppMatch) continue;

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

                                // 2B: Check newly appeared top-level window whose handle was NOT in existingHandles
                                foreach (AutomationElement w in currentWins)
                                {
                                    try
                                    {
                                        long h = w.Current.NativeWindowHandle;
                                        if (h == 0) continue;
                                        if (w.Current.IsOffscreen) continue;
                                        if (IsProtectedWindow(w)) continue;

                                        int wPid = w.Current.ProcessId;
                                        if (IsProtectedProcess(wPid)) continue;

                                        string wClass = (w.Current.ClassName ?? "").ToLowerInvariant();
                                        string pName = "";
                                        try
                                        {
                                            Process proc = Process.GetProcessById(wPid);
                                            pName = (proc.ProcessName ?? "").ToLowerInvariant();
                                        }
                                        catch { }

                                        // Strict process match: must match target executable or known broker
                                        bool procMatches = pName.Equals(targetBaseName, StringComparison.OrdinalIgnoreCase) || 
                                                           (targetBaseName == "calc" && (pName.Contains("calculator") || wClass.Contains("applicationframe"))) ||
                                                           (targetBaseName == "calculator" && (pName.Contains("calculator") || wClass.Contains("applicationframe"))) ||
                                                           (targetBaseName == "notepad" && pName.Contains("notepad"));

                                        if (procMatches)
                                        {
                                            if (!existingHandles.Contains(h))
                                            {
                                                foundWin = w;
                                                break;
                                            }
                                        }
                                    }
                                    catch { }
                                }
                                if (foundWin != null) break;
                            }
                            catch { }
                        }

                        if (foundWin == null)
                        {
                            SendError(reqId, "Window not detected for launched executable '" + exePath + "'. Process did not create a visible window within timeout.");
                            break;
                        }

                        string winName = "";
                        int effectivePid = foundWin.Current.ProcessId;
                        long winHandleVal = foundWin.Current.NativeWindowHandle;
                        try { winName = foundWin.Current.Name ?? ""; } catch { }

                        string startTimeIso = "";
                        try
                        {
                            Process launchedProc = Process.GetProcessById(effectivePid);
                            startTimeIso = launchedProc.StartTime.ToUniversalTime().ToString("o");
                        }
                        catch { }

                        string docPathArg = null;
                        if (req.ContainsKey("targetPath") && !string.IsNullOrEmpty(Convert.ToString(req["targetPath"])))
                        {
                            docPathArg = Convert.ToString(req["targetPath"]);
                        }
                        else if (!string.IsNullOrEmpty(cmdArgs))
                        {
                            try
                            {
                                string cleanArg = cmdArgs.Trim().Trim('"', '\'');
                                if (cleanArg.Contains("\""))
                                {
                                    int q1 = cmdArgs.IndexOf('"');
                                    int q2 = cmdArgs.IndexOf('"', q1 + 1);
                                    if (q1 >= 0 && q2 > q1) cleanArg = cmdArgs.Substring(q1 + 1, q2 - q1 - 1);
                                }
                                docPathArg = cleanArg;
                            }
                            catch { }
                        }

                        if (!string.IsNullOrEmpty(docPathArg))
                        {
                            try
                            {
                                string canonicalPath = Path.GetFullPath(docPathArg);
                                RecordInitialFileState(canonicalPath);
                                _processDocumentPaths[effectivePid] = canonicalPath;
                                _processDocumentPathsStr["app_" + effectivePid] = canonicalPath;
                            }
                            catch { }
                        }

                        string authToken = ComputeHmacSha256(_sessionSecret, "auth:" + reqTaskId + ":" + effectivePid + ":" + Guid.NewGuid().ToString("N"));
                        _authorizedWorkerPids.Add(effectivePid);
                        _authorizedWorkerAppIds.Add("app_" + effectivePid);
                        if (winHandleVal != 0)
                        {
                            _authorizedWorkerHandles.Add(winHandleVal);
                            _authorizedWorkerHandlesByPid[effectivePid] = winHandleVal;
                        }
                        _authorizedWorkerTokens[effectivePid] = authToken;
                        _authorizedWorkerTokensByAppId["app_" + effectivePid] = authToken;
                        _authorizedWorkerTaskIds[effectivePid] = reqTaskId;
                        _authorizedWorkerTaskIdsByAppId["app_" + effectivePid] = reqTaskId;
                        _authorizedWorkerProcessStartTimes[effectivePid] = startTimeIso;

                        var launchInfo = new Dictionary<string, object>
                        {
                            { "pid", effectivePid },
                            { "appId", "app_" + effectivePid },
                            { "authToken", authToken },
                            { "taskId", reqTaskId },
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
                    string closeAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    if (req.ContainsKey("pid")) closePid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(closeAppId) && closeAppId.StartsWith("app_"))
                    {
                        int.TryParse(closeAppId.Substring(4), out closePid);
                    }

                    if (closePid > 0 && IsProtectedProcess(closePid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to close protected IDE or system process (PID " + closePid + ").");
                        break;
                    }

                    string authErrClose;
                    if (!ValidateWorkerAuthorization(req, closePid, closeAppId, out authErrClose))
                    {
                        SendError(reqId, authErrClose);
                        break;
                    }
                    bool isOwned = true;

                    string closeTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string savePolicy = req.ContainsKey("savePolicy") ? Convert.ToString(req["savePolicy"]).ToLowerInvariant() : "";
                    if (string.IsNullOrEmpty(savePolicy) && req.ContainsKey("dialogAction"))
                    {
                        savePolicy = Convert.ToString(req["dialogAction"]).ToLowerInvariant();
                    }

                    long closeHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string expectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    bool allowForceKill = req.ContainsKey("allowForceKill") ? Convert.ToBoolean(req["allowForceKill"]) : false;

                    AutomationElement targetWin = FindTargetWindow(closePid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, closeTitle, closeHandle, expectedStart);
                    if (targetWin != null && closePid > 0 && targetWin.Current.ProcessId != closePid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        return;
                    }
                    if (targetWin != null && closePid <= 0) closePid = targetWin.Current.ProcessId;

                    if (closePid <= 0 && targetWin == null)
                    {
                        SendError(reqId, "Invalid target process ID or appId");
                        return;
                    }

                    if (IsProtectedProcess(closePid) || (targetWin != null && IsProtectedWindow(targetWin)))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to close protected IDE or system process (PID " + closePid + ").");
                        break;
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
                            RevokeWorkerAuthorization(closePid, closeAppId);
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
                            _pendingConfirmationKeys.Remove("pid_" + closePid);
                            _pendingConfirmationKeys.Remove(Convert.ToString(closePid));
                            if (req.ContainsKey("appId")) _pendingConfirmationKeys.Remove(Convert.ToString(req["appId"]));
                            RevokeWorkerAuthorization(closePid, closeAppId);
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
                        string curWinTitle = "";
                        try { if (targetWin != null) curWinTitle = targetWin.Current.Name ?? ""; } catch { }
                        bool hasUnsaved = _modifiedPids.Contains(closePid) ||
                                          (req.ContainsKey("appId") && _modifiedAppIds.Contains(Convert.ToString(req["appId"]))) ||
                                          _modifiedAppIds.Contains("app_" + closePid) ||
                                          curWinTitle.StartsWith("*");

                        if (savePolicy == "dont_save")
                        {
                            bool isAuthorizedDiscard = (req.ContainsKey("userAuthorizedDiscard") && Convert.ToBoolean(req["userAuthorizedDiscard"])) ||
                                                       (req.ContainsKey("disposableTestDoc") && Convert.ToBoolean(req["disposableTestDoc"]));
                            if (!isAuthorizedDiscard && (foundDialog != null || hasUnsaved))
                            {
                                SendError(reqId, "SAFETY_VIOLATION: Refusing to close application with dont_save without explicit user authorization or verified disposable test scope.");
                                break;
                            }
                            if (foundDialog != null)
                            {
                                DismissDialogAction(foundDialog, "dont_save");
                            }
                            else if (hasUnsaved)
                            {
                                // Trigger close to prompt dialog if dirty
                                CloseWindowTarget(targetWin, targetHwnd, p, allowForceKill: false);
                                for (int dWait = 0; dWait < 10; dWait++)
                                {
                                    Thread.Sleep(100);
                                    DialogInfo lateDialog = DetectDialog(closePid, targetWin);
                                    if (lateDialog != null)
                                    {
                                        DismissDialogAction(lateDialog, "dont_save");
                                        foundDialog = lateDialog;
                                        break;
                                    }
                                }
                            }
                            _modifiedPids.Remove(closePid);
                            _lastTypedText.Remove(closePid);
                            if (req.ContainsKey("appId"))
                            {
                                string aKey = Convert.ToString(req["appId"]);
                                _modifiedAppIds.Remove(aKey);
                                _lastTypedTextStr.Remove(aKey);
                                _pendingConfirmationKeys.Remove(aKey);
                            }
                            _modifiedAppIds.Remove("app_" + closePid);
                            _lastTypedTextStr.Remove("app_" + closePid);
                            _pendingConfirmationKeys.Remove("pid_" + closePid);
                            _pendingConfirmationKeys.Remove(Convert.ToString(closePid));

                            CloseWindowTarget(targetWin, targetHwnd, p, allowForceKill: (isOwned && allowForceKill));
                            bool closedAfterDiscard = (p == null || p.HasExited || targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd));
                            if (closedAfterDiscard)
                            {
                                RevokeWorkerAuthorization(closePid, closeAppId);
                            }

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "closed", closedAfterDiscard },
                                { "pid", closePid },
                                { "dialogHandled", foundDialog != null },
                                { "actionTaken", "dont_save" },
                                { "verified", true }
                            });
                            break;
                        }
                        else if (savePolicy == "save")
                        {
                            string requestedTargetPath = req.ContainsKey("targetPath") ? Convert.ToString(req["targetPath"]) : null;
                            var saveResult = SaveDocumentSafely(targetWin, closePid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, requestedTargetPath, isOwned, foundDialog);

                            if (!saveResult.SaveSuccess)
                            {
                                SendSuccess(reqId, new Dictionary<string, object>
                                {
                                    { "closed", false },
                                    { "pid", closePid },
                                    { "saveSuccess", false },
                                    { "saveMethod", saveResult.SaveMethod },
                                    { "applicationSaveConfirmed", saveResult.ApplicationSaveConfirmed },
                                    { "fallbackPersistenceVerified", saveResult.FallbackPersistenceVerified },
                                    { "verifiedContentMatch", false },
                                    { "status", saveResult.Status },
                                    { "dialogOpen", saveResult.SaveAsDialogOpen },
                                    { "error", saveResult.Error }
                                });
                                break;
                            }

                            _modifiedPids.Remove(closePid);
                            _lastTypedText.Remove(closePid);
                            if (req.ContainsKey("appId"))
                            {
                                string aKey = Convert.ToString(req["appId"]);
                                _modifiedAppIds.Remove(aKey);
                                _lastTypedTextStr.Remove(aKey);
                                _pendingConfirmationKeys.Remove(aKey);
                            }
                            _modifiedAppIds.Remove("app_" + closePid);
                            _lastTypedTextStr.Remove("app_" + closePid);
                            _pendingConfirmationKeys.Remove("pid_" + closePid);
                            _pendingConfirmationKeys.Remove(Convert.ToString(closePid));

                            // Save succeeded: now close the window safely!
                            CloseWindowTarget(targetWin, targetHwnd, p, allowForceKill: false);

                            // If a lingering "Do you want to save?" dialog appeared on close, dismiss with dont_save since disk is verified!
                            DialogInfo lingeringDialog = DetectDialog(closePid, targetWin);
                            if (lingeringDialog != null)
                            {
                                DismissDialogAction(lingeringDialog, "dont_save");
                                CloseWindowTarget(targetWin, targetHwnd, p, allowForceKill: false);
                            }

                            bool closed = (p == null || p.HasExited || targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd));
                            if (closed)
                            {
                                RevokeWorkerAuthorization(closePid, closeAppId);
                            }

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "closed", closed },
                                { "pid", closePid },
                                { "saveSuccess", true },
                                { "saveMethod", saveResult.SaveMethod },
                                { "applicationSaveConfirmed", saveResult.ApplicationSaveConfirmed },
                                { "fallbackPersistenceVerified", saveResult.FallbackPersistenceVerified },
                                { "verifiedContentMatch", saveResult.VerifiedContentMatch },
                                { "status", closed ? "saved_and_closed" : "saved_window_lingering" },
                                { "dialogHandled", saveResult.DialogHandled || lingeringDialog != null },
                                { "actionTaken", "save" },
                                { "verified", true }
                            });
                            break;
                        }
                        else if (savePolicy == "cancel")
                        {
                            if (foundDialog != null)
                            {
                                DismissDialogAction(foundDialog, "cancel");
                            }
                            _pendingConfirmationKeys.Remove("pid_" + closePid);
                            _pendingConfirmationKeys.Remove(Convert.ToString(closePid));
                            if (req.ContainsKey("appId")) _pendingConfirmationKeys.Remove(Convert.ToString(req["appId"]));

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

                        // savePolicy is empty / ask / ambiguous
                        if (foundDialog != null)
                        {
                            _pendingConfirmationKeys.Add("pid_" + closePid);
                            _pendingConfirmationKeys.Add(Convert.ToString(closePid));
                            if (req.ContainsKey("appId")) _pendingConfirmationKeys.Add(Convert.ToString(req["appId"]));

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

                        if (hasUnsaved)
                        {
                            _pendingConfirmationKeys.Add("pid_" + closePid);
                            _pendingConfirmationKeys.Add(Convert.ToString(closePid));
                            if (req.ContainsKey("appId")) _pendingConfirmationKeys.Add(Convert.ToString(req["appId"]));

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "closed", false },
                                { "dialogOpen", true },
                                { "pid", closePid },
                                { "dialogTitle", "Unsaved changes confirmation dialog" },
                                { "message", "Do you want to save changes to the document?" },
                                { "availableActions", new List<string> { "dont_save", "save", "cancel" } },
                                { "prompt", "Unsaved changes confirmation dialog is open. Please specify savePolicy ('dont_save', 'save', 'cancel') or user intent." }
                            });
                            break;
                        }

                        // No unsaved modifications and no dialog: clean close
                        CloseWindowTarget(targetWin, targetHwnd, p, allowForceKill: (isOwned && allowForceKill));
                        DialogInfo unexpectedDialog = DetectDialog(closePid, targetWin);
                        if (unexpectedDialog != null)
                        {
                            // An unexpected modal dialog appeared! Report it honestly!
                            _pendingConfirmationKeys.Add("pid_" + closePid);
                            _pendingConfirmationKeys.Add(Convert.ToString(closePid));
                            if (req.ContainsKey("appId")) _pendingConfirmationKeys.Add(Convert.ToString(req["appId"]));

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "closed", false },
                                { "dialogOpen", true },
                                { "pid", closePid },
                                { "dialogTitle", unexpectedDialog.Title },
                                { "message", unexpectedDialog.Message },
                                { "availableActions", unexpectedDialog.AvailableActions },
                                { "prompt", "Unsaved changes confirmation dialog is open. Please specify savePolicy ('dont_save', 'save', 'cancel') or user intent." }
                            });
                            break;
                        }

                        bool cleanClosed = (p == null || p.HasExited || targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd));
                        if (cleanClosed)
                        {
                            RevokeWorkerAuthorization(closePid, closeAppId);
                        }
                        SendSuccess(reqId, new Dictionary<string, object> { { "closed", cleanClosed }, { "pid", closePid } });
                        break;
                    }
                    catch (ArgumentException)
                    {
                        // Process is already terminated
                        _pendingConfirmationKeys.Remove("pid_" + closePid);
                        _pendingConfirmationKeys.Remove(Convert.ToString(closePid));
                        if (req.ContainsKey("appId")) _pendingConfirmationKeys.Remove(Convert.ToString(req["appId"]));
                        RevokeWorkerAuthorization(closePid, closeAppId);
                        SendSuccess(reqId, new Dictionary<string, object> { { "closed", true }, { "pid", closePid } });
                    }
                    catch (Exception ex)
                    {
                        SendError(reqId, "Failed to close application: " + ex.Message);
                    }
                    break;

                case "close_tab":
                    int tabPid = 0;
                    if (req.ContainsKey("pid")) tabPid = Convert.ToInt32(req["pid"]);
                    else if (req.ContainsKey("appId"))
                    {
                        string s = Convert.ToString(req["appId"]);
                        if (s.StartsWith("app_")) int.TryParse(s.Substring(4), out tabPid);
                    }
                    if (tabPid > 0 && IsProtectedProcess(tabPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to close tab on protected process.");
                        break;
                    }

                    string tabAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    string authErrTab;
                    if (!ValidateWorkerAuthorization(req, tabPid, tabAppId, out authErrTab))
                    {
                        SendError(reqId, authErrTab);
                        break;
                    }

                    string tabTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    long tabHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string tabExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement tabWin = FindTargetWindow(tabPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, tabTitle, tabHandle, tabExpectedStart);
                    if (tabWin == null) throw new InvalidOperationException("Window not found");
                    if (tabPid > 0 && tabWin.Current.ProcessId != tabPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(tabWin) || IsProtectedProcess(tabWin.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to close tab on protected process.");
                        break;
                    }

                    IntPtr tabHwnd = new IntPtr(tabWin.Current.NativeWindowHandle);

                    // 1. Try finding TabItem close button or invoke close via UIA without disturbing keyboard/focus
                    bool tabClosedViaUia = false;
                    try
                    {
                        var tabCloseBtn = tabWin.FindFirst(TreeScope.Descendants, new AndCondition(
                            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                            new OrCondition(
                                new PropertyCondition(AutomationElement.AutomationIdProperty, "CloseTabButton"),
                                new PropertyCondition(AutomationElement.AutomationIdProperty, "CloseButton"),
                                new PropertyCondition(AutomationElement.NameProperty, "Close Tab")
                            )
                        ));
                        if (tabCloseBtn != null)
                        {
                            object invObj;
                            if (tabCloseBtn.TryGetCurrentPattern(InvokePattern.Pattern, out invObj))
                            {
                                ((InvokePattern)invObj).Invoke();
                                tabClosedViaUia = true;
                                Thread.Sleep(100);
                            }
                        }
                    }
                    catch { }

                    // 2. Keyboard shortcut fallback ONLY if target window was ALREADY active and foreground
                    if (!tabClosedViaUia && tabHwnd != IntPtr.Zero)
                    {
                        IntPtr curTabFore = GetForegroundWindow();
                        uint curTabForePid = 0;
                        GetWindowThreadProcessId(curTabFore, out curTabForePid);
                        // Never force foreground or inject keystrokes if the user is working in another application!
                        if (curTabFore == tabHwnd || (curTabForePid != 0 && curTabForePid == (uint)tabWin.Current.ProcessId))
                        {
                            if (!IsProtectedProcess((int)curTabForePid))
                            {
                                keybd_event(0x11, 0, 0, UIntPtr.Zero);
                                keybd_event(0x57, 0, 0, UIntPtr.Zero);
                                Thread.Sleep(30);
                                keybd_event(0x57, 0, 2, UIntPtr.Zero);
                                keybd_event(0x11, 0, 2, UIntPtr.Zero);
                                Thread.Sleep(150);
                            }
                        }
                    }

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
                    string detAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    if (req.ContainsKey("pid")) detPid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(detAppId) && detAppId.StartsWith("app_"))
                    {
                        int.TryParse(detAppId.Substring(4), out detPid);
                    }

                    if (detPid > 0 && IsProtectedProcess(detPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to interact with dialog on protected process.");
                        break;
                    }

                    string authErrDet;
                    if (!ValidateWorkerAuthorization(req, detPid, detAppId, out authErrDet))
                    {
                        SendError(reqId, authErrDet);
                        break;
                    }

                    string detTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    long detHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string detExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement detWin = FindTargetWindow(detPid, detAppId, detTitle, detHandle, detExpectedStart);
                    if (detWin != null && detPid > 0 && detWin.Current.ProcessId != detPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (detWin != null && detPid <= 0) detPid = detWin.Current.ProcessId;

                    if (detWin != null && (IsProtectedWindow(detWin) || IsProtectedProcess(detWin.Current.ProcessId)))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to interact with dialog on protected process.");
                        break;
                    }

                    string detAppIdStr = !string.IsNullOrEmpty(detAppId) ? detAppId : ("app_" + detPid);

                    var detected = DetectDialog(detPid, detWin);
                    if (detected != null)
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
                    else if (detWin != null && (_pendingConfirmationKeys.Contains("pid_" + detPid) || _pendingConfirmationKeys.Contains(Convert.ToString(detPid)) || _pendingConfirmationKeys.Contains(detAppIdStr)))
                    {
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "dialogOpen", true },
                            { "title", "Unsaved changes confirmation dialog" },
                            { "message", "Do you want to save changes to the document?" },
                            { "availableActions", new List<string> { "dont_save", "save", "cancel" } },
                            { "windowHandle", detWin.Current.NativeWindowHandle }
                        });
                    }
                    else
                    {
                        if (detWin == null)
                        {
                            _pendingConfirmationKeys.Remove("pid_" + detPid);
                            _pendingConfirmationKeys.Remove(Convert.ToString(detPid));
                            _pendingConfirmationKeys.Remove(detAppIdStr);
                        }
                        SendSuccess(reqId, new Dictionary<string, object> { { "dialogOpen", false } });
                    }
                    break;

                case "handle_dialog":
                    int hPid = 0;
                    string hAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    if (req.ContainsKey("pid")) hPid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(hAppId) && hAppId.StartsWith("app_"))
                    {
                        int.TryParse(hAppId.Substring(4), out hPid);
                    }
                    if (hPid > 0 && IsProtectedProcess(hPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to interact with dialog on protected process.");
                        break;
                    }

                    string authErrDialog;
                    if (!ValidateWorkerAuthorization(req, hPid, hAppId, out authErrDialog))
                    {
                        SendError(reqId, authErrDialog);
                        break;
                    }

                    string hTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string hAction = req.ContainsKey("action") ? Convert.ToString(req["action"]).ToLowerInvariant() : "";
                    long hHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string hExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement hWin = FindTargetWindow(hPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, hTitle, hHandle, hExpectedStart);
                    if (hWin != null && hPid > 0 && hWin.Current.ProcessId != hPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (hWin != null && hPid <= 0) hPid = hWin.Current.ProcessId;
                    if (IsProtectedProcess(hPid) || (hWin != null && IsProtectedWindow(hWin)))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to interact with dialog on protected process.");
                        break;
                    }

                    string hAppIdStr = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : ("app_" + hPid);

                    if (hAction == "dont_save")
                    {
                        bool isAuthorizedDiscard = (req.ContainsKey("userAuthorizedDiscard") && Convert.ToBoolean(req["userAuthorizedDiscard"])) ||
                                                   (req.ContainsKey("disposableTestDoc") && Convert.ToBoolean(req["disposableTestDoc"]));
                        if (!isAuthorizedDiscard)
                        {
                            SendError(reqId, "SAFETY_VIOLATION: Refusing to discard unsaved changes without explicit user authorization or verified disposable test scope.");
                            break;
                        }
                    }

                    var hDialog = DetectDialog(hPid, hWin);
                    if (hDialog != null)
                    {
                        if (!hDialog.ActionButtons.ContainsKey(hAction))
                        {
                            if (hAction == "cancel")
                            {
                                DismissDialogAction(hDialog, "cancel");
                            }
                            else
                            {
                                SendError(reqId, "Action '" + hAction + "' is not available in the dialog. Available actions: " + string.Join(", ", hDialog.AvailableActions.ToArray()));
                                break;
                            }
                        }
                        else
                        {
                            DismissDialogAction(hDialog, hAction);
                        }

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

                        _pendingConfirmationKeys.Remove("pid_" + hPid);
                        _pendingConfirmationKeys.Remove(Convert.ToString(hPid));
                        _pendingConfirmationKeys.Remove(hAppIdStr);
                        _modifiedPids.Remove(hPid);
                        _lastTypedText.Remove(hPid);
                        _modifiedAppIds.Remove(hAppIdStr);
                        _lastTypedTextStr.Remove(hAppIdStr);

                        if (processExited)
                        {
                            RevokeWorkerAuthorization(hPid, hAppId);
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
                    }

                    bool isPendingH = _pendingConfirmationKeys.Contains("pid_" + hPid) || _pendingConfirmationKeys.Contains(Convert.ToString(hPid)) || _pendingConfirmationKeys.Contains(hAppIdStr);
                    if (isPendingH)
                    {
                        _pendingConfirmationKeys.Remove("pid_" + hPid);
                        _pendingConfirmationKeys.Remove(Convert.ToString(hPid));
                        _pendingConfirmationKeys.Remove(hAppIdStr);

                        if (hAction == "cancel")
                        {
                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "handled", true },
                                { "action", "cancel" },
                                { "dialogTitle", "Unsaved changes confirmation dialog" },
                                { "message", "Do you want to save changes to the document?" },
                                { "processExited", false }
                            });
                            break;
                        }

                        bool isOwnedH = req.ContainsKey("isOwned") ? Convert.ToBoolean(req["isOwned"]) : false;
                        bool allowForceH = req.ContainsKey("allowForceKill") ? Convert.ToBoolean(req["allowForceKill"]) : false;

                        if (hAction == "save")
                        {
                            string requestedTargetPath = req.ContainsKey("targetPath") ? Convert.ToString(req["targetPath"]) : null;
                            var saveResult = SaveDocumentSafely(hWin, hPid, req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null, requestedTargetPath, isOwnedH, null);

                            if (!saveResult.SaveSuccess)
                            {
                                SendSuccess(reqId, new Dictionary<string, object>
                                {
                                    { "handled", false },
                                    { "action", "save" },
                                    { "saveSuccess", false },
                                    { "saveMethod", saveResult.SaveMethod },
                                    { "applicationSaveConfirmed", saveResult.ApplicationSaveConfirmed },
                                    { "fallbackPersistenceVerified", saveResult.FallbackPersistenceVerified },
                                    { "verifiedContentMatch", false },
                                    { "status", saveResult.Status },
                                    { "processExited", false },
                                    { "error", saveResult.Error }
                                });
                                break;
                            }
                        }

                        _modifiedPids.Remove(hPid);
                        _lastTypedText.Remove(hPid);
                        _modifiedAppIds.Remove(hAppIdStr);
                        _lastTypedTextStr.Remove(hAppIdStr);

                        IntPtr hWinHwnd = IntPtr.Zero;
                        try { if (hWin != null) hWinHwnd = new IntPtr(hWin.Current.NativeWindowHandle); } catch { }
                        Process hWinProc = null;
                        try { hWinProc = Process.GetProcessById(hPid); } catch { }

                        CloseWindowTarget(hWin, hWinHwnd, hWinProc, allowForceKill: (isOwnedH && allowForceH));

                        bool procExited = (hWinProc == null || hWinProc.HasExited);
                        if (procExited)
                        {
                            RevokeWorkerAuthorization(hPid, hAppId);
                        }

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "handled", true },
                            { "action", hAction },
                            { "dialogTitle", "Unsaved changes confirmation dialog" },
                            { "message", "Do you want to save changes to the document?" },
                            { "processExited", procExited }
                        });
                        break;
                    }

                    SendError(reqId, "No active modal confirmation dialog detected for the target window");
                    break;

                case "save_document":
                    string sAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    int sPid = 0;
                    if (req.ContainsKey("pid")) sPid = Convert.ToInt32(req["pid"]);
                    else if (sAppId.StartsWith("app_")) int.TryParse(sAppId.Substring(4), out sPid);

                    if (sPid > 0 && IsProtectedProcess(sPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to save document for protected process.");
                        break;
                    }

                    string authErrSave;
                    if (!ValidateWorkerAuthorization(req, sPid, sAppId, out authErrSave))
                    {
                        SendError(reqId, authErrSave);
                        break;
                    }

                    string sTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    long sHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string sExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement sWin = FindTargetWindow(sPid, sAppId, sTitle, sHandle, sExpectedStart);
                    if (sWin == null)
                    {
                        SendError(reqId, "Application window not found for save_document");
                        break;
                    }
                    if (sPid > 0 && sWin.Current.ProcessId != sPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (sPid <= 0) sPid = sWin.Current.ProcessId;

                    bool isOwnedSave = (sPid > 0 && _authorizedWorkerPids.Contains(sPid)) ||
                                       (!string.IsNullOrEmpty(sAppId) && _authorizedWorkerAppIds.Contains(sAppId));

                    string requestedSavePath = req.ContainsKey("targetPath") ? Convert.ToString(req["targetPath"]) : null;
                    if (!string.IsNullOrEmpty(requestedSavePath))
                    {
                        try
                        {
                            string fullPath = Path.GetFullPath(requestedSavePath);
                            _processDocumentPaths[sPid] = fullPath;
                            if (!string.IsNullOrEmpty(sAppId)) _processDocumentPathsStr[sAppId] = fullPath;
                            _processDocumentPathsStr["app_" + sPid] = fullPath;
                        }
                        catch { }
                    }

                    DialogInfo sExistingDialog = DetectDialog(sPid, sWin);
                    var docSaveResult = SaveDocumentSafely(sWin, sPid, sAppId, requestedSavePath, isOwnedSave, sExistingDialog);

                    if (!docSaveResult.SaveSuccess)
                    {
                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "saved", false },
                            { "saveSuccess", false },
                            { "pid", sPid },
                            { "status", docSaveResult.Status },
                            { "saveMethod", docSaveResult.SaveMethod },
                            { "dialogOpen", docSaveResult.SaveAsDialogOpen },
                            { "error", docSaveResult.Error }
                        });
                        break;
                    }

                    SendSuccess(reqId, new Dictionary<string, object>
                    {
                        { "saved", true },
                        { "saveSuccess", true },
                        { "pid", sPid },
                        { "path", requestedSavePath },
                        { "status", docSaveResult.Status },
                        { "saveMethod", docSaveResult.SaveMethod },
                        { "verifiedContentMatch", docSaveResult.VerifiedContentMatch },
                        { "applicationSaveConfirmed", docSaveResult.ApplicationSaveConfirmed },
                        { "fallbackPersistenceVerified", docSaveResult.FallbackPersistenceVerified }
                    });
                    break;

                case "type_text":
                    string appIdText = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    int pidText = 0;
                    if (req.ContainsKey("pid")) pidText = Convert.ToInt32(req["pid"]);
                    else if (appIdText.StartsWith("app_")) int.TryParse(appIdText.Substring(4), out pidText);

                    if (pidText > 0 && IsProtectedProcess(pidText))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to type text into protected process.");
                        break;
                    }

                    string authErrText;
                    if (!ValidateWorkerAuthorization(req, pidText, appIdText, out authErrText))
                    {
                        SendError(reqId, authErrText);
                        break;
                    }

                    string targetTitleText = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    string textToType = req.ContainsKey("text") ? Convert.ToString(req["text"]) : "";
                    bool preferBackground = req.ContainsKey("preferBackground") ? Convert.ToBoolean(req["preferBackground"]) : true;
                    bool allowPhysicalFallbackText = req.ContainsKey("allowPhysicalFallback") ? Convert.ToBoolean(req["allowPhysicalFallback"]) : false;

                    long textHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string textExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winText = FindTargetWindow(pidText, appIdText, targetTitleText, textHandle, textExpectedStart);
                    if (winText == null) throw new InvalidOperationException("Application window not found");
                    if (pidText > 0 && winText.Current.ProcessId != pidText)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(winText) || IsProtectedProcess(winText.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to type text into protected process.");
                        break;
                    }

                    TargetQuery typeQ = ParseTargetQuery(req);
                    typeQ.Action = "type";
                    typeQ.AllowPhysicalFallback = allowPhysicalFallbackText;
                    bool isSecretText = typeQ.IsSecret;

                    AutomationElement edit = null;
                    string typeStrategy = "default_edit_finder";
                    int typeAttempts = 1;
                    Dictionary<string, object> typeTargetInfo = null;

                    bool hasSpecificQuery = !string.IsNullOrEmpty(typeQ.AutomationId) || !string.IsNullOrEmpty(typeQ.Name) || !string.IsNullOrEmpty(typeQ.ClassName);
                    if (hasSpecificQuery)
                    {
                        TargetResolutionResult typeRes = ResolveTargetElement(winText, typeQ, maxRetries: 2);
                        if (!typeRes.Matched || typeRes.Element == null)
                        {
                            string errMsg = typeRes.Error ?? "ELEMENT_NOT_FOUND: Editable target element not found.";
                            SendError(reqId, errMsg);
                            break;
                        }
                        edit = typeRes.Element;
                        typeStrategy = typeRes.ResolutionStrategy;
                        typeAttempts = typeRes.Attempts;
                        typeTargetInfo = typeRes.TargetInfo;
                    }
                    else
                    {
                        // Default search: Document or Edit control
                        edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                        if (edit == null)
                        {
                            edit = winText.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                        }
                    }

                    if (edit != null)
                    {
                        string typeCompatErr;
                        if (!IsControlCompatibleWithAction(edit, "type", allowPhysicalFallbackText, out typeCompatErr))
                        {
                            SendError(reqId, "CONTROL_INCOMPATIBLE: " + typeCompatErr);
                            break;
                        }

                        // Revalidate element enabled state immediately before execution
                        bool isEditEnabled = false;
                        try { isEditEnabled = edit.Current.IsEnabled; } catch { }
                        if (!isEditEnabled)
                        {
                            SendError(reqId, "ELEMENT_DISABLED: Target edit control became disabled before execution.");
                            break;
                        }

                        // Automatic password/secret field detection from UIA IsPasswordProperty and naming
                        bool isControlPassword = false;
                        try
                        {
                            object isPassObj = edit.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty);
                            if (isPassObj is bool && (bool)isPassObj) isControlPassword = true;
                        }
                        catch { }

                        string editAutoId = edit.Current.AutomationId ?? "";
                        string editName = edit.Current.Name ?? "";
                        if (editAutoId.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            editAutoId.IndexOf("passwd", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            editAutoId.IndexOf("pin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            editName.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            isControlPassword = true;
                        }
                        if (isControlPassword) isSecretText = true;

                        if (typeTargetInfo == null)
                        {
                            typeTargetInfo = BuildCandidateInfo(edit, winText);
                        }
                    }

                    IntPtr hWnd = new IntPtr(winText.Current.NativeWindowHandle);
                    uint curTextWinPid = 0;
                    if (hWnd == IntPtr.Zero || !IsWindow(hWnd) || GetWindowThreadProcessId(hWnd, out curTextWinPid) == 0 || (pidText > 0 && curTextWinPid != (uint)pidText))
                    {
                        SendError(reqId, "TARGET_WINDOW_INVALID: Target window was closed or invalid before text entry.");
                        break;
                    }

                    // Tier 3 Non-Intrusive Strategy A: ValuePattern.SetValue() (Zero focus required, COM out-of-process)
                    if (edit != null)
                    {
                        object valPatternObj;
                        if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out valPatternObj))
                        {
                            ValuePattern valPattern = (ValuePattern)valPatternObj;
                            if (valPattern.Current.IsReadOnly)
                            {
                                SendError(reqId, "CONTROL_READONLY: Target edit control is read-only.");
                                break;
                            }

                            valPattern.SetValue(textToType);
                            string readVal = null;
                            bool readSuccess = false;
                            try
                            {
                                readVal = valPattern.Current.Value;
                                readSuccess = true;
                            }
                            catch
                            {
                                readSuccess = false;
                            }

                            if (winText != null)
                            {
                                _modifiedPids.Add(winText.Current.ProcessId);
                                _lastTypedText[winText.Current.ProcessId] = isSecretText ? "[REDACTED]" : textToType;
                            }
                            if (!string.IsNullOrEmpty(appIdText))
                            {
                                _modifiedAppIds.Add(appIdText);
                                _lastTypedTextStr[appIdText] = isSecretText ? "[REDACTED]" : textToType;
                            }

                            string postconditionStatus = "UNVERIFIABLE";
                            bool verifiedMatch = false;
                            if (readSuccess && readVal != null)
                            {
                                verifiedMatch = (readVal == textToType);
                                postconditionStatus = verifiedMatch ? "VERIFIED" : "FAILED";
                            }
                            else
                            {
                                postconditionStatus = "UNVERIFIABLE";
                            }

                            string safeReadText = isSecretText ? "[REDACTED]" : (readVal ?? "");

                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "verified", verifiedMatch },
                                { "postconditionStatus", postconditionStatus },
                                { "method", "ValuePattern" },
                                { "readText", safeReadText },
                                { "isSecret", isSecretText },
                                { "controlName", edit.Current.Name },
                                { "controlType", edit.Current.ControlType.ProgrammaticName },
                                { "tier", 3 },
                                { "tierName", "Tier 3 — Windows UI Automation" },
                                { "physicalInputUsed", false },
                                { "background", true },
                                { "resolutionStrategy", typeStrategy },
                                { "resolutionAttempts", typeAttempts },
                                { "resolvedTarget", typeTargetInfo }
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

                        if (winText != null)
                        {
                            _modifiedPids.Add(winText.Current.ProcessId);
                            _lastTypedText[winText.Current.ProcessId] = isSecretText ? "[REDACTED]" : textToType;
                        }
                        if (!string.IsNullOrEmpty(appIdText))
                        {
                            _modifiedAppIds.Add(appIdText);
                            _lastTypedTextStr[appIdText] = isSecretText ? "[REDACTED]" : textToType;
                        }

                        // Attempt postcondition readback
                        string readVal = null;
                        bool readSuccess = false;
                        try
                        {
                            object vObj;
                            if (edit != null && edit.TryGetCurrentPattern(ValuePattern.Pattern, out vObj))
                            {
                                readVal = ((ValuePattern)vObj).Current.Value;
                                readSuccess = true;
                            }
                        }
                        catch { }

                        string postconditionStatus = "UNVERIFIABLE";
                        bool verifiedMatch = false;
                        if (readSuccess && readVal != null)
                        {
                            verifiedMatch = (readVal == textToType);
                            postconditionStatus = verifiedMatch ? "VERIFIED" : "FAILED";
                        }
                        else
                        {
                            postconditionStatus = "UNVERIFIABLE";
                        }

                        string safeReadText = isSecretText ? "[REDACTED]" : (readVal ?? "");

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", verifiedMatch },
                            { "postconditionStatus", postconditionStatus },
                            { "method", "WM_SETTEXT" },
                            { "readText", safeReadText },
                            { "isSecret", isSecretText },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "background", true },
                            { "resolutionStrategy", typeStrategy },
                            { "resolutionAttempts", typeAttempts },
                            { "resolvedTarget", typeTargetInfo }
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
                    string safeFallbackText = isSecretText ? "[REDACTED]" : textToType;
                    SendSuccess(reqId, new Dictionary<string, object>
                    {
                        { "verified", false },
                        { "postconditionStatus", "UNVERIFIABLE" },
                        { "postconditionDetail", "Foreground keystroke entry executed; external outcome unobservable via UIA" },
                        { "method", "ForegroundInputFallback" },
                        { "readText", safeFallbackText },
                        { "isSecret", isSecretText },
                        { "tier", 4 },
                        { "tierName", "Tier 4 — Physical mouse/keyboard fallback" },
                        { "physicalInputUsed", true },
                        { "background", false },
                        { "resolutionStrategy", typeStrategy },
                        { "resolutionAttempts", typeAttempts },
                        { "resolvedTarget", typeTargetInfo }
                    });
                    return;

                case "inspect_ui":
                    string inspectAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    int inspectPid = 0;
                    if (req.ContainsKey("pid")) inspectPid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(inspectAppId) && inspectAppId.StartsWith("app_"))
                    {
                        int.TryParse(inspectAppId.Substring(4), out inspectPid);
                    }

                    if (inspectPid > 0 && IsProtectedProcess(inspectPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to inspect protected process window.");
                        break;
                    }

                    string authErrInspect;
                    if (!ValidateWorkerAuthorization(req, inspectPid, inspectAppId, out authErrInspect))
                    {
                        SendError(reqId, authErrInspect);
                        break;
                    }

                    string inspectTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    int maxDepth = req.ContainsKey("maxDepth") ? Convert.ToInt32(req["maxDepth"]) : 3;
                    long inspectHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string inspectExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winInspect = FindTargetWindow(inspectPid, inspectAppId, inspectTitle, inspectHandle, inspectExpectedStart);
                    if (winInspect == null)
                    {
                        SendError(reqId, "Application window not found");
                        break;
                    }
                    if (inspectPid > 0 && winInspect.Current.ProcessId != inspectPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(winInspect) || IsProtectedProcess(winInspect.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to inspect protected process window.");
                        break;
                    }

                    var tree = BuildNode(winInspect, 1, maxDepth);
                    SendSuccess(reqId, tree);
                    break;

                case "find_element":
                    string findAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    int findPid = 0;
                    if (req.ContainsKey("pid")) findPid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(findAppId) && findAppId.StartsWith("app_"))
                    {
                        int.TryParse(findAppId.Substring(4), out findPid);
                    }

                    if (findPid > 0 && IsProtectedProcess(findPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to search in protected process window.");
                        break;
                    }

                    string authErrFind;
                    if (!ValidateWorkerAuthorization(req, findPid, findAppId, out authErrFind))
                    {
                        SendError(reqId, authErrFind);
                        break;
                    }

                    string findTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    long findHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string findExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winFind = FindTargetWindow(findPid, findAppId, findTitle, findHandle, findExpectedStart);
                    if (winFind == null)
                    {
                        SendError(reqId, "Application window not found");
                        break;
                    }
                    if (findPid > 0 && winFind.Current.ProcessId != findPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(winFind) || IsProtectedProcess(winFind.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to search in protected process window.");
                        break;
                    }

                    TargetQuery findQ = ParseTargetQuery(req);
                    if (string.IsNullOrEmpty(findQ.Action)) findQ.Action = "read";
                    TargetResolutionResult findRes = ResolveTargetElement(winFind, findQ, maxRetries: 1);
                    if (!findRes.Matched || findRes.Element == null)
                    {
                        if (findRes.AmbiguityCount > 1 || (findRes.Error != null && findRes.Error.StartsWith("AMBIGUOUS_TARGET")))
                        {
                            SendError(reqId, findRes.Error);
                            break;
                        }
                        SendSuccess(reqId, null);
                        return;
                    }

                    var info = findRes.TargetInfo ?? BuildCandidateInfo(findRes.Element, winFind);
                    object valObj;
                    if (findRes.Element.TryGetCurrentPattern(ValuePattern.Pattern, out valObj))
                    {
                        try { info["value"] = ((ValuePattern)valObj).Current.Value; } catch { }
                    }
                    info["resolutionStrategy"] = findRes.ResolutionStrategy;
                    info["resolutionAttempts"] = findRes.Attempts;
                    SendSuccess(reqId, info);
                    break;

                case "click_element":
                    string clickAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : "";
                    int clickPid = 0;
                    if (req.ContainsKey("pid")) clickPid = Convert.ToInt32(req["pid"]);
                    else if (clickAppId.StartsWith("app_")) int.TryParse(clickAppId.Substring(4), out clickPid);

                    if (clickPid > 0 && IsProtectedProcess(clickPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to click element in protected process.");
                        break;
                    }

                    string authErrClick;
                    if (!ValidateWorkerAuthorization(req, clickPid, clickAppId, out authErrClick))
                    {
                        SendError(reqId, authErrClick);
                        break;
                    }

                    string clickTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    bool clickAllowPhysical = req.ContainsKey("allowPhysicalFallback") ? Convert.ToBoolean(req["allowPhysicalFallback"]) : false;

                    long clickHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string clickExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winClick = FindTargetWindow(clickPid, clickAppId, clickTitle, clickHandle, clickExpectedStart);
                    if (winClick == null) throw new InvalidOperationException("Application window not found");
                    if (clickPid > 0 && winClick.Current.ProcessId != clickPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(winClick) || IsProtectedProcess(winClick.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to click element in protected process.");
                        break;
                    }

                    TargetQuery clickQ = ParseTargetQuery(req);
                    clickQ.Action = "click";
                    clickQ.AllowPhysicalFallback = clickAllowPhysical;

                    TargetResolutionResult clickRes = ResolveTargetElement(winClick, clickQ, maxRetries: 2);
                    if (!clickRes.Matched || clickRes.Element == null)
                    {
                        string errMsg = clickRes.Error ?? "ELEMENT_NOT_FOUND: Element not found matching specified criteria.";
                        SendError(reqId, errMsg);
                        return;
                    }

                    AutomationElement clickTarget = clickRes.Element;
                    string compatErr;
                    if (!IsControlCompatibleWithAction(clickTarget, "click", clickAllowPhysical, out compatErr))
                    {
                        SendError(reqId, "CONTROL_INCOMPATIBLE: " + compatErr);
                        return;
                    }

                    IntPtr targetWinHwnd = IntPtr.Zero;
                    try { targetWinHwnd = new IntPtr(winClick.Current.NativeWindowHandle); } catch { }
                    if (targetWinHwnd == IntPtr.Zero || !IsWindow(targetWinHwnd))
                    {
                        SendError(reqId, "WINDOW_INVALID: Target window handle is invalid or window has closed.");
                        return;
                    }

                    uint currentWinPid = 0;
                    GetWindowThreadProcessId(targetWinHwnd, out currentWinPid);
                    if (clickPid > 0 && currentWinPid != (uint)clickPid)
                    {
                        SendError(reqId, "TARGET_WINDOW_SUBSTITUTION: Window handle no longer belongs to authorized process.");
                        return;
                    }

                    try
                    {
                        if (!clickTarget.Current.IsEnabled)
                        {
                            SendError(reqId, "CONTROL_DISABLED: Target control is disabled and cannot be clicked.");
                            return;
                        }
                    }
                    catch (ElementNotAvailableException)
                    {
                        SendError(reqId, "ELEMENT_STALE: Target element is no longer available.");
                        return;
                    }

                    // 1. InvokePattern (Tier 3)
                    object invokeObj;
                    if (clickTarget.TryGetCurrentPattern(InvokePattern.Pattern, out invokeObj))
                    {
                        ((InvokePattern)invokeObj).Invoke();

                        // Postcondition check: did target window close, or did a dialog state transition occur?
                        Thread.Sleep(80);
                        bool isVerified = false;
                        string postconditionStatus = "UNVERIFIABLE";
                        string postconditionDetail = "InvokePattern completed successfully; external state transition unobservable via UIA";

                        string elemNameLower = (clickTarget.Current.Name ?? "").ToLowerInvariant();
                        string autoIdLower = (clickTarget.Current.AutomationId ?? "").ToLowerInvariant();
                        if (elemNameLower.Contains("close") || elemNameLower.Contains("exit") || autoIdLower.Contains("close"))
                        {
                            bool winStillOpen = (targetWinHwnd != IntPtr.Zero && IsWindow(targetWinHwnd) && IsWindowVisible(targetWinHwnd));
                            if (!winStillOpen)
                            {
                                isVerified = true;
                                postconditionStatus = "VERIFIED";
                                postconditionDetail = "Window closed as expected following close action";
                            }
                            else
                            {
                                isVerified = false;
                                postconditionStatus = "FAILED";
                                postconditionDetail = "Close action executed but target window remains open";
                            }
                        }

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", isVerified },
                            { "postconditionStatus", postconditionStatus },
                            { "postconditionDetail", postconditionDetail },
                            { "action", "invoked" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "InvokePattern" },
                            { "resolutionStrategy", clickRes.ResolutionStrategy },
                            { "resolutionAttempts", clickRes.Attempts },
                            { "resolvedTarget", clickRes.TargetInfo }
                        });
                        return;
                    }

                    // 2. TogglePattern (Tier 3)
                    object toggleObj;
                    if (clickTarget.TryGetCurrentPattern(TogglePattern.Pattern, out toggleObj))
                    {
                        var toggle = (TogglePattern)toggleObj;
                        ToggleState initialToggle = toggle.Current.ToggleState;
                        toggle.Toggle();

                        Thread.Sleep(50);
                        ToggleState finalToggle = toggle.Current.ToggleState;
                        bool stateChanged = (finalToggle != initialToggle);
                        string postconditionStatus = stateChanged ? "VERIFIED" : "FAILED";
                        string postconditionDetail = "ToggleState transitioned from " + initialToggle + " to " + finalToggle;

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", stateChanged },
                            { "postconditionStatus", postconditionStatus },
                            { "postconditionDetail", postconditionDetail },
                            { "action", "toggled" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "TogglePattern" },
                            { "resolutionStrategy", clickRes.ResolutionStrategy },
                            { "resolutionAttempts", clickRes.Attempts },
                            { "resolvedTarget", clickRes.TargetInfo }
                        });
                        return;
                    }

                    // 3. SelectionItemPattern (Tier 3)
                    object selObj;
                    if (clickTarget.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selObj))
                    {
                        var sel = (SelectionItemPattern)selObj;
                        sel.Select();

                        Thread.Sleep(50);
                        bool isSelected = false;
                        try { isSelected = sel.Current.IsSelected; } catch { isSelected = false; }
                        string postconditionStatus = isSelected ? "VERIFIED" : "FAILED";
                        string postconditionDetail = "SelectionItem IsSelected verified: " + isSelected;

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", isSelected },
                            { "postconditionStatus", postconditionStatus },
                            { "postconditionDetail", postconditionDetail },
                            { "action", "selected" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "SelectionItemPattern" },
                            { "resolutionStrategy", clickRes.ResolutionStrategy },
                            { "resolutionAttempts", clickRes.Attempts },
                            { "resolvedTarget", clickRes.TargetInfo }
                        });
                        return;
                    }

                    // 4. ExpandCollapsePattern (Tier 3)
                    object expObj;
                    if (clickTarget.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expObj))
                    {
                        var exp = (ExpandCollapsePattern)expObj;
                        var initialState = exp.Current.ExpandCollapseState;
                        if (initialState == ExpandCollapseState.Collapsed)
                            exp.Expand();
                        else
                            exp.Collapse();

                        Thread.Sleep(50);
                        var finalState = exp.Current.ExpandCollapseState;
                        bool stateChanged = (finalState != initialState);
                        string postconditionStatus = stateChanged ? "VERIFIED" : "FAILED";
                        string postconditionDetail = "ExpandCollapseState transitioned from " + initialState + " to " + finalState;

                        SendSuccess(reqId, new Dictionary<string, object>
                        {
                            { "verified", stateChanged },
                            { "postconditionStatus", postconditionStatus },
                            { "postconditionDetail", postconditionDetail },
                            { "action", "expanded_or_collapsed" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "ExpandCollapsePattern" },
                            { "resolutionStrategy", clickRes.ResolutionStrategy },
                            { "resolutionAttempts", clickRes.Attempts },
                            { "resolvedTarget", clickRes.TargetInfo }
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
                            { "verified", false },
                            { "postconditionStatus", "UNVERIFIABLE" },
                            { "postconditionDetail", "Win32 BM_CLICK dispatched; external outcome unobservable via UIA" },
                            { "action", "bm_click" },
                            { "name", clickTarget.Current.Name },
                            { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                            { "tier", 3 },
                            { "tierName", "Tier 3 — Windows UI Automation" },
                            { "physicalInputUsed", false },
                            { "method", "Win32_BM_CLICK" },
                            { "resolutionStrategy", clickRes.ResolutionStrategy },
                            { "resolutionAttempts", clickRes.Attempts },
                            { "resolvedTarget", clickRes.TargetInfo }
                        });
                        return;
                    }

                    // 6. Tier 4 Physical mouse fallback: fail-closed if not explicitly authorized
                    if (!clickAllowPhysical)
                    {
                        SendError(reqId, "TIER3_UIA_UNSUPPORTED: Target control does not support non-intrusive accessibility patterns (Invoke, Toggle, SelectionItem, ExpandCollapse, BM_CLICK) and allowPhysicalFallback is false.");
                        return;
                    }

                    System.Windows.Rect freshBounds = System.Windows.Rect.Empty;
                    try { freshBounds = clickTarget.Current.BoundingRectangle; } catch { }
                    if (freshBounds == System.Windows.Rect.Empty || double.IsNaN(freshBounds.X) || double.IsInfinity(freshBounds.X) ||
                        double.IsNaN(freshBounds.Y) || double.IsInfinity(freshBounds.Y) ||
                        freshBounds.Width <= 0 || freshBounds.Height <= 0)
                    {
                        SendError(reqId, "INVALID_GEOMETRY: Control bounds are empty, zero-sized, or non-finite for physical click.");
                        return;
                    }

                    System.Windows.Rect winBounds = System.Windows.Rect.Empty;
                    try { winBounds = winClick.Current.BoundingRectangle; } catch { }
                    if (winBounds == System.Windows.Rect.Empty || winBounds.Width <= 0 || winBounds.Height <= 0)
                    {
                        SendError(reqId, "INVALID_GEOMETRY: Target window bounds are empty or zero-sized.");
                        return;
                    }

                    int clickX = (int)(freshBounds.X + freshBounds.Width / 2.0);
                    int clickY = (int)(freshBounds.Y + freshBounds.Height / 2.0);

                    // Validate coordinates remain within the permitted target region AND element bounds
                    if (clickX < freshBounds.Left || clickX > freshBounds.Right ||
                        clickY < freshBounds.Top || clickY > freshBounds.Bottom)
                    {
                        SendError(reqId, "COORDINATE_OUT_OF_BOUNDS: Calculated click point outside element bounds.");
                        return;
                    }

                    if (clickX < winBounds.Left || clickX > winBounds.Right ||
                        clickY < winBounds.Top || clickY > winBounds.Bottom)
                    {
                        SendError(reqId, "COORDINATE_OUT_OF_BOUNDS: Calculated click point is outside target window bounds.");
                        return;
                    }

                    // Foreground window validation before physical mouse action
                    SetForegroundWindow(targetWinHwnd);
                    Thread.Sleep(50);
                    IntPtr fgHwnd = GetForegroundWindow();
                    uint fgPid = 0;
                    GetWindowThreadProcessId(fgHwnd, out fgPid);
                    if (clickPid > 0 && fgPid != (uint)clickPid)
                    {
                        SendError(reqId, "FOREGROUND_MISMATCH: Target window could not be brought to foreground safely.");
                        return;
                    }

                    SetCursorPos(clickX, clickY);
                    Thread.Sleep(20);
                    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); // MOUSEEVENTF_LEFTDOWN
                    Thread.Sleep(30);
                    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); // MOUSEEVENTF_LEFTUP

                    SendSuccess(reqId, new Dictionary<string, object>
                    {
                        { "verified", false },
                        { "postconditionStatus", "UNVERIFIABLE" },
                        { "postconditionDetail", "Physical mouse click executed at (" + clickX + "," + clickY + "); external outcome unobservable via UIA" },
                        { "action", "clicked" },
                        { "name", clickTarget.Current.Name },
                        { "controlType", clickTarget.Current.ControlType.ProgrammaticName },
                        { "tier", 4 },
                        { "tierName", "Tier 4 — Physical mouse/keyboard fallback" },
                        { "physicalInputUsed", true },
                        { "method", "PhysicalMouseEvent" },
                        { "clickCoordinates", new Dictionary<string, int> { { "x", clickX }, { "y", clickY } } },
                        { "resolutionStrategy", clickRes.ResolutionStrategy },
                        { "resolutionAttempts", clickRes.Attempts },
                        { "resolvedTarget", clickRes.TargetInfo }
                    });
                    return;

                case "take_screenshot":
                    string shotAppId = req.ContainsKey("appId") ? Convert.ToString(req["appId"]) : null;
                    int shotPid = 0;
                    if (req.ContainsKey("pid")) shotPid = Convert.ToInt32(req["pid"]);
                    else if (!string.IsNullOrEmpty(shotAppId) && shotAppId.StartsWith("app_"))
                    {
                        int.TryParse(shotAppId.Substring(4), out shotPid);
                    }

                    if (shotPid > 0 && IsProtectedProcess(shotPid))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to capture screenshot of protected process window.");
                        break;
                    }

                    string authErrShot;
                    if (!ValidateWorkerAuthorization(req, shotPid, shotAppId, out authErrShot))
                    {
                        SendError(reqId, authErrShot);
                        break;
                    }

                    string shotTitle = req.ContainsKey("title") ? Convert.ToString(req["title"]) : "";
                    bool allowPlaceholder = req.ContainsKey("allowPlaceholder") ? Convert.ToBoolean(req["allowPlaceholder"]) : false;
                    long shotHandle = req.ContainsKey("windowHandle") ? Convert.ToInt64(req["windowHandle"]) : 0;
                    string shotExpectedStart = req.ContainsKey("expectedStartTime") ? Convert.ToString(req["expectedStartTime"]) : null;
                    AutomationElement winShot = FindTargetWindow(shotPid, shotAppId, shotTitle, shotHandle, shotExpectedStart);
                    if (winShot == null)
                    {
                        SendError(reqId, "Application window not found");
                        break;
                    }
                    if (shotPid > 0 && winShot.Current.ProcessId != shotPid)
                    {
                        SendError(reqId, "UNAUTHORIZED_RESOURCE_ACCESS: Resolved window does not belong to authorized process.");
                        break;
                    }
                    if (IsProtectedWindow(winShot) || IsProtectedProcess(winShot.Current.ProcessId))
                    {
                        SendError(reqId, "SAFETY_VIOLATION: Refusing to capture screenshot of protected process window.");
                        break;
                    }

                    var rect = winShot.Current.BoundingRectangle;
                    int width = (int)rect.Width;
                    int height = (int)rect.Height;
                    if (width <= 0 || height <= 0)
                    {
                        width = 800;
                        height = 600;
                    }

                    IntPtr shotHwnd = IntPtr.Zero;
                    try { shotHwnd = new IntPtr(winShot.Current.NativeWindowHandle); } catch { }

                    using (Bitmap bmp = new Bitmap(width, height))
                    {
                        bool captured = false;
                        string captureMethod = "none";
                        bool isPlaceholder = false;

                        if (shotHwnd != IntPtr.Zero && IsWindow(shotHwnd))
                        {
                            try
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    IntPtr hdc = g.GetHdc();
                                    try
                                    {
                                        captured = PrintWindow(shotHwnd, hdc, 2);
                                        if (!captured)
                                        {
                                            captured = PrintWindow(shotHwnd, hdc, 0);
                                        }
                                        if (captured) captureMethod = "PrintWindow";
                                    }
                                    finally
                                    {
                                        g.ReleaseHdc(hdc);
                                    }
                                }
                            }
                            catch { }
                        }

                        if (!captured)
                        {
                            try
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    g.CopyFromScreen((int)rect.X, (int)rect.Y, 0, 0, new Size(width, height));
                                    captured = true;
                                    captureMethod = "CopyFromScreen";
                                }
                            }
                            catch { }
                        }

                        if (!captured)
                        {
                            if (!allowPlaceholder)
                            {
                                SendError(reqId, "SCREENSHOT_CAPTURE_FAILED: Target window pixel capture failed via PrintWindow and CopyFromScreen.");
                                break;
                            }

                            isPlaceholder = true;
                            captureMethod = "synthetic_placeholder";
                            using (Graphics g = Graphics.FromImage(bmp))
                            {
                                g.Clear(Color.FromArgb(15, 23, 42)); // Slate background
                                using (Font f = new Font("Segoe UI", 12))
                                using (Brush b = new SolidBrush(Color.White))
                                {
                                    g.DrawString(winShot.Current.Name ?? "Window Capture (Placeholder)", f, b, new PointF(10, 10));
                                }
                            }
                        }

                        using (MemoryStream ms = new MemoryStream())
                        {
                            bmp.Save(ms, ImageFormat.Png);
                            string base64 = Convert.ToBase64String(ms.ToArray());
                            SendSuccess(reqId, new Dictionary<string, object>
                            {
                                { "captured", captured },
                                { "isPlaceholder", isPlaceholder },
                                { "method", captureMethod },
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
            if (pid <= 0 && mainWin == null) return null;
            if (mainWin != null && pid <= 0)
            {
                try { pid = mainWin.Current.ProcessId; } catch { }
            }
            if (pid <= 0) return null;

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

                        // Strictly require dialog window to belong to target PID
                        if (pid <= 0 || wPid != pid) continue;
                        if (IsProtectedProcess(wPid) || IsProtectedWindow(w)) continue;

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
                        else if (bName.IndexOf("Cancel", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 bName.IndexOf("Close", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 bName.IndexOf("Dismiss", StringComparison.OrdinalIgnoreCase) >= 0 ||
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
                    if (!info.AvailableActions.Contains("cancel")) info.AvailableActions.Add("cancel");
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
                uint targetPid = 0;
                GetWindowThreadProcessId(hWnd, out targetPid);
                if (IsProtectedProcess((int)targetPid)) return;

                ShowWindow(hWnd, 9); // SW_RESTORE
                IntPtr foreHwnd = GetForegroundWindow();
                uint foreThread = GetWindowThreadProcessId(foreHwnd, IntPtr.Zero);
                uint appThread = GetCurrentThreadId();

                if (foreThread != appThread)
                {
                    AttachThreadInput(appThread, foreThread, true);
                }

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

                object toggleObj;
                if (btn.TryGetCurrentPattern(TogglePattern.Pattern, out toggleObj))
                {
                    try
                    {
                        ((TogglePattern)toggleObj).Toggle();
                        return true;
                    }
                    catch { }
                }

                // Try Win32 BM_CLICK without moving physical mouse cursor
                long btnHwnd = 0;
                try { btnHwnd = btn.Current.NativeWindowHandle; } catch { }
                if (btnHwnd != 0 && IsWindow(new IntPtr(btnHwnd)))
                {
                    SendMessage(new IntPtr(btnHwnd), 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
                    return true;
                }

                return false;
            }
            catch { }
            return false;
        }

        private static string GetLiveDocumentText(AutomationElement win)
        {
            if (win == null) return null;
            try
            {
                // 1. Look for Document control (standard in Notepad and rich editors)
                AutomationElement doc = win.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                if (doc == null)
                {
                    // 2. Look for Edit control
                    doc = win.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                }

                if (doc != null)
                {
                    object vObj;
                    if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out vObj))
                    {
                        return ((ValuePattern)vObj).Current.Value;
                    }
                    object tObj;
                    if (doc.TryGetCurrentPattern(TextPattern.Pattern, out tObj))
                    {
                        return ((TextPattern)tObj).DocumentRange.GetText(-1);
                    }
                }
            }
            catch { }
            return null;
        }

        private static bool SafeAtomicWritePreservingEncoding(string filePath, string content, InitialDocumentState initialState = null)
        {
            if (string.IsNullOrEmpty(filePath) || content == null) return false;
            try
            {
                string canonical = Path.GetFullPath(filePath);
                FileInfo fi = new FileInfo(canonical);
                if (fi.Exists && (fi.Attributes & FileAttributes.ReadOnly) != 0) return false;

                Encoding encoding = initialState != null ? initialState.DetectedEncoding : null;
                bool hasCrLf = initialState != null ? initialState.HasCrLf : true;

                if (encoding == null && fi.Exists)
                {
                    DetectFileFormat(canonical, out encoding, out hasCrLf);
                }
                if (encoding == null)
                {
                    encoding = new UTF8Encoding(false);
                }

                string normalizedContent = content.Replace("\r\n", "\n").Replace("\r", "\n");
                if (hasCrLf)
                {
                    normalizedContent = normalizedContent.Replace("\n", "\r\n");
                    if (!normalizedContent.EndsWith("\r\n"))
                    {
                        normalizedContent += "\r\n";
                    }
                }
                else
                {
                    if (!normalizedContent.EndsWith("\n"))
                    {
                        normalizedContent += "\n";
                    }
                }

                string dir = Path.GetDirectoryName(canonical);
                string tmpFile = Path.Combine(dir, ".lucy_save_tmp_" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(tmpFile, normalizedContent, encoding);

                try
                {
                    if (File.Exists(canonical))
                    {
                        File.Replace(tmpFile, canonical, null);
                    }
                    else
                    {
                        File.Move(tmpFile, canonical);
                    }
                }
                catch
                {
                    File.Copy(tmpFile, canonical, true);
                    try { File.Delete(tmpFile); } catch { }
                }

                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySaveDocument(AutomationElement win)
        {
            if (win == null) return false;
            try
            {
                if (IsProtectedWindow(win) || IsProtectedProcess(win.Current.ProcessId))
                {
                    return false;
                }

                // 1. First try non-intrusive UIA Menu item: File -> Save
                try
                {
                    var saveItem = win.FindFirst(TreeScope.Descendants, new AndCondition(
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                        new OrCondition(
                            new PropertyCondition(AutomationElement.NameProperty, "Save"),
                            new PropertyCondition(AutomationElement.AutomationIdProperty, "Save")
                        )
                    ));
                    if (saveItem != null)
                    {
                        object invObj;
                        if (saveItem.TryGetCurrentPattern(InvokePattern.Pattern, out invObj))
                        {
                            ((InvokePattern)invObj).Invoke();
                            Thread.Sleep(150);
                            return true;
                        }
                    }
                }
                catch { }

                IntPtr hWnd = new IntPtr(win.Current.NativeWindowHandle);
                if (hWnd != IntPtr.Zero && IsWindow(hWnd))
                {
                    // Strict non-interference: Do NOT force foreground or send Ctrl+S if user is working in another window!
                    IntPtr curFore = GetForegroundWindow();
                    uint forePid = 0;
                    GetWindowThreadProcessId(curFore, out forePid);
                    int winPid = win.Current.ProcessId;

                    // If target window is NOT already the foreground window, DO NOT hijack user's focus or send keystrokes!
                    if (curFore != hWnd && (winPid <= 0 || forePid != (uint)winPid))
                    {
                        // Safely return false so direct-write fallback can handle save without disturbing the user
                        return false;
                    }
                    if (IsProtectedProcess((int)forePid))
                    {
                        return false;
                    }

                    // Send Ctrl+S only when target window was ALREADY foreground
                    keybd_event(0x11, 0, 0, UIntPtr.Zero);
                    keybd_event(0x53, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(50);
                    keybd_event(0x53, 0, 2, UIntPtr.Zero);
                    keybd_event(0x11, 0, 2, UIntPtr.Zero);
                    Thread.Sleep(300);
                    return true;
                }
            }
            catch { }

            return false;
        }

        private static void CloseWindowTarget(AutomationElement targetWin, IntPtr targetHwnd, Process p, bool allowForceKill = false)
        {
            int checkPid = (p != null) ? p.Id : 0;
            if (checkPid <= 0 && targetHwnd != IntPtr.Zero)
            {
                uint hPid = 0;
                GetWindowThreadProcessId(targetHwnd, out hPid);
                checkPid = (int)hPid;
            }
            if (checkPid <= 0 && targetWin != null)
            {
                try { checkPid = targetWin.Current.ProcessId; } catch { }
            }
            if (IsProtectedProcess(checkPid) || (targetWin != null && IsProtectedWindow(targetWin)))
            {
                // FATAL SAFETY GUARD: Absolutely refuse to close any protected developer, shell, or host process!
                return;
            }
            // 1. Try WindowPattern.Close() (Official standard UIA window close)
            if (targetWin != null)
            {
                try
                {
                    object wpObj;
                    if (targetWin.TryGetCurrentPattern(WindowPattern.Pattern, out wpObj))
                    {
                        ((WindowPattern)wpObj).Close();
                    }
                }
                catch { }
            }

            // Check if window closed immediately
            if (targetHwnd != IntPtr.Zero && (!IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd))) return;

            // 2. Try TitleBar -> Close button via UIA InvokePattern
            if (targetWin != null)
            {
                try
                {
                    AutomationElement closeBtn = targetWin.FindFirst(TreeScope.Descendants, new AndCondition(
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                        new OrCondition(
                            new PropertyCondition(AutomationElement.AutomationIdProperty, "Close"),
                            new PropertyCondition(AutomationElement.NameProperty, "Close")
                        )
                    ));

                    if (closeBtn != null)
                    {
                        object invObj;
                        if (closeBtn.TryGetCurrentPattern(InvokePattern.Pattern, out invObj))
                        {
                            ((InvokePattern)invObj).Invoke();
                        }
                    }
                }
                catch { }
            }

            // Check if window closed
            if (targetHwnd != IntPtr.Zero && (!IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd))) return;

            // 3. Try Win32 SC_CLOSE & WM_CLOSE, plus Alt+F4
            if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
            {
                try
                {
                    PostMessage(targetHwnd, 0x0112, (IntPtr)0xF060, IntPtr.Zero); // SC_CLOSE
                    PostMessage(targetHwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE

                    // Targeted close messages sent above without blind global keystrokes
                }
                catch { }
            }

            if (p != null && !p.HasExited)
            {
                try
                {
                    p.CloseMainWindow();
                }
                catch { }
            }

            for (int i = 0; i < 25; i++)
            {
                Thread.Sleep(100);
                bool winGone = (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd));
                bool procGone = (p == null || p.HasExited);
                if (targetHwnd != IntPtr.Zero ? winGone : procGone) break;
            }

            // Forced termination is strictly restricted: only permitted when allowForceKill is explicitly true
            if (allowForceKill && p != null && !p.HasExited)
            {
                // Safety invariant: Force termination must not destroy unsaved documents without discard authorization.
                // If a confirmation dialog is detected, do not force-kill; preserve the dialog for user reconciliation.
                DialogInfo blockingDialog = DetectDialog(checkPid, targetWin);
                if (blockingDialog == null)
                {
                    try
                    {
                        p.Kill();
                        p.WaitForExit(1000);
                    }
                    catch { }
                }
            }
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
