import type { Settings } from "./config.ts";

export class FastModeController {
  private supportedModelIds = new Set<string>();
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setSupportedModelIds(modelIds: Iterable<string>): void {
    this.supportedModelIds = new Set(modelIds);
  }

  isEnabled = (): boolean => this.enabled;

  isModelSupported(modelId: string): boolean {
    return this.supportedModelIds.has(modelId);
  }

  isEffectiveFor(modelId: string): boolean {
    return this.enabled && this.isModelSupported(modelId);
  }

  toggle(settings: Settings): boolean {
    const enabled = !this.enabled;
    settings.save({ fast: enabled });
    this.enabled = enabled;

    return enabled;
  }
}
