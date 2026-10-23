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

// File attributes (Dir, GetAttr, SetAttr)
group({ vbNormal: 0, vbReadOnly: 1, vbHidden: 2, vbSystem: 4, vbVolume: 8, vbDirectory: 16, vbArchive: 32, vbAlias: 64 });

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
  vbUpperCase: 1, vbLowerCase: 2, vbProperCase: 3, vbWide: 4, vbNarrow: 8, vbUnicode: 64, vbFromUnicode: 128,
  vbTextCompare: 1, vbBinaryCompare: 0, vbUseCompareOption: -1,
});

// Misc
group({ vbTrue: -1, vbFalse: 0, vbUseDefault: -2, vbObjectError: -2147221504 });   // vbTrue/vbFalse/vbUseDefault: Tristate

// FirstWeekOfYear (DatePart, DateDiff, Format)
group({ vbUseSystem: 0, vbFirstJan1: 1, vbFirstFourDays: 2, vbFirstFullWeek: 3 });

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

// Sheridan 3D Controls (THREED32.OCX): SSPanel Alignment
group({
  ssLeftTop: 0, ssLeftMiddle: 1, ssLeftBottom: 2, ssRightTop: 3, ssRightMiddle: 4, ssRightBottom: 5, ssCenterTop: 6, ssCenterMiddle: 7, ssCenterBottom: 8,
});

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

// MSCOMCT2.OCX: FlatScrollBar (Orientation, Appearance, Arrows), Animation (BackStyle); COMCT332.OCX: CoolBar bands
group({
  cc2OrientationVertical: 0, cc2OrientationHorizontal: 1, fsb3D: 0, fsbFlat: 1, fsbTrack3D: 2, fsbBoth: 0, fsbLeftUp: 1, fsbRightDown: 2,
  cc2BackstyleTransparent: 0, cc2BackstyleOpaque: 1, cbrDefault: 0, cbrFixedSize: 1,
});

// Inet (MSINET.OCX): StateChanged states, protocols, access types, data types
group({
  icNone: 0, icHostResolvingHost: 1, icHostResolved: 2, icConnecting: 3, icConnected: 4, icRequesting: 5, icRequestSent: 6,
  icReceivingResponse: 7, icResponseReceived: 8, icDisconnecting: 9, icDisconnected: 10, icError: 11, icResponseCompleted: 12,
  icUnknown: 0, icDefault: 1, icFTP: 2, icReserved: 3, icHTTP: 4, icHTTPS: 5,
  icUseDefault: 0, icDirect: 1, icNamedProxy: 2,
  icString: 0, icByteArray: 1,
});

// Winsock (MSWINSCK.OCX): protocols, states and error numbers
group({
  sckTCPProtocol: 0, sckUDPProtocol: 1,
  sckClosed: 0, sckOpen: 1, sckListening: 2, sckConnectionPending: 3, sckResolvingHost: 4, sckHostResolved: 5,
  sckConnecting: 6, sckConnected: 7, sckClosing: 8, sckError: 9,
  sckOutOfMemory: 7, sckInvalidPropertyValue: 380, sckGetNotSupported: 394, sckSetNotSupported: 383,
  sckBadState: 40006, sckInvalidArg: 40014, sckSuccess: 40017, sckUnsupported: 40018, sckInvalidOp: 40020, sckOutOfRange: 40021, sckWrongProtocol: 40026,
  sckOpCanceled: 10004, sckInvalidArgument: 10014, sckWouldBlock: 10035, sckInProgress: 10036, sckAlreadyComplete: 10037, sckNotSocket: 10038,
  sckMsgTooBig: 10040, sckPortNotSupported: 10043, sckAddressInUse: 10048, sckAddressNotAvailable: 10049, sckNetworkSubsystemFailed: 10050,
  sckNetworkUnreachable: 10051, sckNetReset: 10052, sckConnectAborted: 10053, sckConnectionReset: 10054, sckNoBufferSpace: 10055,
  sckAlreadyConnected: 10056, sckNotConnected: 10057, sckSocketShutdown: 10058, sckTimedout: 10060, sckConnectionRefused: 10061,
  sckNotInitialized: 10093, sckHostNotFound: 11001, sckHostNotFoundTryAgain: 11002, sckNonRecoverableError: 11003, sckNoData: 11004,
});

