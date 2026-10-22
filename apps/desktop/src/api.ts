import { invoke } from '@tauri-apps/api/core';
import type { Envelope, Request } from '@jobpilot/contracts';
export const isDesktop = () => '__TAURI_INTERNALS__' in window;
export async function request<T>(action: Request['action'], payload?: unknown): Promise<T> {
  const result = await invoke<Envelope<T>>('worker_request', {action, payload});
  if (!result.ok) throw new Error(`${result.error?.code}：${result.error?.message}`);
  return result.data as T;
}
export const chooseResume = () => invoke<string | null>('choose_resume');
export const chooseEnv = () => invoke<string | null>('choose_env');
export const chooseBackup=()=>invoke<string|null>('choose_backup');
export const revealArtifact=(path:string)=>invoke<void>('reveal_artifact',{path});
export const saveArtifact=(path:string)=>invoke<string|null>('save_artifact',{path});
export const restartAfterData=()=>invoke<void>('restart_after_data');
