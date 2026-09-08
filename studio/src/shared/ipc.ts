// Typed IPC surface between renderer and main. Keep every channel here.
export interface ScriptFileInfo { path: string; course: string; week: string; lesson: string; mtime: number }

export interface StudioApi {
  invoke(channel: "config:get"): Promise<any>;
  invoke(channel: "config:set", patch: any): Promise<any>;
  invoke(channel: "scripts:list"): Promise<ScriptFileInfo[]>;
  invoke(channel: "scripts:read", path: string): Promise<string>;
  invoke(channel: "scripts:write", path: string, text: string): Promise<void>;
  invoke(channel: "dialog:openFile", opts?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null>;
  invoke(channel: "dialog:openDir", defaultPath?: string): Promise<string | null>;
  invoke(channel: "shell:openPath", path: string): Promise<void>;
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (...args: any[]) => void): () => void;
}
declare global { interface Window { studio: StudioApi } }
