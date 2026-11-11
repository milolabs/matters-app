import type { GeneralImages, ImageRule, ImageRuleScope, ImageRuleStorePort } from "@matters/core";

const keyOf = (scope: ImageRuleScope, value: string) => `${scope}\u0000${value}`;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reference semantics for `ImageRuleStorePort`; the SQLite adapter must agree with it. */
export class InMemoryImageRuleStore implements ImageRuleStorePort {
  private rules = new Map<string, ImageRule>();
  private general: GeneralImages = "ask";

  /** Lets a unit of work roll the rules back. */
  snapshot(): () => void {
    const savedRules = new Map(this.rules);
    const savedGeneral = this.general;
    return () => {
      this.rules = savedRules;
      this.general = savedGeneral;
    };
  }

  async get(scope: ImageRuleScope, value: string): Promise<ImageRule | null> {
    return this.rules.get(keyOf(scope, value)) ?? null;
  }

  async list(): Promise<readonly ImageRule[]> {
    return [...this.rules.values()].sort(
      (a, b) =>
        b.createdMs - a.createdMs || compareText(a.scope, b.scope) || compareText(a.value, b.value),
    );
  }

  async put(rule: ImageRule): Promise<void> {
    this.rules.set(keyOf(rule.scope, rule.value), rule);
  }

  async putIfAbsent(rules: readonly ImageRule[]): Promise<number> {
    let added = 0;
    for (const rule of rules) {
      const key = keyOf(rule.scope, rule.value);
      if (this.rules.has(key)) continue;
      this.rules.set(key, rule);
      added++;
    }
    return added;
  }

  async remove(scope: ImageRuleScope, value: string): Promise<boolean> {
    return this.rules.delete(keyOf(scope, value));
  }

  async getGeneral(): Promise<GeneralImages> {
    return this.general;
  }

  async setGeneral(value: GeneralImages): Promise<void> {
    this.general = value;
  }
}
