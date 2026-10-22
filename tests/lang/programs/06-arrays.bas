Sub Main()
    Dim a() As Integer
    Dim i As Integer
    ReDim a(1 To 3)
    For i = 1 To 3
        a(i) = i * 10
    Next
    ReDim Preserve a(1 To 5)
    a(5) = 50
    For i = LBound(a) To UBound(a)
        Debug.Print a(i);
    Next
    Debug.Print
    Debug.Print LBound(a); UBound(a)
    ReDim a(2)
    Debug.Print a(0); a(1); a(2); UBound(a)
    Dim grid(1 To 2, 1 To 3) As Long
    Dim r As Integer, c As Integer
    For r = 1 To 2
        For c = 1 To 3
            grid(r, c) = r * 10 + c
        Next
    Next
    Debug.Print grid(2, 3); UBound(grid, 1); UBound(grid, 2); LBound(grid, 2)
    Dim names(2) As String
    names(1) = "x"
    Debug.Print "[" & names(0) & names(1) & "]"; UBound(names)
    Dim b As Variant
    b = a
    b(0) = 99
    Debug.Print a(0); b(0)
    Fill a
    Debug.Print a(0); a(1); a(2)
    Debug.Print Sum(a)
    Debug.Print grid(3, 1)
    Debug.Print "not reached"
End Sub

Sub Fill(arr() As Integer)
    Dim k As Integer
    For k = LBound(arr) To UBound(arr)
        arr(k) = k + 1
    Next
End Sub

Function Sum(arr() As Integer) As Long
    Dim k As Integer
    For k = LBound(arr) To UBound(arr)
        Sum = Sum + arr(k)
    Next
End Function
