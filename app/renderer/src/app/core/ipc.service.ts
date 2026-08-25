import type { Events, Invocations } from "../../../../shared/channels.js";

export interface BabelbookBridge {
  invoke<K extends keyof Invocations>(
    channel: K, payload: Invocations[K]["req"],
  ): Promise<Invocations[K]["res"]>;
  on<K extends keyof Events>(channel: K, listener: (payload: Events[K]) => void): () => void;
}

/**
 * The renderer's only way out.
 *
 * It is a plain class on purpose: no `inject()`, no Angular dependency, so it
 * can be tested with a stubbed bridge and no TestBed. Angular still gets it
 * through a provider.
 */
export class IpcService {
  #bridge(): BabelbookBridge {
    const bridge = (globalThis as { window?: { babelbook?: BabelbookBridge } }).window?.babelbook;
    // A missing bridge means the preload did not load. Answering `undefined`
    // would turn one configuration fault into a dozen blank screens with no
    // explanation; failing here names it once.
    if (bridge === undefined) throw new Error("NO_BRIDGE");
    return bridge;
  }

  invoke<K extends keyof Invocations>(
    channel: K, payload: Invocations[K]["req"],
  ): Promise<Invocations[K]["res"]> {
    return this.#bridge().invoke(channel, payload);
  }

  on<K extends keyof Events>(channel: K, listener: (payload: Events[K]) => void): () => void {
    return this.#bridge().on(channel, listener);
  }
}
