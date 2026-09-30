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

/**
 * A query needing fully enriched data was asked to run against an index that
 * still holds unclassified rows.
 *
 * Thrown rather than returning a partial result on purpose: an undercount from
 * `overlap` is not a degraded answer, it is a wrong one that looks right. A
 * wallet that bought seven of fifteen collections would score zero, and nothing
 * in the output would say why.
 */
export class EnrichmentLevelError extends ByakuganError {}
