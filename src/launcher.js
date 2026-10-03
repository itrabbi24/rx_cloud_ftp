const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Must run before ./server and ./db are loaded: the data layer reads
// RX_CLOUDE_ROOT at require time. See the note in server_cli.js.
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      result.port = Number(args[++i]);
    } else if (args[i] === '--dir' || args[i] === '-d') {
      result.folder = args[++i];
    } else if (args[i] === '--root' || args[i] === '-r') {
      result.root = args[++i];
    } else if (args[i] === '--auto' || args[i] === '-y' || args[i] === '--start') {
      result.auto = true;
    }
  }
  return result;
}

// Paths can arrive with surrounding quotes (copied from Explorer/PowerShell) or
// a trailing backslash; a stray quote used to end up inside the path and crash
// the data layer with ENOENT. Strip the noise before use.
function cleanPathInput(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^"+|"+$/g, '').trim().replace(/[\\/]+$/, '');
}

const cliArgs = parseArgs();
const APP_ROOT = cleanPathInput(process.env.RX_CLOUDE_ROOT)
  || cleanPathInput(cliArgs.root)
  || (process.pkg ? path.dirname(process.execPath) : process.cwd());
process.env.RX_CLOUDE_ROOT = APP_ROOT;

const ENV_FOLDER = cleanPathInput(process.env.RX_CLOUDE_DIR);
// The server speaks plain HTTP unless HTTPS was chosen; the links below were
// hardcoded to https:// and failed with ERR_EMPTY_RESPONSE / SSL errors.
const SCHEME = String(process.env.RX_CLOUDE_SCHEME || 'http').toLowerCase() === 'https' ? 'https' : 'http';

const { startServer, isRunning, getNetworkIPs } = require('./server');
const { getConfig, saveConfig } = require('./db');

// Function to open folder picker using Windows PowerShell
function pickFolderWithDialog() {
  return new Promise((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select Folder for Rx Cloude"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Host -NoNewline $dialog.SelectedPath
}
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) {
        return resolve(null);
      }
      resolve(stdout.trim());
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`);
    }
  } catch (e) {}
}

async function runInteractive(cfg, defaultPort, defaultFolder) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question, defaultValue) => {
    return new Promise((resolve) => {
      rl.question(`${question} [Default: ${defaultValue}]: `, (answer) => {
        const trimmed = answer.trim();
        resolve(trimmed ? trimmed : defaultValue);
      });
    });
  };

  console.clear();
  console.log(`=============================================================`);
  console.log(`☁️   Rx Cloude - Portable Server`);
  console.log(`👨‍💻  Developed by: ARG RABBI`);
  console.log(`=============================================================\n`);

  // 1. Ask Port
  const portInput = await ask(`👉 1. Enter Port`, defaultPort);
  const selectedPort = Number(portInput) || defaultPort;

  // 2. Ask Folder (with option to open Windows dialog)
  console.log(`\n📁 Current Default Folder: ${defaultFolder}`);
  const choice = await ask(`👉 2. Choose Folder: [Type path / 'B' to browse with file dialog / Enter for default]`, defaultFolder);

  let selectedFolder = defaultFolder;
  if (choice.toLowerCase() === 'b' || choice.toLowerCase() === 'browse') {
    console.log(`   ⏳ Opening Windows Folder Selector Dialog...`);
    const picked = await pickFolderWithDialog();
    if (picked) {
      selectedFolder = picked;
      console.log(`   ✅ Selected Folder: ${selectedFolder}`);
    } else {
      console.log(`   ⚠️ No folder chosen, using default: ${defaultFolder}`);
    }
  } else if (choice) {
    selectedFolder = path.resolve(choice);
  }

  rl.close();
  return { selectedPort, selectedFolder };
}

async function main() {
  const cfg = getConfig();
  let defaultPort = Number(process.env.RX_CLOUDE_PORT) || cliArgs.port || cfg.port || 8080;
  const argFolder = cleanPathInput(cliArgs.folder);
  let defaultFolder = ENV_FOLDER || argFolder || cfg.sharedFolder || path.join(APP_ROOT, 'shared_files');

  let selectedPort = defaultPort;
  let selectedFolder = defaultFolder;

  // If arguments provided or not TTY, start immediately
  const hasCliArgs = !!(cliArgs.port || cliArgs.folder || cliArgs.auto || ENV_FOLDER);
  const isTty = process.stdin.isTTY;

  if (!hasCliArgs && isTty) {
    const answers = await runInteractive(cfg, defaultPort, defaultFolder);
    selectedPort = answers.selectedPort;
    selectedFolder = answers.selectedFolder;
  }

  // Save config
  cfg.port = selectedPort;
  cfg.sharedFolder = selectedFolder;
  saveConfig(cfg);

  console.log(`\n⏳ Starting Rx Cloude Server... Please wait...`);

  startServer(selectedPort, selectedFolder, (err, info) => {
    if (err) {
      console.error(`\n❌ Failed to start server: ${err.message}`);
      if (isTty) {
        console.log(`Press Enter to exit...`);
        const rlErr = readline.createInterface({ input: process.stdin, output: process.stdout });
        rlErr.question('', () => process.exit(1));
      } else {
        process.exit(1);
      }
      return;
    }

    console.clear();
    console.log(`=============================================================`);
    console.log(`🎉 Rx Cloude Server is ONLINE & RUNNING!`);
    console.log(`👨‍💻 Developed by: ARG RABBI`);
    console.log(`=============================================================`);
    console.log(`📁 Shared Folder: ${info.sharedFolder}`);
    console.log(`-------------------------------------------------------------`);
    // console.log(`🌐 Local URL:       https://localhost:${info.port}`);
    console.log(`🌐 Local URL:       ${SCHEME}://localhost:${info.port}`);

    if (info.ips && info.ips.length) {
      info.ips.forEach(ip => {
        console.log(`🌍 LAN/WiFi URL:    ${SCHEME}://${ip}:${info.port}`);
      });
    }

    console.log(`-------------------------------------------------------------`);
    // console.log(`🔑 Login: use the administrator password configured on first run.`);
    console.log(`🔑 Login: see the FIRST RUN lines above, or data\FIRST-LOGIN.txt on a new install.`);
    console.log(`=============================================================`);
    console.log(`💡 TIP: You can minimize this window to let it run in`);
    console.log(`   the background. Anyone on your WiFi/LAN can open the URL.`);
    console.log(`-------------------------------------------------------------`);
    console.log(`⚡ Live Activity Logs:\n`);

    // Auto-open browser once online
    if (isTty && !hasCliArgs) {
      openBrowser(`${SCHEME}://localhost:${info.port}`);
    }
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
});
