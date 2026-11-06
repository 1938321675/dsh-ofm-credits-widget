# OFM 积分悬浮窗 —— 每 60 秒刷新
# 浅色主题；每次刷新统计各渠道积分消耗量并按消耗排序（活跃在前）；
# ⚙ 设置可按渠道隐藏显示。配置/状态/位置存 ~/.dsh/ofm-widget/（各副本共用）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Win32：最小化检测 / 设置 owner 窗口 / 取窗口矩形（贴合 DSH 用）
if (-not ('DshWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct WRECT { public int Left, Top, Right, Bottom; }
public static class DshWin32 {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WRECT rect);
  // GWL_HWNDPARENT(-8)：设为另一窗口的 owned window
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
}
'@
}

# WinForms 线程异常兜底：写日志而非弹 .NET 崩溃对话框
$script:widgetLog = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'widget-error.log'
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({
  param($s, $e)
  try {
    ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss,fff') + ' ThreadException: ' + $e.Exception) | Add-Content -Path $script:widgetLog -Encoding UTF8
    $e.Handle()
  } catch { }
})

# ── 单实例 ────────────────────────────────────────────────────────────────────
$mutex = New-Object System.Threading.Mutex($false, 'Local\OFM-CreditsWidget')
if (-not $mutex.WaitOne(0)) { exit 0 }

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$queryScript = Join-Path $dir 'credits-query.mjs'

# 共享数据目录：配置、上次余额、窗口位置（插件版与独立版同一份）
$dataDir = Join-Path $env:USERPROFILE '.dsh\ofm-widget'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
$posFile = Join-Path $dataDir 'widget-pos.json'
$cfgFile = Join-Path $dataDir 'widget-config.json'
$stateFile = Join-Path $dataDir 'widget-state.json'

# 自报 PID 给宿主插件（插件 dispose 时按 PID 精确杀窗口）
try {
  $PID | Set-Content -Path (Join-Path (Split-Path -Parent $dir) 'widget-pid.txt') -Encoding ASCII
  $PID | Set-Content -Path (Join-Path $dataDir 'widget-pid.txt') -Encoding ASCII
} catch { }

# ── 配置：隐藏渠道 ────────────────────────────────────────────────────────────
$script:hidden = @()
try {
  if (Test-Path $cfgFile) {
    $cfg = (Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8) | ConvertFrom-Json
    $script:hidden = @($cfg.hidden)
  }
} catch { }

# ── 状态：上次余额（消耗量 = 上次 - 本次） ────────────────────────────────────
$script:prev = @{}
try {
  if (Test-Path $stateFile) {
    $st = (Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8) | ConvertFrom-Json
    foreach ($prop in $st.totals.PSObject.Properties) { $script:prev[$prop.Name] = [double]$prop.Value }
  }
} catch { }

[System.Windows.Forms.Application]::EnableVisualStyles()

# ── 浅色主题配色 ──────────────────────────────────────────────────────────────
$cBack = [System.Drawing.Color]::FromArgb(250, 250, 252)
$cBar = [System.Drawing.Color]::FromArgb(235, 238, 244)
$cBorder = [System.Drawing.Color]::FromArgb(206, 212, 222)
$cName = [System.Drawing.Color]::FromArgb(55, 62, 74)
$cGreen = [System.Drawing.Color]::FromArgb(22, 128, 72)
$cYellow = [System.Drawing.Color]::FromArgb(176, 122, 12)
$cRed = [System.Drawing.Color]::FromArgb(198, 54, 54)
$cGray = [System.Drawing.Color]::FromArgb(150, 156, 168)
$cOrange = [System.Drawing.Color]::FromArgb(204, 116, 28)
$rowFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$boldFont = New-Object System.Drawing.Font('Consolas', 9.5, [System.Drawing.FontStyle]::Bold)
$deltaFont = New-Object System.Drawing.Font('Consolas', 8.5)

