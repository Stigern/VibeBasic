// Project model. All lengths are twips (1 px = 15 twips); colours are VB6 Longs.

export type ControlType = 'Form' | 'CommandButton' | 'Label' | 'TextBox' | 'CheckBox' | 'OptionButton' | 'Frame'
  | 'ListBox' | 'ComboBox' | 'PictureBox' | 'Image' | 'Timer' | 'HScrollBar' | 'VScrollBar' | 'ProgressBar'
  | 'Shape' | 'Line' | 'Slider' | 'UpDown' | 'StatusBar' | 'TabStrip'
  | 'TreeView' | 'ListView' | 'MSFlexGrid'
  | 'CommonDialog' | 'RichTextBox'
  | 'DriveListBox' | 'DirListBox' | 'FileListBox'
  | 'SSTab'
  | 'ImageList' | 'Toolbar'
  | 'DTPicker' | 'MonthView' | 'MaskedEdit'
  | 'WebBrowser' | 'Inet' | 'Winsock' | 'MSComm' | 'SysInfo'
  | 'MSChart'
  | 'MMControl' | 'MediaPlayer' | 'Agent'
  | 'Data' | 'Adodc' | 'DataGrid' | 'DataList' | 'DataCombo'
  | 'SSPanel' | 'SSCommand' | 'SSCheck' | 'SSOption' | 'SSFrame' | 'SSRibbon'
  | 'Animation' | 'ImageCombo' | 'CoolBar' | 'FlatScrollBar' | 'Calendar'
  | 'Menu';
export interface FontValue { name: string; size: number; bold: boolean; italic: boolean; underline: boolean; strikethrough?: boolean }
export interface PictureRef { asset: string }                 // key in Project.assets
export type PropValue = string | number | boolean | string[] | FontValue | PictureRef | null;
/** Left/Top are relative to the parent, in twips. `tab`: the 0-based tab of an SSTab parent the control sits on (absent = 0;
 *  ignored when the parent is not an SSTab). Only the children on the SSTab's current tab (its `Tab` property) are shown. */
export interface ControlDef { id: string; type: Exclude<ControlType, 'Form'>; name: string; index: number | null;
  parentId: string | null; props: Record<string, PropValue>; tab?: number }
/** `controls` is in z-order (back first). `props` never contains `Name` or `Index`; they live in their own fields.
 *  Menus are controls of type 'Menu' in `controls` too: in menu order, `parentId` the parent menu (null on the menu bar); see menus.ts.
 *  `mdi`: the project's MDI form (at most one; see mdi.ts); absent on ordinary forms. */
export interface FormDef { id: string; name: string; props: Record<string, PropValue>; controls: ControlDef[]; code: string; mdi?: boolean }
/**
 * A standard module, or with `kind: 'class'` a class module (VB6 .cls). `instancing`: the class's Instancing property
 * (VB6 values, 1 Private ... 6 GlobalMultiUse; stored only, every class is Private to the project). Both are optional:
 * older projects have neither.
 */
export interface ModuleDef { id: string; name: string; code: string; kind?: 'class'; instancing?: number }
/** What a module is to the interpreter. */
export const moduleKind = (m: ModuleDef): 'module' | 'class' => (m.kind === 'class' ? 'class' : 'module');
export interface Asset { mime: string; dataBase64: string }
/** A watch of the Watch window (Debug > Add Watch): `module` / `procedure` null are "(All Modules)" / "(All Procedures)". */
export interface WatchDef { expression: string; module: string | null; procedure: string | null; kind: 'watch' | 'breakTrue' | 'breakChange' }
/** Project Properties > Make: VB6's version number (0-9999 each) and version information (App.Major ..., the made app's Info.plist). */
export interface VersionInfo {
  major: number; minor: number; revision: number;
  /** Make adds 1 to the revision each time. */
  autoIncrement?: boolean;
  comments?: string; companyName?: string; fileDescription?: string; legalCopyright?: string; legalTrademarks?: string; productName?: string;
}
/** VB6's version of a new project: 1.0.0. */
export const DEFAULT_VERSION: VersionInfo = { major: 1, minor: 0, revision: 0 };
/**
 * `components`: the OCX file names checked in Project > Components (see components.ts); their controls are in the Toolbox.
 * `condComp`: the conditional compilation arguments for `#If` (`DEBUG = 1 : BETA = 0`); older projects have none.
 * `subMain`: the Startup Object is Sub Main (in a standard module); `startupForm` stays a form name (shown when this is unset).
 * `commandLine`: Command$ when the program runs in the IDE (Make tab, Command Line Arguments).
 * `versionInfo`: absent is DEFAULT_VERSION (not `version`: the file format number). `fileTypes`: extensions a made app opens from Finder (`kalk`, `txt`).
 * `watches`: the Watch window's watches (absent when there are none).
 * The fields after `components` are optional: older projects have none.
 */
export interface Project { name: string; title: string; startupForm: string; forms: FormDef[]; modules: ModuleDef[];
  assets: Record<string, Asset>; iconAsset: string | null; components: string[]; condComp?: string;
  subMain?: boolean; commandLine?: string; versionInfo?: VersionInfo; fileTypes?: string[]; watches?: WatchDef[] }
