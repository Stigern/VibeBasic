// One collection item per line, fields separated by '|' (StatusBar Panels: 'Text|Key|Width|Alignment', TabStrip Tabs:
// 'Caption|Key'). '\|' is a literal bar and '\\' a backslash. Trailing empty fields may be left out.

export function splitFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) cur += line[++i];
    else if (c === '|') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function joinFields(fields: (string | number)[]): string {
  const esc = fields.map(f => String(f).replace(/[\\|]/g, m => '\\' + m));
  while (esc.length > 1 && esc[esc.length - 1] === '') esc.pop();
  return esc.join('|');
}
