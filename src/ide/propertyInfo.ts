// Properties window metadata: the VB6 category of each property (Categorized tab) and the one-line
// description shown in the pane at the bottom of the window.

export const CATEGORIES = ['Appearance', 'Behavior', 'Data', 'DDE', 'Font', 'List', 'Misc', 'Position', 'Scale', 'Text'] as const;
export type Category = typeof CATEGORIES[number];

const GROUPS: Partial<Record<Category, string[]>> = {
  Appearance: ['Appearance', 'BackColor', 'BackStyle', 'BorderColor', 'BorderStyle', 'BorderWidth', 'Caption', 'FillColor',
    'FillStyle', 'ForeColor', 'GridLines', 'LineStyle', 'Orientation', 'Picture', 'Scrolling', 'Shape', 'Style', 'TickStyle', 'View'],
  Behavior: ['Alignment', 'AutoSize', 'Cancel', 'Default', 'Enabled', 'FullRowSelect', 'Indentation', 'Interval', 'Locked',
    'MaxLength', 'MultiLine', 'MultiSelect', 'PasswordChar', 'ScrollBars', 'SelectionMode', 'Sorted', 'SortKey', 'SortOrder',
    'Stretch', 'Visible', 'WordWrap', 'Wrap'],
  Font: ['Font'],
  List: ['Bands', 'ColumnHeaders', 'ComboItems', 'List', 'Panels', 'Tabs'],
  Position: ['Height', 'Left', 'StartUpPosition', 'Top', 'Width', 'WindowState', 'X1', 'X2', 'Y1', 'Y2'],
  Scale: ['Cols', 'FixedCols', 'FixedRows', 'Increment', 'LargeChange', 'Max', 'Min', 'Rows', 'SmallChange', 'TickFrequency'],
  Text: ['SimpleText', 'Text'],
};
const CATEGORY_OF = new Map<string, Category>();
for (const [cat, names] of Object.entries(GROUPS) as [Category, string[]][]) for (const n of names) CATEGORY_OF.set(n.toLowerCase(), cat);

/** The VB6 category of a property; anything not in the map is Misc. */
export function categoryOf(name: string): Category {
  return CATEGORY_OF.get(name.toLowerCase()) ?? 'Misc';
}

