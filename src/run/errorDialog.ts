// Content of the VB6 run-time / compile error dialog. Pure; shared by every FormHost.

export interface RuntimeErrorInfo { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }
/** 'ai' (IDE only) is Debug followed by the Ask AI flow. */
export type ErrorAnswer = 'end' | 'debug' | 'ai';
export interface ErrorButton { label: string; value: ErrorAnswer; disabled?: boolean }

export function runtimeErrorContent(o: RuntimeErrorInfo): { title: string; text: string; buttons: ErrorButton[] } {
  const text = o.compile ? `Compile error:\n\n${o.description}` : `Run-time error '${o.number}':\n\n${o.description}`;
  if (o.mode === 'app') return { title: o.title, text, buttons: [{ label: 'OK', value: 'end' }] };
  const ai: ErrorButton = { label: 'Ask AI', value: 'ai' };
  const buttons: ErrorButton[] = o.compile
    ? [{ label: 'OK', value: 'debug' }, ai, { label: 'Help', value: 'end', disabled: true }]
    : [{ label: 'Continue', value: 'end', disabled: true }, { label: 'End', value: 'end' }, { label: 'Debug', value: 'debug' }, ai, { label: 'Help', value: 'end', disabled: true }];
  return { title: 'VibeBasic', text, buttons };
}
