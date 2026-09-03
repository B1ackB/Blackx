import type { DomainEvent } from "./model";

const storageKey = "blackx.demo.events.v1";

export interface EventStore {
  read(): DomainEvent[];
  append(events: DomainEvent[]): DomainEvent[];
  clear(): void;
}

export class LocalEventStore implements EventStore {
  read(): DomainEvent[] {
    const serialized = localStorage.getItem(storageKey);
    if (!serialized) return [];
    try {
      return JSON.parse(serialized) as DomainEvent[];
    } catch {
      localStorage.removeItem(storageKey);
      return [];
    }
  }

  append(events: DomainEvent[]): DomainEvent[] {
    const next = [...this.read(), ...events];
    localStorage.setItem(storageKey, JSON.stringify(next));
    return next;
  }

  clear(): void {
    localStorage.removeItem(storageKey);
  }
}
