// Content of the VB6 run-time / compile error dialog. Pure; shared by every FormHost.

export interface RuntimeErrorInfo { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }
export interface ErrorButton { label: string; value: 'end' | 'debug'; disabled?: boolean }

export function runtimeErrorContent(o: RuntimeErrorInfo): { title: string; text: string; buttons: ErrorButton[] } {
  const text = o.compile ? `Compile error:\n\n${o.description}` : `Run-time error '${o.number}':\n\n${o.description}`;
  if (o.mode === 'app') return { title: o.title, text, buttons: [{ label: 'OK', value: 'end' }] };
  const buttons: ErrorButton[] = o.compile
    ? [{ label: 'OK', value: 'debug' }, { label: 'Help', value: 'end', disabled: true }]
    : [{ label: 'Continue', value: 'end', disabled: true }, { label: 'End', value: 'end' }, { label: 'Debug', value: 'debug' }, { label: 'Help', value: 'end', disabled: true }];
  return { title: 'VibeBasic', text, buttons };
}