const DESCRIPTIONS: Record<string, string> = {
  '(Name)': 'Returns the name used in code to identify an object.',
  Index: 'Returns/sets the number identifying a control in a control array.',
  Alignment: 'Returns/sets the alignment of the text or of the check box/option button.',
  Appearance: 'Returns/sets whether the object is painted flat or with 3-D effects.',
  AutoSize: 'Determines whether the control is resized automatically to fit its contents.',
  BackColor: 'Returns/sets the background color used to display text and graphics in an object.',
  BackStyle: 'Indicates whether the background is transparent or opaque.',
  BorderColor: 'Returns/sets the color of the object\'s border.',
  BorderStyle: 'Returns/sets the border style for an object.',
  BorderWidth: 'Returns/sets the width of the border.',
  Cancel: 'Indicates whether the button is pressed when the user presses Esc.',
  Caption: 'Returns/sets the text displayed in an object\'s title bar or below an object\'s icon.',
  ColumnHeaders: 'The column headers of the report view, one per line: Text|Key|Width|Alignment.',
  Cols: 'Returns/sets the total number of columns in the grid.',
  ControlBox: 'Returns a value indicating whether a Control-menu box is displayed on a form at run time.',
  Default: 'Determines which button is pressed when the user presses Enter.',
  Enabled: 'Returns/sets a value that determines whether an object can respond to user-generated events.',
  FillColor: 'Returns/sets the color used to fill in shapes.',
  FillStyle: 'Returns/sets the fill style of a shape.',
  FixedCols: 'Returns/sets the number of fixed (non-scrollable) columns.',
  FixedRows: 'Returns/sets the number of fixed (non-scrollable) rows.',
  Font: 'Returns a Font object.',
  ForeColor: 'Returns/sets the foreground color used to display text and graphics in an object.',
  FullRowSelect: 'Determines whether the entire row is highlighted when an item is selected.',
  GridLines: 'Returns/sets whether grid lines are shown between cells or rows.',
  Height: 'Returns/sets the height of an object.',
  Icon: 'Returns the icon displayed when a form is minimized at run time.',
  Increment: 'Returns/sets the amount the value changes on each click of an arrow.',
  Indentation: 'Returns/sets the width of the indentation of child nodes.',
  Instancing: 'Sets a value that specifies whether you can create instances of a public class outside a project.',
  Interval: 'Returns/sets the number of milliseconds between calls to a Timer control\'s Timer event.',
  KeyPreview: 'Returns/sets whether keyboard events for an object are invoked before keyboard events for controls on that object.',
  LargeChange: 'Returns/sets the amount of change to the Value property when the user clicks the scroll area.',
  Left: 'Returns/sets the distance between the internal left edge of an object and the left edge of its container.',
  LineStyle: 'Returns/sets the style of lines displayed between nodes.',
  List: 'Returns/sets the items contained in a control\'s list portion.',
  Locked: 'Determines whether a control can be edited.',
  Max: 'Returns/sets the maximum value.',
  MaxButton: 'Determines whether a form has a Maximize button.',
  MaxLength: 'Returns/sets the maximum number of characters that can be entered in a control (0 = no limit).',
  Min: 'Returns/sets the minimum value.',
  MinButton: 'Determines whether a form has a Minimize button.',
  MultiLine: 'Returns/sets a value that determines whether a control can accept multiple lines of text.',
  MultiSelect: 'Returns/sets a value that determines whether a user can make multiple selections in a control.',
  Orientation: 'Returns/sets whether the control is oriented horizontally or vertically.',
  Panels: 'The panels of the status bar, one per line.',
  ComboItems: 'The items of the image combo, one per line: Text|Key|Image|SelImage|Indentation.',
  Bands: 'The bands of the cool bar, one per line: Caption|Key|Image|NewRow(1)|Style|Child|MinWidth|Width.',
  PasswordChar: 'Returns/sets a value that determines whether characters typed by a user or placeholder characters are displayed in a control.',
  Picture: 'Returns/sets a graphic to be displayed in a control.',
  Rows: 'Returns/sets the total number of rows in the grid.',
  ScrollBars: 'Returns/sets a value indicating whether an object has vertical or horizontal scroll bars.',
  Scrolling: 'Returns/sets whether the progress is shown in blocks or as a smooth bar.',
  SelectionMode: 'Returns/sets whether the grid selects free ranges, whole rows or whole columns.',
  Shape: 'Returns/sets a value indicating the appearance of a control.',
  SimpleText: 'Returns/sets the text displayed when the status bar\'s Style is sbrSimple.',
  SmallChange: 'Returns/sets the amount of change to the Value property when the user clicks a scroll arrow.',
  Sorted: 'Indicates whether the elements of a control are automatically sorted alphabetically.',
  SortKey: 'Returns/sets the column the items are sorted by.',
  SortOrder: 'Returns/sets whether items are sorted in ascending or descending order.',
  StartUpPosition: 'Returns or sets a value specifying the position of a form when it first appears.',
  Stretch: 'Returns/sets a value that determines whether a graphic resizes to fit the size of an Image control.',
  Style: 'Returns/sets the appearance and behaviour of the control.',
  TabIndex: 'Returns/sets the tab order of an object within its parent form.',
  Tabs: 'The tabs of the tab strip, one per line.',
  TabStop: 'Returns a value indicating whether a user can use the Tab key to give the focus to an object.',
  Tag: 'Stores any extra data needed for your program.',
  Text: 'Returns/sets the text contained in the control.',
  TickFrequency: 'Returns/sets the ratio of ticks to the range of the slider.',
  TickStyle: 'Returns/sets the style (or positioning) of the tick marks.',
  ToolTipText: 'Returns/sets the text displayed when the mouse is paused over the control.',
  Top: 'Returns/sets the distance between the internal top edge of an object and the top edge of its container.',
  Value: 'Returns/sets the value of an object.',
  View: 'Returns/sets how the items are displayed (icons, list or report).',
  Visible: 'Returns/sets a value that determines whether an object is visible or hidden.',
  Width: 'Returns/sets the width of an object.',
  WindowState: 'Returns/sets the visual state of a form window at run time.',
  WordWrap: 'Returns/sets a value that determines whether a control expands to fit the text in its Caption.',
  Wrap: 'Determines whether the value wraps around from Max to Min and back.',
  X1: 'Returns/sets the x-coordinate of the starting point of the line.',
  X2: 'Returns/sets the x-coordinate of the ending point of the line.',
  Y1: 'Returns/sets the y-coordinate of the starting point of the line.',
  Y2: 'Returns/sets the y-coordinate of the ending point of the line.',
};

/** One-line description for the Properties window's description pane ('' when there is none). */
export function describeProperty(name: string): string {
  return DESCRIPTIONS[name] ?? '';
}
