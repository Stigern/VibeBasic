Type Point
    X As Long
    Y As Long
End Type

Type Person
    Name As String
    Age As Integer
    Pos As Point
End Type

Enum Color
    Red
    Green = 5
    Blue
End Enum

Const Greeting = "Hi"
Private Const Answer As Integer = 6 * 7

Sub Main()
    Dim p As Person
    p.Name = "Ada"
    p.Age = 36
    p.Pos.X = 3
    p.Pos.Y = 4
    Debug.Print p.Name; p.Age; p.Pos.X + p.Pos.Y
    Dim q As Person
    q = p
    q.Name = "Bob"
    q.Pos.X = 100
    Debug.Print p.Name; p.Pos.X; " "; q.Name; q.Pos.X
    Debug.Print Red; Green; Blue; Color.Blue
    Dim c As Color
    c = Blue
    Debug.Print c
    Dim pts(1 To 2) As Point
    pts(1).X = 7
    Debug.Print pts(1).X; pts(2).X
    Dim tmp As Point
    tmp.Y = 9
    pts(2) = tmp
    tmp.Y = 1
    Debug.Print pts(2).Y; tmp.Y
    Debug.Print Greeting; Answer
    Const Local = 2
    Debug.Print Local * 2
    Counter
    Counter
    Counter
    Debug.Print Total(); Total(); Total()
End Sub

Sub Counter()
    Static n As Integer
    n = n + 1
    Debug.Print "call"; n
End Sub

Static Function Total() As Integer
    Dim t As Integer
    t = t + 10
    Total = t
End Function
