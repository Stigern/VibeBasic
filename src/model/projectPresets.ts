// Runnable starting points for File > New Project. The generated code stays ordinary, editable VB.
import { newControl } from './controls';
import { shortcutValue } from './menuShortcuts';
import type { ControlDef, ControlType, Project, PropValue } from './types';

export function populatePreset(project: Project, kind: 'textEditor' | 'drawing' | 'serial', prefix: string): void {
  const form = project.forms[0];
  Object.assign(form.props, { Width: 9600, Height: 7200 });
  function add(type: Exclude<ControlType, 'Form'>, name: string, left: number, top: number, width: number, height: number,
    props: Record<string, PropValue> = {}, parent: ControlDef | null = null): ControlDef {
    const c = newControl(form, type, { left, top, width, height }, parent?.id ?? null);
    c.name = name;
    Object.assign(c.props, props);
    form.controls.push(c);
    return c;
  }
  const menu = (name: string, caption: string, parent: ControlDef | null = null, shortcut = '') =>
    add('Menu', name, 0, 0, 0, 0, { Caption: caption, Shortcut: shortcutValue(shortcut) ?? 0 }, parent);

  switch (kind) {
    case 'textEditor': {
      form.props.Caption = 'Text Editor';
      project.components = ['RICHTX32.OCX', 'COMDLG32.OCX'];
      add('RichTextBox', 'txtEditor', 120, 120, 9240, 6120, { Text: '', ScrollBars: 3 });
      add('Label', 'lblStatus', 120, 6360, 9240, 255, { Caption: 'Ready', BorderStyle: 1 });
      add('CommonDialog', 'dlgFile', 120, 120, 480, 480, {
        Filter: 'Text files (*.txt)|*.txt|All files (*.*)|*.*', DefaultExt: 'txt', CancelError: true,
      });
      const file = menu('mnuFile', '&File');
      menu('mnuNew', '&New', file, 'Ctrl+N');
      menu('mnuOpen', '&Open...', file, 'Ctrl+O');
      menu('mnuSave', '&Save', file, 'Ctrl+S');
      menu('mnuSaveAs', 'Save &As...', file);
      menu('mnuFileSep', '-', file);
      menu('mnuExit', 'E&xit', file);
      const edit = menu('mnuEdit', '&Edit');
      menu('mnuCut', 'Cu&t', edit, 'Ctrl+X');
      menu('mnuCopy', '&Copy', edit, 'Ctrl+C');
      menu('mnuPaste', '&Paste', edit, 'Ctrl+V');
      menu('mnuSelectAll', 'Select &All', edit, 'Ctrl+A');
      form.code = prefix + TEXT_EDITOR;
      break;
    }
    case 'drawing':
      form.props.Caption = 'Drawing App';
      add('Label', 'lblColor', 120, 180, 600, 255, { Caption: 'Colour:' });
      add('ComboBox', 'cboColor', 840, 120, 1800, 315, { Style: 2, Text: '' });
      add('Label', 'lblBrush', 2880, 180, 600, 255, { Caption: 'Brush:' });
      add('ComboBox', 'cboBrush', 3600, 120, 1080, 315, { Style: 2, Text: '' });
      add('CommandButton', 'cmdClear', 4920, 120, 1080, 375, { Caption: '&Clear' });
      add('PictureBox', 'picCanvas', 120, 660, 9240, 5640, { BackColor: 0xffffff, AutoRedraw: true, ScaleMode: 3 });
      add('Label', 'lblStatus', 120, 6420, 9240, 255, { Caption: 'Drag with the left mouse button to draw.' });
      form.code = prefix + DRAWING;
      break;
    case 'serial':
      form.props.Caption = 'Serial Terminal';
      project.components = ['MSCOMM32.OCX'];
      add('Label', 'lblPort', 120, 180, 600, 255, { Caption: 'Port:' });
      add('TextBox', 'txtPort', 840, 120, 3000, 315, { Text: '1' });
      add('Label', 'lblBaud', 4080, 180, 600, 255, { Caption: 'Baud:' });
      add('ComboBox', 'cboBaud', 4800, 120, 1560, 315, { Style: 2, Text: '' });
      add('CommandButton', 'cmdConnect', 6600, 120, 1560, 375, { Caption: '&Connect' });
      add('Label', 'lblHint', 120, 600, 9240, 450, { Caption: 'Port: a number (1 = first port), COM3, or a device path such as /dev/cu.usbmodem1101.' });
      add('TextBox', 'txtReceive', 120, 1140, 9240, 4440, { Text: '', MultiLine: true, ScrollBars: 3, Locked: true });
      add('TextBox', 'txtSend', 120, 5760, 7440, 375, { Text: '' });
      add('CommandButton', 'cmdSend', 7800, 5760, 1560, 375, { Caption: '&Send + CRLF', Enabled: false });
      add('Label', 'lblStatus', 120, 6360, 9240, 255, { Caption: 'Disconnected', BorderStyle: 1 });
      add('MSComm', 'MSComm1', 120, 120, 480, 480, { RThreshold: 1, InputLen: 0 });
      add('Timer', 'tmrConnection', 720, 120, 480, 480, { Interval: 250, Enabled: false });
      form.code = prefix + SERIAL;
      break;
  }
}

