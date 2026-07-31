# Windows 10/11 toast banner via WinRT — no modules, no dependencies.
# Called by lib/notify.mjs as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Title t -Message m
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = "Stop"
# PowerShell's own AppUserModelID — lets the toast show without registering an app.
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$escTitle = [System.Security.SecurityElement]::Escape($Title)
$escMessage = [System.Security.SecurityElement]::Escape($Message)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$escTitle</text><text>$escMessage</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
  [Windows.UI.Notifications.ToastNotification]::new($xml))
