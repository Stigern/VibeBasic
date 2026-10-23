// VB6's parameter names of the built-ins, for named arguments (`MsgBox Prompt:="Done", Title:="App"`,
// `Format(Expression:=x, Format:="0.00")`). A built-in without names here takes positional arguments only (a named
// one is error 448).

import { BUILTINS } from './util';

const NAMES: Record<string, string> = {
  MsgBox: 'Prompt Buttons Title HelpFile Context',
  InputBox: 'Prompt Title Default XPos YPos HelpFile Context',
  Format: 'Expression Format FirstDayOfWeek FirstWeekOfYear',
  'FormatNumber FormatCurrency FormatPercent': 'Expression NumDigitsAfterDecimal IncludeLeadingDigit UseParensForNegativeNumbers GroupDigits',
  FormatDateTime: 'Expression NamedFormat',
  'Mid MidB': 'String Start Length',
  'Left Right LeftB RightB': 'String Length',
  'InStr InStrB': 'Start String1 String2 Compare',
  InStrRev: 'StringCheck StringMatch Start Compare',
  StrComp: 'String1 String2 Compare',
  Replace: 'Expression Find Replace Start Count Compare',
  Split: 'Expression Delimiter Limit Compare',
  Join: 'SourceArray Delimiter',
  Filter: 'SourceArray Match Include Compare',
  StrConv: 'String Conversion LCID',
  String: 'Number Character',
  'Space Str Hex Oct Abs Sgn Int Fix Sqr Log Exp Sin Cos Tan Atn Rnd Randomize': 'Number',
  'UCase LCase Trim LTrim RTrim StrReverse Asc AscW AscB Val': 'String',
  'Chr ChrW ChrB': 'CharCode',
  'Len LenB CBool CByte CCur CDate CDbl CDec CInt CLng CSng CStr CVar IsArray IsDate IsEmpty IsError IsMissing IsNull IsNumeric IsObject': 'Expression',
  'TypeName VarType': 'VarName',
  Round: 'Number NumDigitsAfterDecimal',
  IIf: 'Expression TruePart FalsePart',
  DateAdd: 'Interval Number Date',
  DateDiff: 'Interval Date1 Date2 FirstDayOfWeek FirstWeekOfYear',
  DatePart: 'Interval Date FirstDayOfWeek FirstWeekOfYear',
  DateSerial: 'Year Month Day',
  TimeSerial: 'Hour Minute Second',
  Weekday: 'Date FirstDayOfWeek',
  MonthName: 'Month Abbreviate',
  WeekdayName: 'Weekday Abbreviate FirstDayOfWeek',
  'LBound UBound': 'Arrayname Dimension',
  Dir: 'PathName Attributes',
  GetSetting: 'AppName Section Key Default',
  SaveSetting: 'AppName Section Key Setting',
  DeleteSetting: 'AppName Section Key',
  GetAllSettings: 'AppName Section',
  LoadPicture: 'FileName Size',
  RGB: 'Red Green Blue',
  QBColor: 'Color',
  Partition: 'Number Start Stop Interval',
  FV: 'Rate NPer Pmt PV Type',
  Pmt: 'Rate NPer PV FV Type',
  PV: 'Rate NPer Pmt FV Type',
  'IPmt PPmt': 'Rate Per NPer PV FV Type',
  NPer: 'Rate Pmt PV FV Type',
  Rate: 'NPer Pmt PV FV Type Guess',
  NPV: 'Rate ValueArray',
  IRR: 'ValueArray Guess',
  MIRR: 'ValueArray FinanceRate ReinvestRate',
  DDB: 'Cost Salvage Life Period Factor',
  SLN: 'Cost Salvage Life',
  SYD: 'Cost Salvage Life Period',
  'Kill GetAttr FileLen FileDateTime': 'PathName',
  SetAttr: 'PathName Attributes',
  'MkDir RmDir ChDir': 'Path',
  FileCopy: 'Source Destination',
};

for (const [fns, params] of Object.entries(NAMES)) {
  for (const fn of fns.split(' ')) {
    const b = BUILTINS.get(fn.toLowerCase());
    if (b) b.params = params.split(' ');
  }
}
