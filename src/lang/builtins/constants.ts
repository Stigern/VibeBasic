// Built-in constants (vbCrLf, vbYes, vbRed, vbKeyA, ...). Registry keys are lower-case; the written (canonical) name goes to CANONICAL_NAMES.

import type { VBValue } from '../values';
import { CANONICAL_NAMES, CONSTANTS } from './util';

const c = (name: string, v: VBValue) => { CONSTANTS.set(name.toLowerCase(), v); CANONICAL_NAMES.set(name.toLowerCase(), name); };
const group = (values: Record<string, VBValue>) => { for (const [k, v] of Object.entries(values)) c(k, v); };

// MsgBox
group({
  vbOKOnly: 0, vbOKCancel: 1, vbAbortRetryIgnore: 2, vbYesNoCancel: 3, vbYesNo: 4, vbRetryCancel: 5,
  vbCritical: 16, vbQuestion: 32, vbExclamation: 48, vbInformation: 64,
  vbDefaultButton1: 0, vbDefaultButton2: 256, vbDefaultButton3: 512, vbDefaultButton4: 768,
  vbApplicationModal: 0, vbSystemModal: 4096,
  vbOK: 1, vbCancel: 2, vbAbort: 3, vbRetry: 4, vbIgnore: 5, vbYes: 6, vbNo: 7,
});

// Text
group({
  vbCrLf: '\r\n', vbCr: '\r', vbLf: '\n', vbNewLine: '\r\n', vbTab: '\t', vbNullString: '',
  vbBack: '\b', vbFormFeed: '\f', vbVerticalTab: '\v', vbNullChar: '\0',
});

// Colours (VB6 Long: &H00BBGGRR)
group({
  vbBlack: 0, vbRed: 0xff, vbGreen: 0xff00, vbYellow: 0xffff,
  vbBlue: 0xff0000, vbMagenta: 0xff00ff, vbCyan: 0xffff00, vbWhite: 0xffffff,
});

// Keys
group({
  vbKeyReturn: 13, vbKeyEscape: 27, vbKeySpace: 32, vbKeyBack: 8, vbKeyTab: 9,
  vbKeyLeft: 37, vbKeyUp: 38, vbKeyRight: 39, vbKeyDown: 40,
  vbKeyDelete: 46, vbKeyInsert: 45, vbKeyHome: 36, vbKeyEnd: 35, vbKeyPageUp: 33, vbKeyPageDown: 34,
  vbKeyShift: 16, vbKeyControl: 17, vbKeyMenu: 18,
});
for (let i = 0; i < 26; i++) c('vbKey' + String.fromCharCode(65 + i), 65 + i);
for (let i = 0; i < 10; i++) c('vbKey' + i, 48 + i);
for (let i = 1; i <= 12; i++) c('vbKeyF' + i, 111 + i);

// Shift masks and mouse buttons (event arguments)
group({ vbShiftMask: 1, vbCtrlMask: 2, vbAltMask: 4, vbLeftButton: 1, vbRightButton: 2, vbMiddleButton: 4 });

// CheckBox / forms / comparison
group({
  vbUnchecked: 0, vbChecked: 1, vbGrayed: 2,
  vbModal: 1, vbModeless: 0,
  vbTextCompare: 1, vbBinaryCompare: 0, vbUseCompareOption: -1,
});

// Misc
group({ vbTrue: -1, vbFalse: 0, vbObjectError: -2147221504 });

// Weekdays (Weekday, WeekdayName, DateDiff)
group({
  vbUseSystemDayOfWeek: 0, vbSunday: 1, vbMonday: 2, vbTuesday: 3, vbWednesday: 4, vbThursday: 5, vbFriday: 6, vbSaturday: 7,
});

// FormatDateTime
group({ vbGeneralDate: 0, vbLongDate: 1, vbShortDate: 2, vbLongTime: 3, vbShortTime: 4 });

// VarType
group({
  vbEmpty: 0, vbNull: 1, vbInteger: 2, vbLong: 3, vbSingle: 4, vbDouble: 5, vbCurrency: 6, vbDate: 7,
  vbString: 8, vbObject: 9, vbError: 10, vbBoolean: 11, vbVariant: 12, vbDataObject: 13, vbDecimal: 14,
  vbByte: 17, vbUserDefinedType: 36, vbArray: 8192,
});

// TreeView, ListView, MSFlexGrid
group({
  tvwFirst: 0, tvwLast: 1, tvwNext: 2, tvwPrevious: 3, tvwChild: 4, tvwTreeLines: 0, tvwRootLines: 1,
  lvwIcon: 0, lvwSmallIcon: 1, lvwList: 2, lvwReport: 3, lvwAscending: 0, lvwDescending: 1,
  lvwColumnLeft: 0, lvwColumnRight: 1, lvwColumnCenter: 2,
  flexGridNone: 0, flexGridFlat: 1, flexGridInset: 2, flexGridRaised: 3,
  flexSelectionFree: 0, flexSelectionByRow: 1, flexSelectionByColumn: 2,
  flexAlignLeftTop: 0, flexAlignLeftCenter: 1, flexAlignLeftBottom: 2, flexAlignCenterTop: 3, flexAlignCenterCenter: 4,
  flexAlignCenterBottom: 5, flexAlignRightTop: 6, flexAlignRightCenter: 7, flexAlignRightBottom: 8, flexAlignGeneral: 9,
});

// CommonDialog (Flags are stored but not used) and RichTextBox
group({
  cdlCancel: 32755,
  cdlOFNReadOnly: 0x1, cdlOFNOverwritePrompt: 0x2, cdlOFNHideReadOnly: 0x4, cdlOFNNoChangeDir: 0x8, cdlOFNAllowMultiselect: 0x200,
  cdlOFNPathMustExist: 0x800, cdlOFNFileMustExist: 0x1000, cdlOFNCreatePrompt: 0x2000, cdlOFNExplorer: 0x80000,
  cdlCCRGBInit: 0x1, cdlCCFullOpen: 0x2, cdlCCPreventFullOpen: 0x4,
  cdlCFScreenFonts: 0x1, cdlCFPrinterFonts: 0x2, cdlCFBoth: 0x3, cdlCFEffects: 0x100,
  rtfNone: 0, rtfHorizontal: 1, rtfVertical: 2, rtfBoth: 3,
});

// StatusBar / TabStrip
group({ sbrNormal: 0, sbrSimple: 1, sbrText: 0, sbrLeft: 0, sbrCenter: 1, sbrRight: 2 });

// SSTab
group({ ssStyleTabbedDialog: 0, ssStylePropertyPage: 1 });

// Toolbar (Button.Style, Button.Value, Toolbar.Style) and Align
group({
  tbrDefault: 0, tbrCheck: 1, tbrButtonGroup: 2, tbrSeparator: 3, tbrPlaceholder: 4, tbrDropdown: 5,
  tbrUnpressed: 0, tbrPressed: 1, tbrStandard: 0, tbrFlat: 1,
  vbAlignNone: 0, vbAlignTop: 1, vbAlignBottom: 2, vbAlignLeft: 3, vbAlignRight: 4,
});

// DTPicker (Format) and MonthView (StartOfWeek)
group({
  dtpLongDate: 0, dtpShortDate: 1, dtpTime: 2, dtpCustom: 3,
  mvwSunday: 1, mvwMonday: 2, mvwTuesday: 3, mvwWednesday: 4, mvwThursday: 5, mvwFriday: 6, mvwSaturday: 7,
});