# ── 窗口 ──────────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = 'OFM 积分'
$form.FormBorderStyle = 'None'
# 作为 DSH 的 owned window：不进任务栏，也不抢占其他应用的顶层
$form.ShowInTaskbar = $false
$form.MinimizeBox = $false
$form.Topmost = $false
$form.BackColor = $cBack
$form.Size = New-Object System.Drawing.Size(256, 320)
$form.StartPosition = 'Manual'

# 位置以"距 DSH 窗口右下角的偏移"持久化（相对定位才能跟随 DSH 移动）
$script:relRight = 16
$script:relBottom = 16
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$left = $wa.Right - $form.Width - 16
$top = $wa.Bottom - $form.Height - 16
try {
  if (Test-Path $posFile) {
    $p = (Get-Content $posFile -Raw -Encoding UTF8) | ConvertFrom-Json
    # 兼容旧格式（绝对 left/top）与新的相对格式
    if ($null -ne $p.relRight -and $null -ne $p.relBottom) {
      $script:relRight = [int]$p.relRight
      $script:relBottom = [int]$p.relBottom
    } elseif ($null -ne $p.left -and $null -ne $p.top) {
      $left = [int]$p.left; $top = [int]$p.top
    }
  }
} catch { }
$form.Location = New-Object System.Drawing.Point($left, $top)

# ── 标题栏 ────────────────────────────────────────────────────────────────────
$titleBar = New-Object System.Windows.Forms.Panel
$titleBar.Dock = 'Top'; $titleBar.Height = 28
$titleBar.BackColor = $cBar
$form.Controls.Add($titleBar)

$titleLbl = New-Object System.Windows.Forms.Label
$titleLbl.Text = 'OFM 积分'
$titleLbl.ForeColor = [System.Drawing.Color]::FromArgb(40, 46, 58)
$titleLbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$titleLbl.AutoSize = $true; $titleLbl.Location = New-Object System.Drawing.Point(8, 5)
$titleBar.Controls.Add($titleLbl)

$btnGear = New-Object System.Windows.Forms.Label
$btnGear.Text = '⚙'; $btnGear.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132)
$btnGear.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$btnGear.AutoSize = $true; $btnGear.Location = New-Object System.Drawing.Point(172, 4)
$btnGear.Cursor = 'Hand'
$btnGear.Add_MouseEnter({ $btnGear.ForeColor = [System.Drawing.Color]::FromArgb(40, 90, 180) })
$btnGear.Add_MouseLeave({ $btnGear.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132) })
$btnGear.Add_Click({ Open-Settings })
$titleBar.Controls.Add($btnGear)

$btnMin = New-Object System.Windows.Forms.Label
$btnMin.Text = '▁'; $btnMin.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132)
$btnMin.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$btnMin.AutoSize = $true; $btnMin.Location = New-Object System.Drawing.Point(202, 6)
$btnMin.Cursor = 'Hand'
$btnMin.Add_MouseEnter({ $btnMin.ForeColor = [System.Drawing.Color]::FromArgb(40, 46, 58) })
$btnMin.Add_MouseLeave({ $btnMin.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132) })
$btnMin.Add_Click({ $form.WindowState = 'Minimized' })
$titleBar.Controls.Add($btnMin)

$btnClose = New-Object System.Windows.Forms.Label
$btnClose.Text = '✕'; $btnClose.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132)
$btnClose.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$btnClose.AutoSize = $true; $btnClose.Location = New-Object System.Drawing.Point(228, 6)
$btnClose.Cursor = 'Hand'
$btnClose.Add_MouseEnter({ $btnClose.ForeColor = [System.Drawing.Color]::FromArgb(198, 54, 54) })
$btnClose.Add_MouseLeave({ $btnClose.ForeColor = [System.Drawing.Color]::FromArgb(110, 118, 132) })
$btnClose.Add_Click({ $form.Close() })
$titleBar.Controls.Add($btnClose)

# ── 状态栏与内容区 ────────────────────────────────────────────────────────────
$statusLbl = New-Object System.Windows.Forms.Label
$statusLbl.Dock = 'Bottom'; $statusLbl.Height = 20
$statusLbl.ForeColor = $cGray
$statusLbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 7.5)
$statusLbl.TextAlign = 'MiddleCenter'
$statusLbl.Text = '启动中…'
$form.Controls.Add($statusLbl)

