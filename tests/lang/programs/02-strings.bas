Sub Main()
    Dim s As String, t As String
    s = "Hello"
    t = s & ", " & "World"
    Debug.Print t
    Debug.Print s; " "; t
    Debug.Print "abc" < "abd"
    Debug.Print "B" < "a"
    Debug.Print "abc" = "ABC"
    Debug.Print "10" + "5"
    Debug.Print 1.5 & "|" & True & "|" & -2 & "|" & 0.5
    Debug.Print "Count: " & 3
    Dim f As String * 5
    f = "ab"
    Debug.Print "[" & f & "]"
    f = "abcdefgh"
    Debug.Print "[" & f & "]"
    Debug.Print "abc" Like "a*"
    Debug.Print "abc" Like "a?d"
    Debug.Print "a5" Like "a#"; "b" Like "[a-c]"; "x" Like "[!a-c]"
    Dim v As Variant
    Debug.Print "[" & v & "]"
    v = "7"
    Debug.Print v * 2
    Debug.Print "say ""hi"""
    Dim n As Integer
    n = "12"
    Debug.Print n + 1
    s = 3.25
    Debug.Print s & "!"
    s = True
    Debug.Print s
    Debug.Print "x" + 1
    Debug.Print "not reached"
End Sub