const TEXT_EDITOR = `Private currentFile As String
Private savedText As String

Private Sub Form_Load()
    UpdateStatus
End Sub

Private Sub Form_Resize()
    If ScaleWidth < 900 Or ScaleHeight < 900 Then Exit Sub
    txtEditor.Move 120, 120, ScaleWidth - 240, ScaleHeight - 660
    lblStatus.Move 120, ScaleHeight - 420, ScaleWidth - 240, 255
End Sub

Private Sub UpdateStatus()
    Dim title As String
    title = currentFile
    If title = "" Then title = "Untitled"
    If txtEditor.Text <> savedText Then title = title & " *"
    Me.Caption = title & " - Text Editor"
    lblStatus.Caption = CStr(Len(txtEditor.Text)) & " characters"
End Sub

Private Sub txtEditor_Change()
    UpdateStatus
End Sub

Private Function SaveDocument(ByVal chooseName As Boolean) As Boolean
    On Error GoTo Failed
    Dim path As String
    path = currentFile
    If chooseName Or path = "" Then
        dlgFile.FileName = path
        dlgFile.Flags = cdlOFNOverwritePrompt
        dlgFile.ShowSave
        path = dlgFile.FileName
        If path = "" Then Exit Function
    End If
    txtEditor.SaveFile path, rtfText
    currentFile = path
    savedText = txtEditor.Text
    UpdateStatus
    SaveDocument = True
    Exit Function
Failed:
    If Err.Number <> 32755 Then MsgBox Err.Description, vbExclamation, "Save failed"
End Function

Private Function CanDiscard() As Boolean
    Dim answer As Integer
    CanDiscard = True
    If txtEditor.Text = savedText Then Exit Function
    answer = MsgBox("Save changes before continuing?", vbYesNoCancel Or vbQuestion, "Text Editor")
    Select Case answer
        Case vbYes
            CanDiscard = SaveDocument(False)
        Case vbCancel
            CanDiscard = False
    End Select
End Function

Private Sub mnuNew_Click()
    If Not CanDiscard() Then Exit Sub
    txtEditor.Text = ""
    currentFile = ""
    savedText = ""
    UpdateStatus
End Sub

Private Sub mnuOpen_Click()
    On Error GoTo Failed
    If Not CanDiscard() Then Exit Sub
    dlgFile.FileName = ""
    dlgFile.Flags = cdlOFNFileMustExist
    dlgFile.ShowOpen
    If dlgFile.FileName = "" Then Exit Sub
    txtEditor.LoadFile dlgFile.FileName, rtfText
    currentFile = dlgFile.FileName
    savedText = txtEditor.Text
    UpdateStatus
    Exit Sub
Failed:
    If Err.Number <> 32755 Then MsgBox Err.Description, vbExclamation, "Open failed"
End Sub

Private Sub mnuSave_Click()
    SaveDocument False
End Sub

Private Sub mnuSaveAs_Click()
    SaveDocument True
End Sub

Private Sub mnuExit_Click()
    Unload Me
End Sub

Private Sub Form_QueryUnload(Cancel As Integer, UnloadMode As Integer)
    If Not CanDiscard() Then Cancel = 1
End Sub

Private Sub mnuSelectAll_Click()
    txtEditor.SelStart = 0
    txtEditor.SelLength = Len(txtEditor.Text)
End Sub

Private Sub mnuCopy_Click()
    Clipboard.Clear
    Clipboard.SetText txtEditor.SelText
End Sub

Private Sub mnuCut_Click()
    mnuCopy_Click
    txtEditor.SelText = ""
End Sub

Private Sub mnuPaste_Click()
    txtEditor.SelText = Clipboard.GetText()
End Sub
`;