$body = New-Object System.Windows.Forms.TableLayoutPanel
$body.Dock = 'Fill'; $body.ColumnCount = 3; $body.BackColor = $cBack
$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 42))) | Out-Null
$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 24))) | Out-Null
$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 34))) | Out-Null
$body.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 2)
$form.Controls.Add($body)
$form.Controls.SetChildIndex($statusLbl, 0)
$form.Controls.SetChildIndex($body, 1)
$form.Controls.SetChildIndex($titleBar, 2)

# 双缓冲（受保护属性，反射开启）
$dbProp = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
$dbProp.SetValue($form, $true)
$dbProp.SetValue($body, $true)
$dbProp.SetValue($titleBar, $true)

# 1px 边框（FormBorderStyle None 时手绘）
$form.Add_Paint({
  param($s, $e)
  $pen = New-Object System.Drawing.Pen($cBorder)
  $rect = New-Object System.Drawing.Rectangle(0, 0, ($form.Width - 1), ($form.Height - 1))
  $e.DrawRectangle($pen, $rect)
  $pen.Dispose()
})

$toolTip = New-Object System.Windows.Forms.ToolTip
$toolTip.AutoPopDelay = 12000; $toolTip.InitialDelay = 300; $toolTip.ReshowDelay = 200

# ── 格式化 ────────────────────────────────────────────────────────────────────
function Format-Compact($t, $unit) {
  if ($unit -eq 'USD') { return ('$' + ('{0:N2}' -f $t)) }
  if ($unit -eq 'tokens') {
    if ([Math]::Abs($t) -ge 1e6) { return ('{0:N1}M' -f ($t / 1e6)) }
    if ([Math]::Abs($t) -ge 1000) { return ('{0:N1}K' -f ($t / 1000)) }
    return ('{0:N0}' -f $t)
  }
  if ([Math]::Abs($t) -ge 10000) { return ('{0:N1}K' -f ($t / 1000)) }
  return ('{0:N0}' -f $t)
}
function Format-Total($row) {
  if ($null -eq $row.total) { return '—' }
  return Format-Compact ([double]$row.total) $row.unit
}
function Format-Delta($row) {
  $c = [double]$row.consumed
  if ($c -eq 0) { return '·' }
  if ($c -gt 0) { return ('-' + (Format-Compact $c $row.unit)) }
  return ('+' + (Format-Compact ([Math]::Abs($c)) $row.unit))
}
function Get-RowColor($row) {
  if ($null -eq $row.total) { return $cGray }
  $t = [double]$row.total
  $warn = if ($row.unit -eq 'tokens') { 100000 } elseif ($row.unit -eq 'USD') { 0.5 } else { 500 }
  if ($t -le 0) { return $cRed }
  if ($t -lt $warn) { return $cYellow }
  return $cGreen
}
function Get-DeltaColor($row) {
  $c = [double]$row.consumed
  if ($c -gt 0) { return $cOrange }
  if ($c -lt 0) { return $cGreen }
  return [System.Drawing.Color]::FromArgb(200, 204, 212)
}

# ── 拖动（限制在 DSH 窗口范围内；松手记录相对偏移） ──────────────────────────
$script:dragPos = $null
function Attach-Drag($ctrl) {
  $ctrl.Add_MouseDown({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $script:dragPos = $e.Location } })
  $ctrl.Add_MouseMove({ param($s, $e)
    if ($script:dragPos -and $e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $nx = $form.Location.X + $e.X - $script:dragPos.X
      $ny = $form.Location.Y + $e.Y - $script:dragPos.Y
      # 钳制在 DSH 矩形内
      $rect = New-Object WRECT
      if ($script:dshHwnd -ne [IntPtr]::Zero -and [DshWin32]::GetWindowRect($script:dshHwnd, [ref]$rect)) {
        $nx = [Math]::Max($rect.Left, [Math]::Min($nx, $rect.Right - $form.Width))
        $ny = [Math]::Max($rect.Top, [Math]::Min($ny, $rect.Bottom - $form.Height))
      }
      $form.Location = New-Object System.Drawing.Point($nx, $ny)
    }
  })
  $ctrl.Add_MouseUp({
    $script:dragPos = $null
    Save-Relative-Position
  })
}
Attach-Drag $form
Attach-Drag $titleBar
Attach-Drag $titleLbl

