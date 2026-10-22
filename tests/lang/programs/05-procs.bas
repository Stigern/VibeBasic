Sub Main()
    Dim a As Integer, b As Integer
    a = 1: b = 2
    Swap a, b
    Debug.Print a; b
    Debug.Print Fact(5)
    Debug.Print Twice(3)
End Sub
Sub Swap(x As Integer, y As Integer)
    Dim t As Integer
    t = x: x = y: y = t
End Sub
Function Fact(n As Integer) As Long
    If n <= 1 Then Fact = 1 Else Fact = n * Fact(n - 1)
End Function
Function Twice(ByVal n As Integer) As Integer
    n = n * 2
    Twice = n
End Function
