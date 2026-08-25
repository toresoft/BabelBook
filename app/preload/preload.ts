import { contextBridge, ipcRenderer } from "electron";
import { EVENTS, INVOCATIONS, type Events, type Invocations } from "../shared/channels.ts";

/**
 * Two shapes, and nothing else.
 *
 * The channel is checked against the declared list before it is used: without
 * that, the renderer could invoke any channel the main process happens to have
 * registered, including ones meant for something else entirely.
 */
const bridge = {
  invoke<K extends keyof Invocations>(
    channel: K,
    payload: Invocations[K]["req"],
  ): Promise<Invocations[K]["res"]> {
    if (!(INVOCATIONS as readonly string[]).includes(channel)) {
      throw new Error(`unknown channel: ${String(channel)}`);
    }
    return ipcRenderer.invoke(channel, payload) as Promise<Invocations[K]["res"]>;
  },

  on<K extends keyof Events>(channel: K, listener: (payload: Events[K]) => void): () => void {
    if (!(EVENTS as readonly string[]).includes(channel)) {
      throw new Error(`unknown event: ${String(channel)}`);
    }
    const wrapped = (_event: unknown, payload: unknown) => listener(payload as Events[K]);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.off(channel, wrapped); };
  },
};

contextBridge.exposeInMainWorld("babelbook", bridge);

export type BabelbookBridge = typeof bridge;
