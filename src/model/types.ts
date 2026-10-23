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
export interface FontValue { name: string; size: number; bold: boolean; italic: boolean; underline: boolean }
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
export interface ModuleDef { id: string; name: string; code: string }
export interface Asset { mime: string; dataBase64: string }
/** `components`: the OCX file names checked in Project > Components (see components.ts); their controls are in the Toolbox. */
/** A watch of the Watch window (Debug > Add Watch): `module` / `procedure` null are "(All Modules)" / "(All Procedures)". */
export interface WatchDef { expression: string; module: string | null; procedure: string | null; kind: 'watch' | 'breakTrue' | 'breakChange' }
/** `watches`: the Watch window's watches, saved with the project (absent when there are none). */
export interface Project { name: string; title: string; startupForm: string; forms: FormDef[]; modules: ModuleDef[];
  assets: Record<string, Asset>; iconAsset: string | null; components: string[]; watches?: WatchDef[] }
