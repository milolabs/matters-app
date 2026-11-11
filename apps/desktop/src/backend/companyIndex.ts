/**
 * Mail grouped by who it is to or from, for a list that asks about many companies at once (ADR 0070,
 * rule 1). One walk over the mail fills it, and every question after that is a look in a map, where
 * asking the database per company walked the same messages once per company.
 *
 * An address (it holds `@`) names itself; a domain names itself and its subdomains. Feed it newest
 * first: each group keeps its newest `cap`, so a question never needs more than that.
 */
export class CompanyIndex<T> {
  private readonly cap: number;
  private readonly groups = new Map<string, T[]>();
  /** The item each group took last: one message to two people at a company counts once. */
  private readonly lastOf = new Map<string, T>();

  constructor(cap: number) {
    this.cap = cap;
  }

  add(address: string, item: T): void {
    const at = address.lastIndexOf("@");
    if (at <= 0 || at === address.length - 1) return;
    this.put(address, item);
    let domain = address.slice(at + 1);
    for (;;) {
      this.put(domain, item);
      const dot = domain.indexOf(".");
      if (dot < 0) return;
      domain = domain.slice(dot + 1);
    }
  }

  /** Newest first, at most `cap`, empty for a target nothing was filed under. */
  get(target: string): readonly T[] {
    return this.groups.get(target.trim().toLowerCase()) ?? [];
  }

  private put(key: string, item: T): void {
    if (this.lastOf.get(key) === item) return;
    const group = this.groups.get(key);
    if (group === undefined) this.groups.set(key, [item]);
    else if (group.length < this.cap) group.push(item);
    else return;
    this.lastOf.set(key, item);
  }
}
