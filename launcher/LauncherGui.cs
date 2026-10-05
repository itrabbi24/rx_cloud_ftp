using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Windows.Forms;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32;

namespace RxCloude
{
    public class MainForm : Form
    {
        // Keep in sync with package.json "version" and the web UI.
        public const string AppVersion = "1.3.3";

        private TextBox txtFolder;
        private TextBox txtPort;
        private Button btnBrowse;
        private Button btnStart;
        private Label btnStartIcon;
        private CheckBox chkHttps;

        // Segoe Fluent Icons ships with Windows 11 (and is installable on 10);
        // Segoe MDL2 Assets ships with Windows 10.
        private static readonly bool HasFluentIcons = IsFontInstalled("Segoe Fluent Icons");
        // Windows Server 2012 and older have neither icon font; the glyphs then
        // rendered as empty boxes, so icons are skipped there.
        private static readonly bool HasMdl2Icons = IsFontInstalled("Segoe MDL2 Assets");

        private static bool IsFontInstalled(string name)
        {
            try
            {
                using (System.Drawing.Text.InstalledFontCollection fonts = new System.Drawing.Text.InstalledFontCollection())
                {
                    foreach (System.Drawing.FontFamily family in fonts.Families)
                    {
                        if (string.Equals(family.Name, name, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                }
            }
            catch { }
            return false;
        }
        private Button btnOpen;
        private TextBox txtLogs;
        private Label lblStatus;
        private CheckBox chkAutoStart;
        private NotifyIcon trayIcon;
        private Process serverProcess = null;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);
        private const int ATTACH_PARENT_PROCESS = -1;

        // Set when Windows starts the launcher at sign-in (see auto-start).
        private static bool launchedByAutoStart = false;
        private const string AutoStartFlag = "--autostart";

        // --- Self-update ---------------------------------------------------
        // Releases are published on GitHub by .github/workflows/release.yml.
        private const string UpdateRepo = "itrabbi24/rx_cloud_ftp";
        private const string AfterUpdateFlag = "--after-update";
        private const string StartServerFlag = "--start-server";
        private static bool launchedAfterUpdate = false;
        private static bool startServerOnLaunch = false;
        private string latestVersion = null;
        private string latestDownloadUrl = null;
        private string latestReleasePage = null;
        private bool updateInProgress = false;
        private Button btnUpdate;
        private Timer updateTimer;

        // Leftovers from a previous self-update (the replaced exe and any
        // half-finished download) are removed on the next start.
        private static void CleanupOldUpdateFiles()
        {
            string exe = Application.ExecutablePath;
            try { if (File.Exists(exe + ".old")) File.Delete(exe + ".old"); } catch { }
            try { if (File.Exists(exe + ".download")) File.Delete(exe + ".download"); } catch { }
        }

        private static Version ParseVersion(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            string v = value.Trim().TrimStart('v', 'V');
            int dash = v.IndexOfAny(new char[] { '-', '+' });
            if (dash > 0) v = v.Substring(0, dash);
            Version parsed;
            return Version.TryParse(v, out parsed) ? parsed : null;
        }

        private static string JsonString(string json, string key)
        {
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(json,
                "\"" + key + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
            return m.Success ? m.Groups[1].Value.Replace("\\/", "/") : null;
        }

        // Asks GitHub for the latest release. Runs on a worker thread; results
        // are applied on the UI thread. silent = no message when up to date.
        private void CheckForUpdates(bool silent)
        {
            System.Threading.ThreadPool.QueueUserWorkItem(delegate {
                string error = null;
                string tag = null, page = null, download = null;
                try
                {
                    // .NET Framework 4.x defaults to TLS 1.0, which GitHub refuses.
                    System.Net.ServicePointManager.SecurityProtocol |= (System.Net.SecurityProtocolType)3072;
                    using (System.Net.WebClient wc = new System.Net.WebClient())
                    {
                        wc.Headers[System.Net.HttpRequestHeader.UserAgent] = "RxCloude-Launcher/" + AppVersion;
                        wc.Headers[System.Net.HttpRequestHeader.Accept] = "application/vnd.github+json";
                        wc.Encoding = System.Text.Encoding.UTF8;
                        string json = wc.DownloadString("https://api.github.com/repos/" + UpdateRepo + "/releases/latest");
                        tag = JsonString(json, "tag_name");
                        page = JsonString(json, "html_url");
                        System.Text.RegularExpressions.Match asset = System.Text.RegularExpressions.Regex.Match(json,
                            "\"browser_download_url\"\\s*:\\s*\"([^\"]*/RxCloude\\.exe)\"");
                        if (asset.Success) download = asset.Groups[1].Value;
                    }
                }
                catch (Exception ex) { error = ex.Message; }

                if (this.IsDisposed) return;
                try
                {
                    this.BeginInvoke(new Action(delegate {
                        if (error != null)
                        {
                            // Offline LAN servers are normal; stay quiet unless asked.
                            if (!silent) AddLog("Update check failed (no internet access?): " + error);
                            return;
                        }
                        Version latest = ParseVersion(tag);
                        Version current = ParseVersion(AppVersion);
                        if (latest == null || current == null || latest <= current)
                        {
                            if (!silent) AddLog("Rx Cloude is up to date (v" + AppVersion + ").");
                            return;
                        }
                        bool firstNotice = latestVersion != latest.ToString();
                        latestVersion = latest.ToString();
                        latestDownloadUrl = download;
                        latestReleasePage = page;
                        btnUpdate.Text = "Update to v" + latestVersion;
                        btnUpdate.Visible = true;
                        btnUpdate.BringToFront();
                        if (firstNotice)
                        {
                            AddLog(string.Format("Update available: v{0} (you have v{1}). Click \"Update to v{0}\" to install it.", latestVersion, AppVersion));
                            trayIcon.ShowBalloonTip(5000, "Rx Cloude update available",
                                "Version " + latestVersion + " is ready. Open Rx Cloude and click Update.", ToolTipIcon.Info);
                        }
                    }));
                }
                catch { }
            });
        }

        private void BtnUpdate_Click(object sender, EventArgs e)
        {
            if (updateInProgress || string.IsNullOrEmpty(latestVersion)) return;
            if (string.IsNullOrEmpty(latestDownloadUrl))
            {
                // Release without an exe attached: send the user to the page.
                if (!string.IsNullOrEmpty(latestReleasePage)) Process.Start(new ProcessStartInfo(latestReleasePage) { UseShellExecute = true });
                return;
            }
            bool running = serverProcess != null && !serverProcess.HasExited;
            DialogResult answer = MessageBox.Show(this,
                "Install Rx Cloude v" + latestVersion + " now?\r\n\r\n" +
                (running ? "The server will stop for a few seconds and start again automatically.\r\n" : "") +
                "Your files, users and settings are kept.",
                "Rx Cloude update", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
            StartSelfUpdate(running);
        }

        private void StartSelfUpdate(bool restartServer)
        {
            string exe = Application.ExecutablePath;
            string download = exe + ".download";
            string backup = exe + ".old";

            // The exe folder must be writable (not e.g. C:\Program Files).
            try
            {
                using (FileStream probe = File.Create(download)) { }
            }
            catch (Exception ex)
            {
                AddLog("Cannot update here: the folder is not writable (" + ex.Message + ").");
                if (!string.IsNullOrEmpty(latestReleasePage)) Process.Start(new ProcessStartInfo(latestReleasePage) { UseShellExecute = true });
                return;
            }

            updateInProgress = true;
            btnUpdate.Enabled = false;
            btnUpdate.Text = "Downloading...";
            AddLog("Downloading Rx Cloude v" + latestVersion + "...");

            System.Net.ServicePointManager.SecurityProtocol |= (System.Net.SecurityProtocolType)3072;
            System.Net.WebClient wc = new System.Net.WebClient();
            wc.Headers[System.Net.HttpRequestHeader.UserAgent] = "RxCloude-Launcher/" + AppVersion;
            wc.DownloadProgressChanged += delegate(object s, System.Net.DownloadProgressChangedEventArgs e) {
                btnUpdate.Text = "Downloading " + e.ProgressPercentage + "%";
            };
            wc.DownloadFileCompleted += delegate(object s, System.ComponentModel.AsyncCompletedEventArgs e) {
                wc.Dispose();
                string problem = null;
                if (e.Error != null) problem = e.Error.Message;
                else if (e.Cancelled) problem = "download cancelled";
                else
                {
                    // Must look like a real Windows executable before we swap.
                    try
                    {
                        FileInfo fi = new FileInfo(download);
                        byte[] head = new byte[2];
                        using (FileStream fs = File.OpenRead(download)) fs.Read(head, 0, 2);
                        if (fi.Length < 5 * 1024 * 1024 || head[0] != (byte)'M' || head[1] != (byte)'Z') problem = "downloaded file is not a valid program";
                    }
                    catch (Exception ex) { problem = ex.Message; }
                }

                if (problem != null)
                {
                    try { File.Delete(download); } catch { }
                    AddLog("Update failed: " + problem);
                    updateInProgress = false;
                    btnUpdate.Enabled = true;
                    btnUpdate.Text = "Update to v" + latestVersion;
                    return;
                }

                AddLog("Installing update...");
                StopServer();
                try
                {
                    // Windows allows renaming a running exe, so swap in place.
                    if (File.Exists(backup)) File.Delete(backup);
                    File.Move(exe, backup);
                    File.Move(download, exe);
                }
                catch (Exception ex)
                {
                    try { if (!File.Exists(exe) && File.Exists(backup)) File.Move(backup, exe); } catch { }
                    AddLog("Update failed while replacing the program: " + ex.Message);
                    updateInProgress = false;
                    btnUpdate.Enabled = true;
                    btnUpdate.Text = "Update to v" + latestVersion;
                    return;
                }

                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(exe, AfterUpdateFlag + (restartServer ? " " + StartServerFlag : ""));
                    psi.UseShellExecute = false;
                    psi.WorkingDirectory = Path.GetDirectoryName(exe);
                    Process.Start(psi);
                }
                catch (Exception ex)
                {
                    AddLog("Update installed, but the new version could not be started: " + ex.Message + ". Please start RxCloude.exe again.");
                    return;
                }
                trayIcon.Visible = false;
                Application.Exit();
            };
            wc.DownloadFileAsync(new Uri(latestDownloadUrl), download);
        }

        [STAThread]
        public static void Main(string[] args)
        {
            // Windows auto-start passes this flag: open the GUI in the tray and
            // start the server. It used to open the window and do nothing.
            // if (args != null && args.Length == 1 && string.Equals(args[0], AutoStartFlag, StringComparison.OrdinalIgnoreCase))
            // {
            //     launchedByAutoStart = true;
            //     args = new string[0];
            // }
            // Launcher-only flags are consumed here; anything else means CLI mode.
            if (args != null && args.Length > 0)
            {
                System.Collections.Generic.List<string> rest = new System.Collections.Generic.List<string>();
                foreach (string a in args)
                {
                    if (string.Equals(a, AutoStartFlag, StringComparison.OrdinalIgnoreCase)) launchedByAutoStart = true;
                    else if (string.Equals(a, AfterUpdateFlag, StringComparison.OrdinalIgnoreCase)) launchedAfterUpdate = true;
                    else if (string.Equals(a, StartServerFlag, StringComparison.OrdinalIgnoreCase)) startServerOnLaunch = true;
                    else rest.Add(a);
                }
                args = rest.ToArray();
            }
            CleanupOldUpdateFiles();

            // If command line arguments provided for CLI mode, run headless
            if (args != null && args.Length > 0)
            {
                AttachConsole(ATTACH_PARENT_PROCESS);
                string engine = EnsureEngineExtracted();
                if (File.Exists(engine))
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = engine;
                    // psi.Arguments = string.Join(" ", args);
                    // Re-quote each argument: a folder like "D:\My Files" was split in two.
                    string[] quoted = new string[args.Length];
                    for (int i = 0; i < args.Length; i++) quoted[i] = QuoteArg(args[i]);
                    psi.Arguments = string.Join(" ", quoted);
                    // The engine is extracted to %LOCALAPPDATA%, so without this
                    // its data (users, settings, vault) landed there instead of
                    // beside RxCloude.exe. --root on the command line still wins.
                    bool hasRootArg = false;
                    foreach (string a in args) if (a == "--root" || a == "-r") hasRootArg = true;
                    if (!hasRootArg && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RX_CLOUDE_ROOT")))
                    {
                        psi.EnvironmentVariables["RX_CLOUDE_ROOT"] = CleanPath(AppDomain.CurrentDomain.BaseDirectory);
                    }
                    psi.UseShellExecute = false;
                    try
                    {
                        Process p = Process.Start(psi);
                        p.WaitForExit();
                        return;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("[RxCloude Error] " + ex.Message);
                        return;
                    }
                }
            }

            // One launcher per folder: a second copy would fight over the same
            // port and data files.
            bool firstInstance;
            string mutexName = "RxCloudeLauncher_" + AppDomain.CurrentDomain.BaseDirectory.ToLowerInvariant().GetHashCode().ToString("X");
            using (System.Threading.Mutex mutex = new System.Threading.Mutex(true, mutexName, out firstInstance))
            {
                // After a self-update the old launcher is still closing; wait for
                // it to release the mutex instead of reporting "already running".
                if (!firstInstance && launchedAfterUpdate)
                {
                    try { firstInstance = mutex.WaitOne(15000); }
                    catch (System.Threading.AbandonedMutexException) { firstInstance = true; }
                }
                if (!firstInstance)
                {
                    if (!launchedByAutoStart)
                    {
                        MessageBox.Show("Rx Cloude is already running from this folder.\r\nLook for its icon in the system tray (bottom-right, near the clock).",
                            "Rx Cloude", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }

        // The icon compiled into RxCloude.exe (/win32icon). The old code only
        // loaded app.ico from disk, so once the exe was copied to a server
        // without that file the window and tray showed the generic icon.
        private static Icon LoadAppIcon()
        {
            try
            {
                Icon embedded = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (embedded != null) return embedded;
            }
            catch { }
            try
            {
                string icoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                if (File.Exists(icoPath)) return new Icon(icoPath);
            }
            catch { }
            return SystemIcons.Application;
        }

        // Reads the settings the engine saved last time (data\config.json), so
        // the port, folder and HTTPS choice survive a restart. Minimal parsing:
        // the file is written by our own engine with JSON.stringify.
        private static string ReadConfigValue(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(json,
                "\"" + key + "\"\\s*:\\s*(\"((?:\\\\.|[^\"\\\\])*)\"|[0-9]+|true|false)");
            if (!m.Success) return null;
            if (m.Groups[2].Success && m.Groups[1].Value.StartsWith("\""))
            {
                return m.Groups[2].Value.Replace("\\\\", "\u0001").Replace("\\\"", "\"").Replace("\\/", "/").Replace("\u0001", "\\");
            }
            return m.Groups[1].Value;
        }

        public MainForm()
        {
            // Clean Light & Premium Theme
            this.Text = "Rx Cloude - Portable Server v" + AppVersion;

            this.Size = new Size(660, 540);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.ForeColor = Color.FromArgb(30, 41, 59);
            this.Font = new Font("Segoe UI", 9.5f);

            // Scale the hand-placed layout with Windows display scaling (125%/150%).
            this.AutoScaleDimensions = new SizeF(96F, 96F);
            this.AutoScaleMode = AutoScaleMode.Dpi;

            // Load app.ico if present
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            // string icoPath = Path.Combine(appDir, "app.ico");
            // if (File.Exists(icoPath))
            // {
            //     try {
            //         this.Icon = new Icon(icoPath);
            //     } catch { }
            // }
            this.Icon = LoadAppIcon();

            // System Tray Icon
            trayIcon = new NotifyIcon();
            trayIcon.Text = "Rx Cloude Server";
            // if (this.Icon != null) trayIcon.Icon = this.Icon;
            // Always the app's own icon (the generic one appeared when app.ico was missing).
            trayIcon.Icon = this.Icon;
            trayIcon.Visible = false;
            trayIcon.DoubleClick += delegate(object s, EventArgs e) {
                this.Show();
                this.WindowState = FormWindowState.Normal;
                trayIcon.Visible = false;
            };

            ContextMenu trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Open Control Panel", delegate(object s, EventArgs e) {
                this.Show();
                this.WindowState = FormWindowState.Normal;
                trayIcon.Visible = false;
            });
            trayMenu.MenuItems.Add("Open Web Drive", delegate(object s, EventArgs e) {
                BtnOpen_Click(null, null);
            });
            trayMenu.MenuItems.Add("Start / Stop Server", delegate(object s, EventArgs e) {
                BtnStart_Click(null, null);
            });
            trayMenu.MenuItems.Add("Check for updates", delegate(object s, EventArgs e) {
                AddLog("Checking for updates...");
                CheckForUpdates(false);
            });
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("Exit", delegate(object s, EventArgs e) {
                trayIcon.Visible = false;
                StopServer();
                Application.Exit();
            });
            trayIcon.ContextMenu = trayMenu;

            // Title
            Label lblTitle = new Label();
            lblTitle.Location = new Point(24, 18);
            lblTitle.Size = new Size(380, 32);
            lblTitle.Text = "Rx Cloude Server";
            lblTitle.Font = new Font("Segoe UI", 16, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(37, 99, 235);
            lblTitle.Location = new Point(66, 16);
            this.Controls.Add(lblTitle);
            MakeIcon(this, "\uE753", new Point(24, 15), new Size(38, 34), Color.FromArgb(37, 99, 235), 20);

            // Subtitle
            Label lblDev = new Label();
            lblDev.Location = new Point(26, 52);
            lblDev.Size = new Size(400, 20);
            lblDev.Text = "Portable Standalone Cloud Drive Server  |  v" + AppVersion;
            lblDev.Font = new Font("Segoe UI", 8.5f);
            lblDev.ForeColor = Color.FromArgb(100, 116, 139);
            this.Controls.Add(lblDev);

            // Status Badge
            lblStatus = new Label();
            lblStatus.Location = new Point(500, 22);
            lblStatus.Size = new Size(120, 28);
            lblStatus.Text = "\u25CF Stopped";
            lblStatus.TextAlign = ContentAlignment.MiddleCenter;
            lblStatus.Font = new Font("Segoe UI", 9, FontStyle.Bold);
            lblStatus.BackColor = Color.FromArgb(254, 226, 226);
            lblStatus.ForeColor = Color.FromArgb(220, 38, 38);
            this.Controls.Add(lblStatus);

            // Shown only when GitHub has a newer release.
            btnUpdate = new Button();
            // btnUpdate.Location = new Point(352, 22);
            // btnUpdate.Size = new Size(140, 28);
            // The title label (x 66-446) covered that spot; sit under the status badge instead.
            btnUpdate.Location = new Point(500, 54);
            btnUpdate.Size = new Size(120, 24);
            btnUpdate.Text = "Update";
            btnUpdate.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            btnUpdate.BackColor = Color.FromArgb(245, 158, 11);
            btnUpdate.ForeColor = Color.White;
            btnUpdate.FlatStyle = FlatStyle.Flat;
            btnUpdate.FlatAppearance.BorderSize = 0;
            btnUpdate.Cursor = Cursors.Hand;
            btnUpdate.Visible = false;
            btnUpdate.Click += BtnUpdate_Click;
            this.Controls.Add(btnUpdate);

            // Folder Label & Input
            Label lblFolder = new Label();
            lblFolder.Location = new Point(26, 86);
            lblFolder.Size = new Size(300, 20);
            lblFolder.Text = "Shared Folder (Storage Directory):";
            lblFolder.ForeColor = Color.FromArgb(71, 85, 105);
            lblFolder.Font = new Font("Segoe UI", 9, FontStyle.Bold);
            this.Controls.Add(lblFolder);

            txtFolder = new TextBox();
            txtFolder.Location = new Point(26, 108);
            txtFolder.Size = new Size(490, 26);
            // txtFolder.Text = Path.Combine(appDir, "shared_files");
            txtFolder.Text = Path.Combine(CleanPath(appDir), "shared_files");
            txtFolder.BackColor = Color.White;
            txtFolder.ForeColor = Color.FromArgb(15, 23, 42);
            txtFolder.BorderStyle = BorderStyle.FixedSingle;
            this.Controls.Add(txtFolder);

            // Browse Button
            btnBrowse = new Button();
            btnBrowse.Location = new Point(524, 106);
            btnBrowse.Size = new Size(100, 28);
            btnBrowse.Font = new Font("Segoe UI", 9);
            btnBrowse.Text = "Browse";
            btnBrowse.Padding = new Padding(24, 0, 0, 0);
            btnBrowse.BackColor = Color.FromArgb(241, 245, 249);
            btnBrowse.ForeColor = Color.FromArgb(51, 65, 85);
            btnBrowse.FlatStyle = FlatStyle.Flat;
            btnBrowse.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            btnBrowse.Click += BtnBrowse_Click;
            this.Controls.Add(btnBrowse);
            // Icon lives inside the button so a transparent background shows the
            // button colour instead of painting a white box over it.
            MakeIcon(btnBrowse, "\uE8B7", new Point(4, 3), new Size(20, 20), Color.FromArgb(51, 65, 85), 10);

            // Port Label & Input
            Label lblPort = new Label();
            lblPort.Location = new Point(26, 146);
            lblPort.Size = new Size(150, 20);
            lblPort.Text = "Port (e.g. 8080):";
            lblPort.ForeColor = Color.FromArgb(71, 85, 105);
            lblPort.Font = new Font("Segoe UI", 9, FontStyle.Bold);
            this.Controls.Add(lblPort);

            txtPort = new TextBox();
            txtPort.Location = new Point(26, 168);
            txtPort.Size = new Size(140, 26);
            txtPort.Text = "8080";
            txtPort.BackColor = Color.White;
            txtPort.ForeColor = Color.FromArgb(15, 23, 42);
            txtPort.BorderStyle = BorderStyle.FixedSingle;
            this.Controls.Add(txtPort);

            // Start / Stop Button
            btnStart = new Button();
            btnStart.Location = new Point(180, 165);
            btnStart.Size = new Size(210, 32);
            btnStart.Text = "Start Server";
            btnStart.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            btnStart.Padding = new Padding(26, 0, 0, 0);
            btnStart.BackColor = Color.FromArgb(37, 99, 235);
            btnStart.ForeColor = Color.White;
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.Click += BtnStart_Click;
            this.Controls.Add(btnStart);
            btnStartIcon = MakeIcon(btnStart, "\uE768", new Point(6, 5), new Size(22, 22), Color.FromArgb(15, 23, 42), 11);

            // Open Drive in Browser Button
            btnOpen = new Button();
            btnOpen.Location = new Point(400, 165);
            btnOpen.Size = new Size(220, 32);
            btnOpen.Text = "Open Web Drive";
            btnOpen.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btnOpen.Padding = new Padding(26, 0, 0, 0);
            btnOpen.BackColor = Color.FromArgb(16, 185, 129);
            btnOpen.ForeColor = Color.White;
            btnOpen.FlatStyle = FlatStyle.Flat;
            btnOpen.FlatAppearance.BorderSize = 0;
            btnOpen.Enabled = false;
            btnOpen.Click += BtnOpen_Click;
            this.Controls.Add(btnOpen);
            MakeIcon(btnOpen, "\uE774", new Point(6, 5), new Size(22, 22), Color.FromArgb(15, 23, 42), 11);

            // Checkbox: Start with Windows
            chkAutoStart = new CheckBox();
            chkAutoStart.Location = new Point(26, 204);
            chkAutoStart.Size = new Size(300, 22);
            chkAutoStart.Text = "Start automatically when Windows boots";
            chkAutoStart.Font = new Font("Segoe UI", 8.5f);
            chkAutoStart.ForeColor = Color.FromArgb(71, 85, 105);
            chkAutoStart.Checked = IsAutoStartEnabled();
            chkAutoStart.CheckedChanged += ChkAutoStart_CheckedChanged;
            this.Controls.Add(chkAutoStart);

            // Checkbox: HTTPS opt-in. Plain HTTP is the default because a browser
            // treats a bare "192.168.1.5:8080" as http:// and shows
            // ERR_EMPTY_RESPONSE against an HTTPS-only port, and the self-signed
            // certificate always raises a browser warning.
            Label lblHttps = new Label();
            lblHttps.Location = new Point(300, 204);
            lblHttps.Size = new Size(120, 22);
            lblHttps.Text = "Encrypt (HTTPS):";
            lblHttps.TextAlign = ContentAlignment.MiddleRight;
            lblHttps.Font = new Font("Segoe UI", 8.5f);
            lblHttps.ForeColor = Color.FromArgb(71, 85, 105);
            this.Controls.Add(lblHttps);

            chkHttps = new CheckBox();
            chkHttps.Location = new Point(426, 204);
            chkHttps.Size = new Size(200, 22);
            chkHttps.Text = "self-signed certificate";
            chkHttps.Font = new Font("Segoe UI", 8.5f);
            chkHttps.ForeColor = Color.FromArgb(71, 85, 105);
            chkHttps.Checked = false;
            chkHttps.Click += delegate(object s, EventArgs e) {
                if (chkHttps.Checked) AddLog("HTTPS enabled: the browser will warn about a self-signed certificate; accept it once.");
            };
            this.Controls.Add(chkHttps);

            // Logs Box
            Label lblLogs = new Label();
            lblLogs.Location = new Point(26, 236);
            lblLogs.Size = new Size(300, 20);
            lblLogs.Text = "Activity & Server Logs:";
            lblLogs.UseMnemonic = false; // otherwise "&" is hidden as a keyboard shortcut marker
            lblLogs.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            lblLogs.ForeColor = Color.FromArgb(100, 116, 139);
            this.Controls.Add(lblLogs);

            txtLogs = new TextBox();
            txtLogs.Location = new Point(26, 258);
            txtLogs.Size = new Size(594, 218);
            txtLogs.Multiline = true;
            txtLogs.ScrollBars = ScrollBars.Vertical;
            txtLogs.ReadOnly = true;
            txtLogs.BackColor = Color.White;
            txtLogs.ForeColor = Color.FromArgb(51, 65, 85);
            txtLogs.Font = new Font("Consolas", 9);
            txtLogs.BorderStyle = BorderStyle.FixedSingle;
            txtLogs.Text = "[System] Rx Cloude Portable Server Ready.\r\n";
            this.Controls.Add(txtLogs);

            // Small subtle footer credit
            Label lblFooterDev = new Label();
            lblFooterDev.Location = new Point(440, 480);
            lblFooterDev.Size = new Size(180, 16);
            lblFooterDev.Text = "Dev: ARG RABBI";
            lblFooterDev.TextAlign = ContentAlignment.MiddleRight;
            lblFooterDev.Font = new Font("Segoe UI", 7.5f);
            lblFooterDev.ForeColor = Color.FromArgb(148, 163, 184);
            this.Controls.Add(lblFooterDev);

            // Minimize to system tray
            this.Resize += delegate(object s, EventArgs e) {
                if (this.WindowState == FormWindowState.Minimized) {
                    this.Hide();
                    trayIcon.Visible = true;
                    trayIcon.ShowBalloonTip(1500, "Rx Cloude Server", "Server is running in background. Double click icon to restore.", ToolTipIcon.Info);
                }
            };

            this.FormClosing += delegate(object s, FormClosingEventArgs e) {
                trayIcon.Visible = false;
                StopServer();
            };

            // Firewall helper: on a fresh server Windows Firewall blocks other
            // devices, so the drive "works" only on the server itself.
            LinkLabel lnkFirewall = new LinkLabel();
            lnkFirewall.Location = new Point(26, 480);
            lnkFirewall.Size = new Size(300, 16);
            lnkFirewall.Text = "Allow other devices (Windows Firewall)";
            lnkFirewall.Font = new Font("Segoe UI", 7.5f);
            lnkFirewall.LinkColor = Color.FromArgb(37, 99, 235);
            lnkFirewall.LinkClicked += delegate(object s, LinkLabelLinkClickedEventArgs e) { AllowThroughFirewall(); };
            this.Controls.Add(lnkFirewall);

            LoadSavedSettings();

            // Update check: shortly after start, then once a day.
            this.Shown += delegate(object s3, EventArgs e3) { CheckForUpdates(true); };
            updateTimer = new Timer();
            updateTimer.Interval = 24 * 60 * 60 * 1000;
            updateTimer.Tick += delegate(object s4, EventArgs e4) { CheckForUpdates(true); };
            updateTimer.Start();

            if (launchedAfterUpdate)
            {
                AddLog("Rx Cloude was updated to v" + AppVersion + ".");
                if (startServerOnLaunch)
                {
                    this.Shown += delegate(object s5, EventArgs e5) { StartServer(); };
                }
            }
            // Do not open with the whole folder path selected.
            this.Shown += delegate(object s2, EventArgs e2) { this.ActiveControl = btnStart; txtFolder.SelectionLength = 0; };

            // Started by Windows at sign-in: go straight to the tray and serve.
            if (launchedByAutoStart)
            {
                this.Shown += delegate(object s, EventArgs e) {
                    StartServer();
                    this.WindowState = FormWindowState.Minimized;
                };
            }
        }

        // Port, folder and HTTPS from the last run (data\config.json). Before,
        // every launch reset to 8080 and the default folder, so a server set up
        // on another port or drive came back wrong after a reboot.
        private void LoadSavedSettings()
        {
            try
            {
                string configFile = Path.Combine(CleanPath(AppDomain.CurrentDomain.BaseDirectory), "data", "config.json");
                if (!File.Exists(configFile)) return;
                string json = File.ReadAllText(configFile);
                string port = ReadConfigValue(json, "port");
                string folder = ReadConfigValue(json, "sharedFolder");
                string scheme = ReadConfigValue(json, "scheme");
                int parsed;
                if (!string.IsNullOrEmpty(port) && int.TryParse(port, out parsed) && parsed > 0 && parsed <= 65535) txtPort.Text = port;
                if (!string.IsNullOrEmpty(folder)) txtFolder.Text = folder;
                if (string.Equals(scheme, "https", StringComparison.OrdinalIgnoreCase)) chkHttps.Checked = true;
            }
            catch { }
        }

        private void AllowThroughFirewall()
        {
            string port = CurrentPort();
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("netsh",
                    string.Format("advfirewall firewall add rule name=\"Rx Cloude (TCP {0})\" dir=in action=allow protocol=TCP localport={0} profile=any", port));
                psi.Verb = "runas"; // needs administrator rights
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process p = Process.Start(psi);
                p.WaitForExit(15000);
                if (p.HasExited && p.ExitCode == 0) AddLog(string.Format("Firewall: inbound TCP port {0} allowed. Other devices can now connect.", port));
                else AddLog("Firewall rule could not be added. Run as administrator, or add the rule manually.");
            }
            catch (Exception ex)
            {
                AddLog("Firewall rule not added: " + ex.Message);
            }
        }

        // True when the embedded engine resource differs from the extracted
        // copy. Compares length AND hash: a length-only check (the previous
        // behaviour) accepts a stale or damaged file of coincidentally equal
        // size and then keeps running old server code.
        private static bool EngineNeedsRefresh(string targetEngine, Stream embedded)
        {
            if (!File.Exists(targetEngine)) return true;
            try
            {
                FileInfo fi = new FileInfo(targetEngine);
                if (fi.Length != embedded.Length) return true;
                embedded.Position = 0;
                string embeddedHash;
                using (SHA256 sha = SHA256.Create())
                {
                    embeddedHash = BitConverter.ToString(sha.ComputeHash(embedded));
                }
                embedded.Position = 0;
                string targetHash;
                using (FileStream fs = File.OpenRead(targetEngine))
                using (SHA256 sha = SHA256.Create())
                {
                    targetHash = BitConverter.ToString(sha.ComputeHash(fs));
                }
                if (!string.Equals(embeddedHash, targetHash, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                // Identical bytes: the extracted copy is already current.
                return false;
            }
            catch
            {
                return true;
            }
        }

        private static string EnsureEngineExtracted()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string localEngine = Path.Combine(appDir, "RxCloudeEngine.exe");
            if (File.Exists(localEngine))
            {
                return localEngine;
            }

            string tempEngineDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RxCloude");
            if (!Directory.Exists(tempEngineDir))
            {
                Directory.CreateDirectory(tempEngineDir);
            }
            string targetEngine = Path.Combine(tempEngineDir, "RxCloudeEngine.exe");

            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream("RxCloude.Engine.exe"))
            {
                if (stream != null)
                {
                    if (!EngineNeedsRefresh(targetEngine, stream))
                    {
                        return targetEngine;
                    }

                    // Write to a temp file and move it into place so a failed
                    // copy can never leave a half-written engine behind.
                    stream.Position = 0;
                    string stagingEngine = targetEngine + "." + Process.GetCurrentProcess().Id + ".new";
                    using (var fileStream = new FileStream(stagingEngine, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        byte[] buffer = new byte[81920];
                        int bytesRead;
                        while ((bytesRead = stream.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            fileStream.Write(buffer, 0, bytesRead);
                        }
                    }

                    if (File.Exists(targetEngine))
                    {
                        try { File.Delete(targetEngine); } catch { }
                    }
                    // File.Move(stagingEngine, targetEngine);
                    // return targetEngine;
                    // If an older engine is still running (another copy of the
                    // launcher, or a crashed one) the old file is locked and the
                    // move threw, so the server could not start at all. Run the
                    // freshly written copy instead in that case.
                    try
                    {
                        File.Move(stagingEngine, targetEngine);
                        return targetEngine;
                    }
                    catch
                    {
                        return stagingEngine;
                    }
                }
            }

            // Fallback: Check if node and server_cli.js exist
            string jsPath = Path.Combine(appDir, "src", "server_cli.js");
            if (File.Exists(jsPath))
            {
                return "node";
            }

            return targetEngine;
        }

        private bool IsAutoStartEnabled()
        {
            try {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
                {
                    return key != null && key.GetValue("RxCloude") != null;
                }
            } catch { return false; }
        }

        private void ChkAutoStart_CheckedChanged(object sender, EventArgs e)
        {
            try {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key != null)
                    {
                        if (chkAutoStart.Checked)
                        {
                            string exePath = Application.ExecutablePath;
                            // key.SetValue("RxCloude", "\"" + exePath + "\"");
                            key.SetValue("RxCloude", "\"" + exePath + "\" " + AutoStartFlag);
                            AddLog("Auto-start with Windows ENABLED.");
                        }
                        else
                        {
                            key.DeleteValue("RxCloude", false);
                            AddLog("Auto-start with Windows DISABLED.");
                        }
                    }
                }
            } catch (Exception ex) {
                AddLog("Registry error: " + ex.Message);
            }
        }

        // Node stack traces are noise in a launcher window; only the first line
        // carries the real message, so drop the "at ..." frames and stray braces.
        private static string FilterEngineLine(string line)
        {
            if (string.IsNullOrEmpty(line)) return line;
            string trimmed = line.Trim();
            if (trimmed.StartsWith("at ")) return null;
            if (trimmed == "{" || trimmed == "}" || trimmed == "});") return null;
            if (trimmed.StartsWith("Node.js v")) return null;
            if (trimmed == "^" || trimmed.StartsWith("throw ")) return null;
            return line;
        }

        // Small helper for MDL2 icon labels: those glyphs are not in Segoe UI,
        // and a control can only use one font, so icons get their own label.
        private static Label MakeIcon(Control parent, string glyph, Point location, Size size, Color color, float fontSize)
        {
            Label icon = new Label();
            if (!HasFluentIcons && !HasMdl2Icons)
            {
                // No icon font: return a detached label so callers still work.
                icon.Visible = false;
                return icon;
            }
            icon.Text = glyph;
            icon.Location = location;
            icon.Size = size;
            // Segoe Fluent Icons renders every glyph we use; MDL2 Assets is the
            // fallback for older builds that do not ship Fluent.
            icon.Font = new Font(HasFluentIcons ? "Segoe Fluent Icons" : "Segoe MDL2 Assets", fontSize);
            icon.ForeColor = color;
            icon.TextAlign = ContentAlignment.MiddleCenter;
            icon.BackColor = Color.Transparent;
            parent.Controls.Add(icon);
            return icon;
        }

        private void AddLog(string msg)
        {
            if (string.IsNullOrEmpty(msg)) return;
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<string>(AddLog), msg);
                return;
            }
            string time = DateTime.Now.ToString("HH:mm:ss");
            txtLogs.AppendText(string.Format("[{0}] {1}\r\n", time, msg));
        }

        private void BtnBrowse_Click(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Select Folder for Rx Cloude";
                dlg.ShowNewFolderButton = true;
                if (!string.IsNullOrEmpty(txtFolder.Text) && Directory.Exists(txtFolder.Text))
                {
                    dlg.SelectedPath = txtFolder.Text;
                }
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    txtFolder.Text = dlg.SelectedPath;
                    AddLog("Selected folder: " + dlg.SelectedPath);
                }
            }
        }

        private void BtnStart_Click(object sender, EventArgs e)
        {
            if (serverProcess != null && !serverProcess.HasExited)
            {
                StopServer();
            }
            else
            {
                StartServer();
            }
        }

        // Removes surrounding quotes and trailing separators. A path like
        // C:\Folder" or C:\Folder\" used to reach the engine intact and crash it
        // with ENOENT: mkdir 'C:\Folder"\data'.
        private static string CleanPath(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            string cleaned = value.Trim().Trim('"').Trim();
            while (cleaned.Length > 3 && (cleaned.EndsWith("\\") || cleaned.EndsWith("/")))
            {
                cleaned = cleaned.Substring(0, cleaned.Length - 1);
            }
            return cleaned;
        }

        // Quotes a command-line argument the way the Windows C runtime expects,
        // so paths with spaces or quotes survive argument parsing.
        private static string QuoteArg(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            if (value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                    continue;
                }
                sb.Append('\\', backslashes);
                backslashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private void StartServer()
        {
            string port = txtPort.Text.Trim().Trim('"');
            if (string.IsNullOrEmpty(port)) port = "8080";
            foreach (char c in port)
            {
                if (!char.IsDigit(c))
                {
                    AddLog("Port must be a number. Using 8080 instead.");
                    port = "8080";
                    break;
                }
            }
            int portNumber;
            if (!int.TryParse(port, out portNumber) || portNumber < 1 || portNumber > 65535)
            {
                AddLog(string.Format("Port {0} is out of range (1-65535). Using 8080 instead.", port));
                port = "8080";
            }

            // Browsers will not open these ports (ERR_UNSAFE_PORT); stop here
            // with a clear message instead of a server nobody can reach.
            int[] browserBlocked = { 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080 };
            int chosenPort;
            if (int.TryParse(port, out chosenPort) && Array.IndexOf(browserBlocked, chosenPort) >= 0)
            {
                AddLog(string.Format("Port {0} is blocked by web browsers (ERR_UNSAFE_PORT). Use another port, e.g. 8090, 8888 or 9000.", port));
                MessageBox.Show(this, string.Format("Port {0} cannot be used: Chrome, Edge and Firefox refuse to open it (ERR_UNSAFE_PORT).\r\n\r\nPlease choose another port, for example 8090, 8888 or 9000.", port),
                    "Rx Cloude - port not allowed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                txtPort.Focus();
                txtPort.SelectAll();
                return;
            }

            string folder = CleanPath(txtFolder.Text);
            string appDir = CleanPath(AppDomain.CurrentDomain.BaseDirectory);

            if (string.IsNullOrEmpty(folder))
            {
                folder = Path.Combine(appDir, "shared_files");
            }
            if (!Directory.Exists(folder))
            {
                Directory.CreateDirectory(folder);
            }

            AddLog(string.Format("Starting Rx Cloude server engine on port {0}...", port));
            AddLog(string.Format("Data folder: {0}", appDir));

            try
            {
                string enginePath = EnsureEngineExtracted();
                ProcessStartInfo psi = new ProcessStartInfo();

                if (enginePath.Equals("node", StringComparison.OrdinalIgnoreCase))
                {
                    psi.FileName = "node";
                    psi.Arguments = string.Format("{0} --port {1} --dir {2} --root {3}",
                        QuoteArg(Path.Combine(appDir, "src", "server_cli.js")), port, QuoteArg(folder), QuoteArg(appDir));
                }
                else
                {
                    psi.FileName = enginePath;
                    psi.Arguments = string.Format("--port {0} --dir {1} --root {2}",
                        port, QuoteArg(folder), QuoteArg(appDir));
                }

                psi.WorkingDirectory = appDir;
                // Paths are passed by environment variable as the primary channel:
                // this avoids Windows command-line quoting entirely.
                psi.EnvironmentVariables["RX_CLOUDE_ROOT"] = appDir;
                psi.EnvironmentVariables["RX_CLOUDE_DIR"] = folder;
                psi.EnvironmentVariables["RX_CLOUDE_PORT"] = port;
                psi.EnvironmentVariables["RX_CLOUDE_SCHEME"] = chkHttps.Checked ? "https" : "http";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;

                serverProcess = new Process();
                serverProcess.StartInfo = psi;
                firstRunPassword = null;
                serverProcess.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) {
                    if (!string.IsNullOrEmpty(e.Data)) AddLog(FilterEngineLine(e.Data));
                    // The engine prints generated admin credentials on a fresh install.
                    if (!string.IsNullOrEmpty(e.Data) && e.Data.Contains("[SECURITY]") && e.Data.Contains("Password: "))
                    {
                        firstRunPassword = e.Data.Substring(e.Data.IndexOf("Password: ") + 10).Trim();
                    }
                };
                serverProcess.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) {
                    if (!string.IsNullOrEmpty(e.Data)) AddLog("ERROR: " + FilterEngineLine(e.Data));
                };

                // Notice when the engine dies on its own; the badge used to keep
                // saying "Running" after a crash.
                serverProcess.EnableRaisingEvents = true;
                Process startedProcess = serverProcess;
                serverProcess.Exited += delegate(object s, EventArgs e) {
                    if (this.IsDisposed) return;
                    try {
                        this.BeginInvoke(new Action(delegate {
                            if (serverProcess == startedProcess && !stoppingByUser)
                            {
                                AddLog("The server engine stopped unexpectedly. See the messages above.");
                                serverProcess = null;
                                SetStoppedUi();
                            }
                        }));
                    } catch { }
                };

                serverProcess.Start();
                serverProcess.BeginOutputReadLine();
                serverProcess.BeginErrorReadLine();

                // Give the engine time to bind the port, then check the real state.
                // System.Threading.Thread.Sleep(1800);
                // Sleeping on the UI thread froze the window (and its log) for
                // two seconds; a timer checks the state without blocking.
                btnStart.Enabled = false;
                btnStart.Text = "Starting...";
                Timer startCheck = new Timer();
                startCheck.Interval = 1800;
                startCheck.Tick += delegate(object s, EventArgs e) {
                    startCheck.Stop();
                    startCheck.Dispose();
                    btnStart.Enabled = true;
                    if (startedProcess != serverProcess) return;
                    if (startedProcess.HasExited)
                    {
                        serverProcess = null;
                        btnStart.Text = "Start Server";
                        AddLog("Server failed to start. See the error above.");
                        return;
                    }
                    SetRunningUi(port);
                };
                startCheck.Start();
            }
            catch (Exception ex)
            {
                btnStart.Enabled = true;
                btnStart.Text = "Start Server";
                AddLog("Exception starting server: " + ex.Message);
            }
        }

        private string firstRunPassword = null;
        private bool stoppingByUser = false;

        private void SetRunningUi(string port)
        {
            {
                btnStart.Text = "Stop Server";
                if (btnStartIcon != null) btnStartIcon.Text = "\uE71A";
                btnStart.BackColor = Color.FromArgb(220, 38, 38);
                lblStatus.Text = string.Format("\u25CF Running ({0})", port);
                lblStatus.BackColor = Color.FromArgb(209, 250, 229);
                lblStatus.ForeColor = Color.FromArgb(5, 150, 105);
                btnOpen.Enabled = true;
                txtFolder.Enabled = false;
                txtPort.Enabled = false;
                btnBrowse.Enabled = false;

                string scheme = (chkHttps != null && chkHttps.Checked) ? "https" : "http";
                AddLog(string.Format("Rx Cloude ONLINE! Open: {0}://localhost:{1}", scheme, port));
                // AddLog("Login: use the administrator password configured on first run.");
                AddLog(string.Format("LAN clients: {0}://<this-pc-ip>:{1}", scheme, port));
                trayIcon.Text = "Rx Cloude - running on port " + port;

                if (!string.IsNullOrEmpty(firstRunPassword))
                {
                    string pass = firstRunPassword;
                    firstRunPassword = null;
                    try { Clipboard.SetText(pass); } catch { }
                    MessageBox.Show(this,
                        "First run on this computer - an admin account was created.\r\n\r\n" +
                        "Username:  admin\r\nPassword:  " + pass + "\r\n\r\n" +
                        "The password was copied to the clipboard and is also saved in data\\FIRST-LOGIN.txt.\r\n" +
                        "You will choose your own password after signing in.",
                        "Rx Cloude - first login", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
        }

        private void SetStoppedUi()
        {
            btnStart.Enabled = true;
            btnStart.Text = "Start Server";
            if (btnStartIcon != null) btnStartIcon.Text = "\uE768";
            btnStart.BackColor = Color.FromArgb(37, 99, 235);
            lblStatus.Text = "\u25CF Stopped";
            lblStatus.BackColor = Color.FromArgb(254, 226, 226);
            lblStatus.ForeColor = Color.FromArgb(220, 38, 38);
            btnOpen.Enabled = false;
            txtFolder.Enabled = true;
            txtPort.Enabled = true;
            btnBrowse.Enabled = true;
            trayIcon.Text = "Rx Cloude Server (stopped)";
        }

        private void StopServer()
        {
            if (serverProcess != null)
            {
                stoppingByUser = true;
                try
                {
                    if (!serverProcess.HasExited)
                    {
                        serverProcess.Kill();
                        serverProcess.WaitForExit(3000);
                    }
                }
                catch { }
                serverProcess = null;
                stoppingByUser = false;
            }
            if (this.IsDisposed || btnStart.IsDisposed) return;
            btnStart.Enabled = true;

            btnStart.Text = "Start Server";
                if (btnStartIcon != null) btnStartIcon.Text = "\uE768";
            btnStart.BackColor = Color.FromArgb(37, 99, 235);
            lblStatus.Text = "\u25CF Stopped";
            lblStatus.BackColor = Color.FromArgb(254, 226, 226);
            lblStatus.ForeColor = Color.FromArgb(220, 38, 38);
            btnOpen.Enabled = false;
            txtFolder.Enabled = true;
            txtPort.Enabled = true;
            btnBrowse.Enabled = true;
            AddLog("Server stopped.");
        }

        // Reads and validates the port field, falling back to 8080.
        private string CurrentPort()
        {
            string port = txtPort.Text.Trim().Trim('"');
            if (string.IsNullOrEmpty(port)) return "8080";
            int parsed;
            if (!int.TryParse(port, out parsed) || parsed < 1 || parsed > 65535) return "8080";
            return port;
        }

        private void BtnOpen_Click(object sender, EventArgs e)
        {
            string port = CurrentPort();
            string scheme = (chkHttps != null && chkHttps.Checked) ? "https" : "http";
            try
            {
                // UseShellExecute lets the default browser handle the self-signed
                // certificate prompt for https.
                Process.Start(new ProcessStartInfo(string.Format("{0}://localhost:{1}", scheme, port)) { UseShellExecute = true });
                AddLog(string.Format("Opened {0}://localhost:{1} in your browser.", scheme, port));
            }
            catch (Exception ex)
            {
                AddLog("Could not open the browser: " + ex.Message);
                AddLog(string.Format("Open this address manually: {0}://localhost:{1}", scheme, port));
            }
        }
    }
}
