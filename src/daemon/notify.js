'use strict';

/**
 * Windows notifications from the daemon, for when no Katana window is open
 * (with one open, the window notifies, since it knows whether you're
 * looking). Shown through Windows' own toast API from PowerShell, so Focus
 * and Do Not Disturb apply as for any app. Two levels: with sound (needs
 * you, a reminder) and quiet (done). Elsewhere: nothing, for now.
 *
 * The words go in through the environment, never into the script itself.
 */

const { spawn } = require('node:child_process');

// PowerShell's own app id: a toast needs a registered app to come from.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$audio = if ($env:KATANA_SOUND -eq '1') { '<audio src="ms-winsoundevent:Notification.Default"/>' } else { '<audio silent="true"/>' }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $esc $env:KATANA_TITLE)</text><text>$(& $esc $env:KATANA_BODY)</text></binding></visual>$audio</toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Group = 'katana'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:KATANA_APP).Show($toast)
`;

const clip = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function createNotifier({ log = () => {} } = {}) {
  return function notify({ title = 'Katana', body = '', sound = false } = {}) {
    if (process.platform !== 'win32') return false;
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, KATANA_TITLE: clip(title, 80), KATANA_BODY: clip(body, 300), KATANA_SOUND: sound ? '1' : '0', KATANA_APP: APP_ID },
      });
      child.on('error', (error) => log('notify failed', error.message));
      child.unref();
      return true;
    } catch (error) {
      log('notify failed', error.message);
      return false;
    }
  };
}

module.exports = { createNotifier };
