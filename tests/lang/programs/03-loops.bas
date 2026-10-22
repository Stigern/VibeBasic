Sub Main()
    Dim i As Integer, total As Long
    For i = 5 To 1 Step -1
        Debug.Print i;
    Next i
    Debug.Print
    For i = 1 To 10 Step 3
        total = total + i
    Next
    Debug.Print "total"; total; "i"; i
    i = 0
    Do Until i >= 3
        i = i + 1
    Loop
    Debug.Print "until"; i
    Do
        i = i - 1
    Loop While i > 0
    Debug.Print "loop while"; i
    Do While i < 2
        i = i + 1
    Loop
    Debug.Print "do while"; i
    Do
        i = i + 1
    Loop Until i >= 3
    Debug.Print "loop until"; i
    While i < 6
        i = i + 2
    Wend
    Debug.Print "wend"; i
    For i = 1 To 100
        If i * i > 50 Then Exit For
    Next
    Debug.Print "exit for"; i
    Dim arr(3) As String
    arr(0) = "a": arr(1) = "b": arr(2) = "c": arr(3) = "d"
    Dim item As Variant
    For Each item In arr
        Debug.Print item;
    Next
    Debug.Print
    Do
        i = i + 1
        If i = 12 Then Exit Do
    Loop
    Debug.Print "exit do"; i
    For i = 1 To 0
        Debug.Print "never"
    Next
    Debug.Print "after empty"; i
    Dim j As Integer
    For i = 1 To 2
        For j = 1 To 2
            Debug.Print i * 10 + j;
    Next j, i
    Debug.Print
    Dim x As Double
    For x = 0 To 1 Step 0.25
        Debug.Print x;
    Next
    Debug.Print
    For i = 1 To 3
        If i = 2 Then i = 10
        Debug.Print i;
    Next
    Debug.Print
End Sub
