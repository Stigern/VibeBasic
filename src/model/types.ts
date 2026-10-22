// Project model. All lengths are twips (1 px = 15 twips); colours are VB6 Longs.

export type ControlType = 'Form' | 'CommandButton' | 'Label' | 'TextBox' | 'CheckBox' | 'OptionButton' | 'Frame'
  | 'ListBox' | 'ComboBox' | 'PictureBox' | 'Image' | 'Timer' | 'HScrollBar' | 'VScrollBar' | 'ProgressBar'
  | 'Shape' | 'Line' | 'Slider' | 'UpDown' | 'StatusBar' | 'TabStrip'
  | 'TreeView' | 'ListView' | 'MSFlexGrid'
  | 'CommonDialog' | 'RichTextBox'
  | 'DriveListBox' | 'DirListBox' | 'FileListBox';
export interface FontValue { name: string; size: number; bold: boolean; italic: boolean; underline: boolean }
export interface PictureRef { asset: string }                 // key in Project.assets
export type PropValue = string | number | boolean | string[] | FontValue | PictureRef | null;
export interface ControlDef { id: string; type: Exclude<ControlType, 'Form'>; name: string; index: number | null;
  parentId: string | null; props: Record<string, PropValue> }  // Left/Top relative to the parent, in twips
/** `controls` is in z-order (back first). `props` never contains `Name` or `Index`; they live in their own fields. */
export interface FormDef { id: string; name: string; props: Record<string, PropValue>; controls: ControlDef[]; code: string }
export interface ModuleDef { id: string; name: string; code: string }
export interface Asset { mime: string; dataBase64: string }
export interface Project { name: string; title: string; startupForm: string; forms: FormDef[]; modules: ModuleDef[];
  assets: Record<string, Asset>; iconAsset: string | null }
