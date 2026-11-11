import type { ImageRule, ImageWriteDeps } from "@matters/core";
import {
  importImageAddresses,
  removeImageRule,
  setGeneralImages,
  setImageRule,
  stopImages,
} from "@matters/core";
import type { ImagesApi } from "./handler.ts";

/** The image rule requests of the renderer over the core use cases. Runs in the sync worker (it writes). */
export class ImageRuleService implements ImagesApi {
  private readonly deps: ImageWriteDeps;

  constructor(deps: ImageWriteDeps) {
    this.deps = deps;
  }

  setRule(input: Parameters<ImagesApi["setRule"]>[0]): Promise<ImageRule> {
    return setImageRule(this.deps, input);
  }

  removeRule(scope: ImageRule["scope"], value: string): Promise<boolean> {
    return removeImageRule(this.deps, scope, value);
  }

  stop(input: Parameters<ImagesApi["stop"]>[0]): Promise<void> {
    return stopImages(this.deps, input);
  }

  setGeneral(general: Parameters<ImagesApi["setGeneral"]>[0]): Promise<void> {
    return setGeneralImages(this.deps, general);
  }

  importAddresses(addresses: readonly string[]): Promise<number> {
    return importImageAddresses(this.deps, addresses);
  }
}