// MSComm (MSCOMM32.OCX): OnComm's CommEvent values, handshaking, input modes and error numbers
group({
  comEvSend: 1, comEvReceive: 2, comEvCTS: 3, comEvDSR: 4, comEvCD: 5, comEvRing: 6, comEvEOF: 7,
  comEventBreak: 1001, comEventCTSTO: 1002, comEventDSRTO: 1003, comEventFrame: 1004, comEventOverrun: 1006, comEventCDTO: 1007,
  comEventRxOver: 1008, comEventRxParity: 1009, comEventTxFull: 1010, comEventDCB: 1011,
  comNone: 0, comXOnXoff: 1, comRTS: 2, comRTSXOnXOff: 3,
  comInputModeText: 0, comInputModeBinary: 1,
  comInvalidPropertyValue: 380, comSetNotSupported: 383, comGetNotSupported: 394, comPortOpen: 8000, comPortInvalid: 8002,
  comPortAlreadyOpen: 8005, comNoOpen: 8012, comSetCommStateFailed: 8015, comPortNotOpen: 8018, comReadError: 8020, comDCBError: 8021,
});

// WebBrowser (SHDOCVW.DLL): Navigate flags
group({ navOpenInNewWindow: 1, navNoHistory: 2, navNoReadFromCache: 4, navNoWriteToCache: 8 });

// MSChart (MSCHRT20.OCX): chartType and Plot.Axis(id)
group({
  VtChChartType3dBar: 0, VtChChartType2dBar: 1, VtChChartType3dLine: 2, VtChChartType2dLine: 3,
  VtChChartType3dArea: 4, VtChChartType2dArea: 5, VtChChartType3dStep: 6, VtChChartType2dStep: 7,
  VtChChartType2dPie: 14, VtChChartType2dXY: 16,
  VtChAxisIdX: 0, VtChAxisIdY: 1, VtChAxisIdY2: 2, VtChAxisIdZ: 3,
});

// MMControl (MCI32.OCX): Mode, Done's NotifyCode, TimeFormat, Orientation, RecordMode, BorderStyle
group({
  mciModeNotOpen: 524, mciModeStop: 525, mciModePlay: 526, mciModeRecord: 527, mciModeSeek: 528, mciModePause: 529, mciModeReady: 530,
  mciSuccessful: 1, mciSuperseded: 2, mciAborted: 4, mciFailure: 8,
  mciFormatMilliseconds: 0, mciFormatHms: 1, mciFormatMsf: 2, mciFormatFrames: 3, mciFormatSmpte24: 4, mciFormatSmpte25: 5,
  mciFormatSmpte30: 6, mciFormatSmpte30Drop: 7, mciFormatBytes: 8, mciFormatSamples: 9, mciFormatTmsf: 10,
  mciOrientHorz: 0, mciOrientVert: 1, mciRecordInsert: 0, mciRecordOverwrite: 1, mciBorderNone: 0, mciFixedSingle: 1,
});

// MediaPlayer (MSDXM.OCX): PlayState and ReadyState
group({
  mpStopped: 0, mpPaused: 1, mpPlaying: 2, mpWaiting: 3, mpScanForward: 4, mpScanReverse: 5, mpClosed: 6,
  mpReadyStateUninitialized: 0, mpReadyStateLoading: 1, mpReadyStateInteractive: 3, mpReadyStateComplete: 4,
});

// Clipboard formats (GetFormat, GetText, SetText): only vbCFText is supported
group({ vbCFText: 1, vbCFBitmap: 2, vbCFMetafile: 3, vbCFDIB: 8, vbCFPalette: 9, vbCFEMetafile: 14, vbCFFiles: 15, vbCFLink: -16640, vbCFRTF: -16639 });

