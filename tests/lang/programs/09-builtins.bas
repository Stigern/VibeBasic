Sub Main()
    Dim s As String, a() As String, i As Integer
    Dim d As Date

    ' strings
    s = "Hello, World"
    Debug.Print Len(s); Left(s, 5); "|"; Right(s, 5); "|"; Mid(s, 8, 3); "|"; Mid(s, 8)
    Debug.Print InStr(s, "o"); InStr(6, s, "o"); InStr(s, "xyz"); InStrRev(s, "o")
    Debug.Print UCase(s); "|"; LCase(s)
    Debug.Print "[" & Trim("  pad  ") & "][" & LTrim("  pad  ") & "][" & RTrim("  pad  ") & "]"
    Debug.Print Replace(s, "l", "L"); "|"; Replace(s, "l", "L", 1, 2)
    Debug.Print "[" & Space(3) & "]"; String(4, "*"); StrReverse("abc")
    Debug.Print Asc("A"); Chr(66); Asc("ø"); Chr(230); Chr(128)
    a = Split("red,green,blue", ",")
    Debug.Print UBound(a); a(1); "|"; Join(a, " + ")
    Debug.Print StrComp("a", "B"); StrComp("a", "B", vbTextCompare)

    ' conversion
    Debug.Print Str(42); Str(-42); Str(0.5)
    Debug.Print CStr(42) & "|" & CStr(0.5) & "|" & CStr(True)
    Debug.Print Val("12abc"); Val("3,5"); Val("&HFF"); Val("abc")
    Debug.Print CInt(2.5); CInt(3.5); CInt("7"); CLng(1234.5); CDbl("2.5"); CBool(0)
    Debug.Print IsNumeric("12"); IsNumeric("1x"); IsEmpty(Empty); IsNull(Null); IsDate("2026-10-22")
    Debug.Print TypeName(1); TypeName(1.5); TypeName("s"); TypeName(True); TypeName(Null); TypeName(Empty); VarType("s")

    ' math
    Debug.Print Int(-2.5); Fix(-2.5); Abs(-3); Sgn(-7); Sqr(16)
    Debug.Print Round(2.5); Round(3.5); Round(1.2345, 2)
    Debug.Print Hex(255); Oct(8); Hex(-1)
    Debug.Print Exp(0); Log(1); Sin(0); Cos(0)
    Randomize 1
    Debug.Print Rnd < 1; Rnd >= 0

    ' dates
    d = DateSerial(2026, 10, 22) + TimeSerial(13, 5, 9)
    Debug.Print d
    Debug.Print Year(d); Month(d); Day(d); Hour(d); Minute(d); Second(d); Weekday(d)
    Debug.Print DateAdd("m", 1, DateSerial(2026, 1, 31))
    Debug.Print DateDiff("d", DateSerial(2026, 1, 1), DateSerial(2026, 12, 31))
    Debug.Print Format(d, "dddd, mmmm d, yyyy"); "|"; Format(d, "dd.mm.yyyy hh:nn:ss")
    Debug.Print Format(d, "Short Date"); "|"; Format(d, "Long Time"); "|"; Format(d, "h:nn AM/PM")
    Debug.Print MonthName(10); WeekdayName(5, True)

    ' Format
    Debug.Print Format(1234567.891, "#,##0.00"); "|"; Format(0.5, "0.00"); "|"; Format(5, "000")
    Debug.Print Format(0.256, "0%"); "|"; Format(1234.5, "Currency"); "|"; Format(-3, "0.0;(0.0)")
    Debug.Print Format(True, "Yes/No"); "|"; Format(1234.5, "Fixed"); "|"; Format(12345.678, "0.00E+00")

    ' misc
    Debug.Print RGB(255, 128, 0); QBColor(4); vbRed; vbBlue
    Debug.Print IIf(3 > 2, "yes", "no"); Choose(2, "a", "b", "c")
    Debug.Print vbYesNo + vbQuestion; vbKeyA; vbKeyReturn; vbCrLf = Chr(13) & Chr(10)
    i = MsgBox("Continue?", vbYesNo + vbQuestion, "Title")
    Debug.Print i = vbOK

    ' errors
    Debug.Print Mid(s, 0)
    Debug.Print "not reached"
End Sub
