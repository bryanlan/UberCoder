import type { TransportPlugin } from './types.js';

export class TransportPluginRegistry {
  private readonly plugins = new Map<string, TransportPlugin>();

  register(plugin: TransportPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Transport plugin "${plugin.id}" is already registered.`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): TransportPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): TransportPlugin[] {
    return [...this.plugins.values()];
  }
}
