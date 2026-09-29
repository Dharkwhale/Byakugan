export class ByakuganError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends ByakuganError {}
export class UnsupportedStandardError extends ByakuganError {}
export class DeployBlockUnavailableError extends ByakuganError {}
export class RangeExhaustedError extends ByakuganError {}
export class CollectionLockedError extends ByakuganError {}
export class MigrationError extends ByakuganError {}
export class DecodeError extends ByakuganError {}
export class ClassifyError extends ByakuganError {}
