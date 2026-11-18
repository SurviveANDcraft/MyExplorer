import { invoke as tauriInvoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { AppError, Commands, ErrorCode, Events } from './types';

export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type CmdName = keyof Commands;
export type CmdArgs<K extends CmdName> = Parameters<Commands[K]>;
export type CmdRet<K extends CmdName> = ReturnType<Commands[K]>;

type MockModule = typeof import('./mock');
let mockPromise: Promise<MockModule> | null = null;
const mock = () => (mockPromise ??= import('./mock'));

const CODES: ErrorCode[] = ['not_found', 'access_denied', 'exists', 'invalid_name', 'cancelled', 'unsupported', 'io'];

export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as { code?: unknown; message: unknown };
    const code = CODES.includes(o.code as ErrorCode) ? (o.code as ErrorCode) : 'io';
    return { code, message: String(o.message) };
  }
  return { code: 'io', message: typeof e === 'string' ? e : 'Unexpected error' };
}

export async function invoke<K extends CmdName>(cmd: K, ...args: CmdArgs<K>): Promise<CmdRet<K>> {
  try {
    if (IS_TAURI) return await tauriInvoke<CmdRet<K>>(cmd, args[0] as Record<string, unknown> | undefined);
    const m = await mock();
    return (await m.handle(cmd, args[0])) as CmdRet<K>;
  } catch (e) {
    throw toAppError(e);
  }
}

export async function listen<K extends keyof Events>(ev: K, cb: (payload: Events[K]) => void): Promise<() => void> {
  if (IS_TAURI) return tauriListen<Events[K]>(ev, (e) => cb(e.payload));
  const m = await mock();
  return m.on(ev, cb as (p: unknown) => void);
}

export const fileSrc = (path: string): string | null => (IS_TAURI ? convertFileSrc(path) : null);

export type IconSize = 16 | 32 | 48 | 96 | 256;
export const iconUrl = (ext: string, size: IconSize) =>
  IS_TAURI ? `http://icon.localhost/?ext=${encodeURIComponent(ext)}&size=${size}` : null;
export const iconPathUrl = (path: string, size: IconSize) =>
  IS_TAURI ? `http://icon.localhost/?path=${encodeURIComponent(path)}&size=${size}` : null;
export const thumbUrl = (path: string, size: IconSize, modified: number) =>
  IS_TAURI ? `http://thumb.localhost/?path=${encodeURIComponent(path)}&size=${size}&m=${modified}` : null;
