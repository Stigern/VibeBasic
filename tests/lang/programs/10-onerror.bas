Option Explicit

Sub Main()
    Dim x As Double
    On Error Resume Next
    x = 1 / 0
    Debug.Print "A"; Err.Number; Err.Description
    Err.Clear
    Debug.Print "B"; Err.Number
    On Error GoTo 0
    TestGoto
    Debug.Print "after goto"; Err.Number
    TestResume
    Debug.Print "D"; Divide(10, 0); Divide(10, 4)
    TestRaise
    TestBubble
    TestInHandler
    TestLoop
    TestResumeLabel
    Debug.Print "End"; 1 / 0
    Debug.Print "never"
End Sub

Sub TestGoto()
    Dim n As Integer
    On Error GoTo Handler
    n = 32767
    n = n + 1
    Debug.Print "not reached"
    Exit Sub
Handler:
    Debug.Print "C"; Err.Number; Err.Description; " "; Err.Source
End Sub

Sub TestResume()
    Dim d As Integer, tries As Integer
    On Error GoTo Fix
    Debug.Print "R"; 12 / d
    Debug.Print "tries"; tries
    Exit Sub
Fix:
    tries = tries + 1
    d = 4
    Resume
End Sub

Function Divide(a As Double, b As Double) As Variant
    On Error GoTo Bad
    Divide = a / b
    Exit Function
Bad:
    Divide = "n/a"
End Function

Sub TestRaise()
    On Error Resume Next
    Err.Raise 1000, , "Egen"
    Debug.Print "E"; Err.Number; Err.Description; " "; Err.Source
    Err.Clear
    Err.Raise 5
    Debug.Print "F"; Err.Number; Err.Description
    Err.Raise vbObjectError + 1, "MyObj", "Custom"
    Debug.Print "G"; Err.Number - vbObjectError; Err.Source; " "; Err.Description
End Sub

Sub TestBubble()
    On Error GoTo Caught
    Level2
    Debug.Print "I"; Err.Number
    Exit Sub
Caught:
    Debug.Print "H"; Err.Number; Err.Description
    Resume Next
End Sub

Sub Level2()
    Debug.Print "L2 start"
    Level3
    Debug.Print "L2 not reached"
End Sub

Sub Level3()
    Dim a(3) As Integer
    a(5) = 1
    Debug.Print "L3 not reached"
End Sub

Sub TestInHandler()
    On Error GoTo Outer
    Inner
    Exit Sub
Outer:
    Debug.Print "J"; Err.Number; Err.Description
End Sub

Sub Inner()
    On Error GoTo H
    Err.Raise 1001, , "first"
    Exit Sub
H:
    Debug.Print "K"; Err.Number
    Err.Raise 1002, , "second"
    Debug.Print "not reached"
End Sub

Sub TestLoop()
    Dim i As Integer, s As String
    On Error Resume Next
    For i = -2 To 2
        s = s & CStr(10 \ i) & ","
    Next
    Debug.Print "L"; s
End Sub

Sub TestResumeLabel()
    Dim attempt As Integer
    On Error GoTo Retry
Again:
    attempt = attempt + 1
    If attempt < 3 Then Err.Raise 2000 + attempt
    Debug.Print "M"; attempt
    Exit Sub
Retry:
    Debug.Print "N"; Err.Number
    Resume Again
End Sub