// Data control (DAO): Validate's Action, Error's Response, BOFAction / EOFAction, RecordsetType, EditMode, OpenRecordset, Field.Type
group({
  vbDataActionCancel: 0, vbDataActionMoveFirst: 1, vbDataActionMovePrevious: 2, vbDataActionMoveNext: 3, vbDataActionMoveLast: 4,
  vbDataActionAddNew: 5, vbDataActionUpdate: 6, vbDataActionDelete: 7, vbDataActionFind: 8, vbDataActionBookmark: 9,
  vbDataActionClose: 10, vbDataActionUnload: 11,
  vbDataErrContinue: 0, vbDataErrDisplay: 1,
  vbBOFActionMoveFirst: 0, vbBOFActionBOF: 1, vbEOFActionMoveLast: 0, vbEOFActionEOF: 1, vbEOFActionAddNew: 2,
  vbRSTypeTable: 0, vbRSTypeDynaset: 1, vbRSTypeSnapShot: 2,
  dbOpenTable: 1, dbOpenDynaset: 2, dbOpenSnapshot: 4, dbOpenForwardOnly: 8,
  dbEditNone: 0, dbEditInProgress: 1, dbEditAdd: 2,
  dbBoolean: 1, dbByte: 2, dbInteger: 3, dbLong: 4, dbCurrency: 5, dbSingle: 6, dbDouble: 7, dbDate: 8, dbBinary: 9, dbText: 10,
  dbLongBinary: 11, dbMemo: 12,
});

// ADO (Adodc, Recordset, Connection): EventReasonEnum, EventStatusEnum, Find, Move, EditMode, CommandType, cursors, State, Field.Type
group({
  adRsnAddNew: 1, adRsnDelete: 2, adRsnUpdate: 3, adRsnUndoUpdate: 4, adRsnUndoAddNew: 5, adRsnUndoDelete: 6, adRsnRequery: 7,
  adRsnResynch: 8, adRsnClose: 9, adRsnMove: 10, adRsnFirstChange: 11, adRsnMoveFirst: 12, adRsnMoveNext: 13, adRsnMovePrevious: 14, adRsnMoveLast: 15,
  adStatusOK: 1, adStatusErrorsOccurred: 2, adStatusCantDeny: 3, adStatusCancel: 4, adStatusUnwantedEvent: 5,
  adSearchForward: 1, adSearchBackward: -1, adBookmarkCurrent: 0, adBookmarkFirst: 1, adBookmarkLast: 2,
  adEditNone: 0, adEditInProgress: 1, adEditAdd: 2, adEditDelete: 4,
  adCmdText: 1, adCmdTable: 2, adCmdStoredProc: 4, adCmdUnknown: 8, adCmdTableDirect: 512,
  adStateClosed: 0, adStateOpen: 1, adPosUnknown: -1, adPosBOF: -2, adPosEOF: -3,
  adUseServer: 2, adUseClient: 3, adOpenForwardOnly: 0, adOpenKeyset: 1, adOpenDynamic: 2, adOpenStatic: 3,
  adLockReadOnly: 1, adLockPessimistic: 2, adLockOptimistic: 3, adLockBatchOptimistic: 4,
  adDoMoveFirst: 0, adStayBOF: 1, adDoMoveLast: 0, adStayEOF: 1, adDoAddNew: 2,
  adSmallInt: 2, adInteger: 3, adSingle: 4, adDouble: 5, adCurrency: 6, adDate: 7, adBoolean: 11, adVariant: 12, adTinyInt: 16,
  adBigInt: 20, adVarWChar: 202, adLongVarWChar: 203, adLongVarBinary: 205,
});

// DataGrid (MSDATGRD.OCX), DataList / DataCombo (MSDATLST.OCX)
group({
  dbgLeft: 0, dbgRight: 1, dbgCenter: 2, dbgGeneral: 3, dbgNoBorder: 0, dbgFixedSingle: 1,
  dbcAreaButton: 0, dbcAreaEdit: 1, dbcAreaList: 2, dbcDropdownCombo: 0, dbcSimpleCombo: 1, dbcDropdownList: 2,
  dblBasicMatching: 0, dblExtendedMatching: 1,
});