const DRAWING = `Private lastX As Single
Private lastY As Single

Private Sub Form_Load()
    cboColor.AddItem "Black"
    cboColor.AddItem "Red"
    cboColor.AddItem "Green"
    cboColor.AddItem "Blue"
    cboColor.AddItem "Yellow"
    cboColor.AddItem "White (eraser)"
    cboColor.ListIndex = 0
    cboBrush.AddItem "1"
    cboBrush.AddItem "3"
    cboBrush.AddItem "5"
    cboBrush.AddItem "9"
    cboBrush.ListIndex = 0
    picCanvas.ForeColor = vbBlack
    picCanvas.DrawWidth = 1
End Sub

Private Sub Form_Resize()
    If ScaleWidth < 900 Or ScaleHeight < 1500 Then Exit Sub
    picCanvas.Move 120, 660, ScaleWidth - 240, ScaleHeight - 1200
    lblStatus.Move 120, ScaleHeight - 420, ScaleWidth - 240, 255
End Sub

Private Sub cboColor_Click()
    Select Case cboColor.ListIndex
        Case 0: picCanvas.ForeColor = vbBlack
        Case 1: picCanvas.ForeColor = vbRed
        Case 2: picCanvas.ForeColor = vbGreen
        Case 3: picCanvas.ForeColor = vbBlue
        Case 4: picCanvas.ForeColor = vbYellow
        Case 5: picCanvas.ForeColor = vbWhite
    End Select
End Sub

Private Sub cboBrush_Click()
    picCanvas.DrawWidth = Val(cboBrush.Text)
End Sub

Private Sub picCanvas_MouseDown(Button As Integer, Shift As Integer, X As Single, Y As Single)
    If Button <> 1 Then Exit Sub
    lastX = X
    lastY = Y
    picCanvas.PSet (X, Y)
End Sub

Private Sub picCanvas_MouseMove(Button As Integer, Shift As Integer, X As Single, Y As Single)
    If (Button And 1) = 0 Then Exit Sub
    picCanvas.Line (lastX, lastY)-(X, Y)
    lastX = X
    lastY = Y
End Sub

Private Sub cmdClear_Click()
    picCanvas.Cls
End Sub
`;

const SERIAL = `Private Sub Form_Load()
    cboBaud.AddItem "9600"
    cboBaud.AddItem "19200"
    cboBaud.AddItem "38400"
    cboBaud.AddItem "57600"
    cboBaud.AddItem "115200"
    cboBaud.ListIndex = 0
End Sub

Private Sub Form_Resize()
    If ScaleWidth < 2400 Or ScaleHeight < 2400 Then Exit Sub
    txtReceive.Move 120, 1140, ScaleWidth - 240, ScaleHeight - 2280
    txtSend.Move 120, ScaleHeight - 960, ScaleWidth - 1920, 375
    cmdSend.Move ScaleWidth - 1680, ScaleHeight - 960, 1560, 375
    lblStatus.Move 120, ScaleHeight - 420, ScaleWidth - 240, 255
End Sub

Private Sub UpdateConnection()
    tmrConnection.Enabled = MSComm1.PortOpen
    cmdSend.Enabled = MSComm1.PortOpen
    txtPort.Enabled = Not MSComm1.PortOpen
    cboBaud.Enabled = Not MSComm1.PortOpen
    If MSComm1.PortOpen Then
        cmdConnect.Caption = "&Disconnect"
    Else
        cmdConnect.Caption = "&Connect"
    End If
End Sub

Private Sub tmrConnection_Timer()
    ' The device can disappear without an OnComm event.
    If Not MSComm1.PortOpen Then
        lblStatus.Caption = "Disconnected: device closed or unavailable."
        UpdateConnection
    End If
End Sub

Private Sub cmdConnect_Click()
    On Error GoTo Failed
    If MSComm1.PortOpen Then
        MSComm1.PortOpen = False
        lblStatus.Caption = "Disconnected"
    Else
        If Trim(txtPort.Text) = "" Then
            lblStatus.Caption = "Enter a port number or device name."
            Exit Sub
        End If
        MSComm1.PortName = ""
        If IsNumeric(txtPort.Text) Then
            MSComm1.CommPort = CInt(txtPort.Text)
        Else
            MSComm1.PortName = Trim(txtPort.Text)
        End If
        MSComm1.Settings = cboBaud.Text & ",n,8,1"
        MSComm1.PortOpen = True
        lblStatus.Caption = "Connected: " & txtPort.Text & " at " & cboBaud.Text & " baud"
    End If
    UpdateConnection
    Exit Sub
Failed:
    lblStatus.Caption = "Connection failed: " & Err.Description
    UpdateConnection
End Sub

Private Sub cmdSend_Click()
    On Error GoTo Failed
    If Not MSComm1.PortOpen Then Exit Sub
    MSComm1.Output = txtSend.Text & vbCrLf
    txtSend.Text = ""
    Exit Sub
Failed:
    lblStatus.Caption = "Send failed: " & Err.Description
    UpdateConnection
End Sub

Private Sub MSComm1_OnComm()
    On Error GoTo Failed
    If MSComm1.CommEvent = comEvReceive Then
        ' Keep the display bounded during long sessions.
        txtReceive.Text = Right(txtReceive.Text & MSComm1.Input, 60000)
        txtReceive.SelStart = Len(txtReceive.Text)
    ElseIf MSComm1.CommEvent >= 1000 Then
        lblStatus.Caption = "Serial error: " & CStr(MSComm1.CommEvent)
    End If
    UpdateConnection
    Exit Sub
Failed:
    lblStatus.Caption = "Receive failed: " & Err.Description
    UpdateConnection
End Sub

Private Sub Form_Unload(Cancel As Integer)
    On Error Resume Next
    If MSComm1.PortOpen Then MSComm1.PortOpen = False
End Sub
`;