# ── 渲染（就地更新防闪烁；活跃渠道排前） ─────────────────────────────────────
$script:rowsRef = @()
$script:nameCells = @()
$script:deltaCells = @()
$script:valCells = @()

function Get-VisibleRows {
  $rows = $script:rowsRef | Where-Object { -not ($script:hidden -contains $_.provider) }
  return @($rows | Sort-Object -Property @{Expression = { if ([double]$_.consumed -gt 0) { 0 } else { 1 } }}, @{Expression = { $_.label }})
}

function New-RowCells($count) {
  $body.SuspendLayout()
  $body.Controls.Clear()
  while ($body.RowCount -gt 0) { $body.RowStyles.Clear(); $body.RowCount = 0 }
  $script:nameCells = @(); $script:deltaCells = @(); $script:valCells = @()
  for ($i = 0; $i -lt $count; $i++) {
    $body.RowCount += 1
    $body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 24))) | Out-Null
    $nameLbl = New-Object System.Windows.Forms.Label
    $nameLbl.ForeColor = $cName; $nameLbl.Font = $rowFont
    $nameLbl.Dock = 'Fill'; $nameLbl.TextAlign = 'MiddleLeft'
    $deltaLbl = New-Object System.Windows.Forms.Label
    $deltaLbl.Font = $deltaFont
    $deltaLbl.Dock = 'Fill'; $deltaLbl.TextAlign = 'MiddleRight'
    $valLbl = New-Object System.Windows.Forms.Label
    $valLbl.Font = $boldFont
    $valLbl.Dock = 'Fill'; $valLbl.TextAlign = 'MiddleRight'
    Attach-Drag $nameLbl; Attach-Drag $deltaLbl; Attach-Drag $valLbl
    $body.Controls.Add($nameLbl, 0, $i)
    $body.Controls.Add($deltaLbl, 1, $i)
    $body.Controls.Add($valLbl, 2, $i)
    $script:nameCells += $nameLbl; $script:deltaCells += $deltaLbl; $script:valCells += $valLbl
  }
  $body.ResumeLayout($true)
}

function Update-Body {
  $rows = Get-VisibleRows
  $rebuild = ($rows.Count -ne $script:nameCells.Count)
  if ($rebuild) { New-RowCells $rows.Count }
  # 高度随行数自适应
  $wantH = 28 + 24 * [Math]::Max($rows.Count, 1) + 26
  if ($form.Height -ne $wantH) { $form.Height = $wantH }
  $body.SuspendLayout()
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    $nameLbl = $script:nameCells[$i]
    $deltaLbl = $script:deltaCells[$i]
    $valLbl = $script:valCells[$i]
    if ($nameLbl.Text -cne $r.label) { $nameLbl.Text = $r.label }
    $dText = Format-Delta $r
    if ($deltaLbl.Text -cne $dText) { $deltaLbl.Text = $dText }
    $dColor = Get-DeltaColor $r
    if ($deltaLbl.ForeColor.Name -ne $dColor.Name) { $deltaLbl.ForeColor = $dColor }
    if ($null -eq $r.total) { $newText = '查询失败'; $newColor = $cGray }
    else { $newText = Format-Total $r; $newColor = Get-RowColor $r }
    if ($valLbl.Text -cne $newText) { $valLbl.Text = $newText }
    if ($valLbl.ForeColor.Name -ne $newColor.Name) { $valLbl.ForeColor = $newColor }
    $tip = $r.account
    if ($r.packages) { $tip += "`n" + (($r.packages | ForEach-Object { '{0}: {1:N0}' -f $_.name, $_.remaining }) -join "`n") }
    if ($r.error) { $tip += "`n" + $r.error }
    if ($toolTip.GetToolTip($nameLbl) -cne $tip) {
      $toolTip.SetToolTip($nameLbl, $tip); $toolTip.SetToolTip($deltaLbl, $tip); $toolTip.SetToolTip($valLbl, $tip)
    }
  }
  $body.ResumeLayout($true)
  # 关键：$form.Height 调整与行重建都发生在挂起期间，百分比列宽是按旧
  # 面板尺寸算的，数字列会被裁掉半截（最小化恢复才重算）。显式重算一次。
  $body.PerformLayout()
  $form.PerformLayout()
  # 高度变了要重新钳制回 DSH 矩形内（否则变高后底部会溢出）
  try { Sync-With-Dsh } catch { }
}

