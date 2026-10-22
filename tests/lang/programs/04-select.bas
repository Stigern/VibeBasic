Sub Main()
    Dim i As Integer
    For i = 0 To 7
        Debug.Print i; Classify(i)
    Next
    Debug.Print Grade("b")
    Debug.Print Grade("X")
    Debug.Print Grade("m")
    Dim s As String
    s = "apple"
    Select Case s
        Case "pear", "apple"
            Debug.Print "fruit"
        Case Else
            Debug.Print "other"
    End Select
    Select Case 3.5
        Case Is < 3: Debug.Print "lt3"
        Case 3 To 4: Debug.Print "3..4"
        Case Is > 3: Debug.Print "not reached"
    End Select
    Select Case True
        Case i > 100: Debug.Print "big"
        Case i = 8: Debug.Print "eight"
    End Select
    Select Case "zzz"
        Case "a"
            Debug.Print "no"
    End Select
    Debug.Print "done"
End Sub

Function Classify(n As Integer) As String
    Select Case n
        Case 0
            Classify = "zero"
        Case 1, 2
            Classify = "small"
        Case 3 To 5
            Classify = "medium"
        Case Is >= 7
            Classify = "large"
        Case Else
            Classify = "other"
    End Select
End Function

Function Grade(c As String) As String
    Select Case c
        Case "a" To "c"
            Grade = "early"
        Case "A" To "Z"
            Grade = "upper"
        Case Else
            Grade = "late"
    End Select
End Function
