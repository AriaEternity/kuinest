import type { Clock, IdFactory } from "../ports.js";
import type { AppConfig } from "../config.js";
import type { ApiStorage } from "./ports.js";
import type { Passwords } from "../auth/password.js";
import { Signing } from "../auth/secrets.js";
import { Sessions } from "../auth/sessions.js";
import { Queries } from "./queries.js";

export class ApiServices {
  readonly sessions: Sessions;
  readonly queries: Queries;
  constructor(store: ApiStorage, config: AppConfig, clock: Clock, ids: IdFactory, key: Buffer, passwords?: Passwords) {
    const signing = new Signing(key);
    this.sessions = new Sessions(store, clock, config, signing, passwords);
    this.queries = new Queries(store, clock, ids, signing);
  }
}