# ── 设置对话框（勾选要显示的渠道） ────────────────────────────────────────────
function Open-Settings {
  if (-not $script:rowsRef.Count) { $statusLbl.Text = '等首次刷新完成后再设置'; return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '显示设置'
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false
  $dlg.ShowInTaskbar = $false
  $dlg.TopMost = $true
  $dlg.BackColor = $cBack
  $dlg.Size = New-Object System.Drawing.Size(240, 340)
  $dlg.StartPosition = 'CenterScreen'

  $tipLbl = New-Object System.Windows.Forms.Label
  $tipLbl.Text = '勾选要显示的渠道：'
  $tipLbl.ForeColor = $cName; $tipLbl.Font = $rowFont
  $tipLbl.Location = New-Object System.Drawing.Point(10, 8)
  $tipLbl.AutoSize = $true
  $dlg.Controls.Add($tipLbl)

  $lst = New-Object System.Windows.Forms.CheckedListBox
  $lst.Location = New-Object System.Drawing.Point(10, 30)
  $lst.Size = New-Object System.Drawing.Size(210, 236)
  $lst.Font = $rowFont
  $lst.IntegralHeight = $false
  $providers = @()
  foreach ($r in ($script:rowsRef | Sort-Object -Property label)) {
    $providers += $r.provider
    [void]$lst.Items.Add($r.label, (-not ($script:hidden -contains $r.provider)))
  }
  $dlg.Controls.Add($lst)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = '保存'; $btnOk.Location = New-Object System.Drawing.Point(44, 274)
  $btnOk.Size = New-Object System.Drawing.Size(75, 26); $btnOk.Font = $rowFont
  $btnOk.Add_Click({
    $newHidden = @()
    for ($i = 0; $i -lt $lst.Items.Count; $i++) {
      if (-not $lst.GetItemChecked($i)) { $newHidden += $providers[$i] }
    }
    $script:hidden = @($newHidden)
    try { (@{ hidden = @($script:hidden) } | ConvertTo-Json) | Set-Content -Path $cfgFile -Encoding UTF8 } catch { }
    Update-Body
    $dlg.Close()
  })
  $dlg.Controls.Add($btnOk)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'; $btnCancel.Location = New-Object System.Drawing.Point(125, 274)
  $btnCancel.Size = New-Object System.Drawing.Size(75, 26); $btnCancel.Font = $rowFont
  $btnCancel.Add_Click({ $dlg.Close() })
  $dlg.Controls.Add($btnCancel)

  [void]$dlg.ShowDialog($form)
}

# ── 查询（node 子进程 + UI 定时器轮询；不用事件回调，见记忆教训） ─────────────
$script:proc = $null
$script:readTask = $null

function Start-Query {
  if ($script:proc -and -not $script:proc.HasExited) { return }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node.exe).Source
    $psi.Arguments = '"' + $queryScript + '"'
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $script:readTask = $p.StandardOutput.ReadToEndAsync()
    $script:errTask = $p.StandardError.ReadToEndAsync()
    $script:proc = $p
    $statusLbl.Text = '查询中…'
  } catch {
    $statusLbl.Text = '启动查询失败：' + $_.Exception.Message
  }
}

function Poll-Result {
  $p = $script:proc
  if (-not $p) { return }
  if (-not $p.HasExited) { return }
  $script:proc = $null
  try {
    $null = $script:readTask.Wait(8000)
    $json = $script:readTask.Result
    if ([string]::IsNullOrWhiteSpace($json)) { throw '输出为空' }
    $data = $json | ConvertFrom-Json
    if ($null -eq $data.rows) { throw '返回无 rows' }
    # 消耗量 = 上次余额 - 本次余额（正=消耗，负=充值/签到）
    $newPrev = @{}
    foreach ($r in $data.rows) {
      $cur = $r.total
      if ($null -ne $cur) {
        $curD = [double]$cur
        if ($script:prev.ContainsKey($r.provider)) { $r | Add-Member -NotePropertyName consumed -NotePropertyValue ($script:prev[$r.provider] - $curD) -Force }
        else { $r | Add-Member -NotePropertyName consumed -NotePropertyValue 0 -Force }
        $newPrev[$r.provider] = $curD
      } else {
        $r | Add-Member -NotePropertyName consumed -NotePropertyValue 0 -Force
        if ($script:prev.ContainsKey($r.provider)) { $newPrev[$r.provider] = $script:prev[$r.provider] }
      }
    }
    $script:prev = $newPrev
    try {
      (@{ totals = $newPrev } | ConvertTo-Json -Depth 4) | Set-Content -Path $stateFile -Encoding UTF8
    } catch { }
    $script:rowsRef = @($data.rows)
    Update-Body
    $at = [DateTime]::Parse($data.at).ToLocalTime()
    $errs = @($script:rowsRef | Where-Object { $null -eq $_.total }).Count
    $statusLbl.Text = ('{0:HH:mm:ss} 已刷新' -f $at) + $(if ($errs) { "（$errs 个失败）" } else { '' })
  } catch {
    $statusLbl.Text = '刷新失败：' + $_.Exception.Message
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({ Start-Query })
$timer.Start()

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 1500
$pollTimer.Add_Tick({ Poll-Result })
$pollTimer.Start()

# ── 托盘 ──────────────────────────────────────────────────────────────────────
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = 'OFM 积分悬浮窗'
$tray.Visible = $true
$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$trayMenu.Items.Add('显示/隐藏')
[void]$trayMenu.Items.Add('立即刷新')
[void]$trayMenu.Items.Add('设置…')
[void]$trayMenu.Items.Add('退出')
$tray.ContextMenuStrip = $trayMenu
$tray.Add_MouseDoubleClick({
  # 手动唤出：清掉自动隐藏标记，DSH 恢复时不再自动弹（用户已自己管了）
  $script:autoHidden = $false
  $form.WindowState = 'Normal'; $form.Show(); $form.Activate()
})
$trayMenu.Add_ItemClicked({
  param($s, $e)
  switch ($e.ClickedItem.Text) {
    '退出' { $form.Close() }
    '立即刷新' { Start-Query }
    '设置…' { Open-Settings }
    default {
      if ($form.Visible) {
        $form.Hide(); $script:autoHidden = $false   # 手动隐藏：DSH 恢复时保持隐藏
      } else {
        $script:autoHidden = $false
        $form.WindowState = 'Normal'; $form.Show(); $form.Activate()
      }
    }
  }
})

# ── 跟随 DSH：owner 绑定 + 相对偏移 + 矩形内钳制 ──────────────────────────────
# 设为 DSH 的 owned window 后，本窗永远压在 DSH 之上、DSH 最小化时系统自动
# 收起它、别处点击时不会跑到 DSH 前面去。位置靠 2 秒一次的相对偏移同步来
# 跟随 DSH 移动，并强制落在 DSH 窗口矩形内。
$script:autoHidden = $false
$script:dshWasMinimized = $false
$script:dshHwnd = [IntPtr]::Zero
$script:ownerBound = $false
$GWL_HWNDPARENT = -8

function Get-DshHwnd {
  # 每次现找：DSH 重启换 PID、hwnd 失效都能自愈
  try {
    $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) { return $proc.MainWindowHandle }
  } catch { }
  return [IntPtr]::Zero
}

function Save-Relative-Position {
  if ($script:dshHwnd -eq [IntPtr]::Zero) { return }
  $rect = New-Object WRECT
  if (-not [DshWin32]::GetWindowRect($script:dshHwnd, [ref]$rect)) { return }
  $script:relRight = $rect.Right - $form.Location.X - $form.Width
  $script:relBottom = $rect.Bottom - $form.Location.Y - $form.Height
  try {
    (@{ relRight = $script:relRight; relBottom = $script:relBottom } | ConvertTo-Json) |
      Set-Content -Path $posFile -Encoding UTF8
  } catch { }
}

function Sync-With-Dsh {
  if ($script:dshHwnd -eq [IntPtr]::Zero -or -not [DshWin32]::IsWindowVisible($script:dshHwnd)) {
    $script:dshHwnd = Get-DshHwnd
    $script:ownerBound = $false
  }
  if ($script:dshHwnd -eq [IntPtr]::Zero) { return }   # DSH 没在跑：不联动

  # owner 绑定：让本窗始终压在 DSH 之上、随 DSH 最小化/恢复。
  # 注意：owned window 不进 EnumWindows 顶层列表，外部工具看不到它是正常的。
  if (-not $script:ownerBound -and $form.Visible) {
    try {
      [void][DshWin32]::SetWindowLongPtr($form.Handle, $GWL_HWNDPARENT, $script:dshHwnd)
      $script:ownerBound = $true
    } catch { }
  }

  $min = [DshWin32]::IsIconic($script:dshHwnd)
  if ($min -and -not $script:dshWasMinimized) {
    if ($form.Visible) { $form.Hide(); $script:autoHidden = $true }
  } elseif (-not $min -and $script:dshWasMinimized) {
    if ($script:autoHidden) {
      $script:autoHidden = $false
      $form.WindowState = 'Normal'; $form.Show()
    }
    $script:ownerBound = $false   # 重新 Show 后句柄关系重绑
  }
  $script:dshWasMinimized = $min
  if ($min) { return }

  # 跟随 + 钳制（拖动过程中不打扰）
  if ($script:dragPos) { return }
  $rect = New-Object WRECT
  if (-not [DshWin32]::GetWindowRect($script:dshHwnd, [ref]$rect)) { return }
  # 窗口比 DSH 还大时（DSH 被缩到极窄），就贴左上角
  $maxX = $rect.Right - $form.Width
  $maxY = $rect.Bottom - $form.Height
  if ($maxX -lt $rect.Left) { $maxX = $rect.Left }
  if ($maxY -lt $rect.Top) { $maxY = $rect.Top }
  $wantX = $rect.Right - $form.Width - $script:relRight
  $wantY = $rect.Bottom - $form.Height - $script:relBottom
  $wantX = [Math]::Max($rect.Left, [Math]::Min($wantX, $maxX))
  $wantY = [Math]::Max($rect.Top, [Math]::Min($wantY, $maxY))
  if ($form.Location.X -ne $wantX -or $form.Location.Y -ne $wantY) {
    $form.Location = New-Object System.Drawing.Point($wantX, $wantY)
  }
}

$dshTimer = New-Object System.Windows.Forms.Timer
$dshTimer.Interval = 2000
$dshTimer.Add_Tick({ try { Sync-With-Dsh } catch { } })
$dshTimer.Start()

# ── 关闭 ──────────────────────────────────────────────────────────────────────
$form.Add_FormClosing({
  Save-Relative-Position
  $timer.Stop(); $pollTimer.Stop(); $dshTimer.Stop(); $tray.Visible = $false; $tray.Dispose()
})

$form.Add_Shown({
  Start-Query
  # 记录句柄供诊断（hwnd 文件，非必需）
  try { $form.Handle.ToInt64().ToString() | Set-Content -Path (Join-Path $dataDir 'widget-hwnd.txt') -Encoding ASCII } catch { }
  # 显示后立刻定位到 DSH 右下角（不等到第一次 2 秒 tick）
  try { Sync-With-Dsh } catch { }
})
$form.Show()

# 消息循环用 Application::Run：ShowDialog 的模态循环会在 $form.Hide() 时
# 直接返回（WinForms 对模态窗口的语义），托盘"隐藏"就变成进程退出（闪退）。
[System.Windows.Forms.Application]::Run($form)
[void]$mutex.ReleaseMutex(); $mutex.Dispose()
