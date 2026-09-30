export class ByakuganError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends ByakuganError {}

/**
 * The COMMAND was wrong: a malformed address, an unknown option, a flag missing its
 * value, an unrecognised enrichment level.
 *
 * Split from `ConfigError` because the two have different fixes and the CLI attaches a
 * different hint to each. Folded together, a mistyped address was being told to "set
 * the missing environment variable and add the chain to config/chains.json", which is
 * advice about a problem it does not have — and a misleading hint is worse than none,
 * since it sends the reader somewhere the fault is not.
 */
export class UsageError extends ByakuganError {}
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

/**
 * Transaction enrichment could not produce usable data for a transfer.
 *
 * Distinct from a transport failure, which retries: this means what came back was
 * wrong rather than absent — a transaction missing from its own block (a reorg below
 * the confirmations depth), or a sender or value of the wrong shape. Retrying would
 * not help, and continuing would store an unenriched row under an index about to be
 * recorded as complete.
 */
export class TxEnrichmentError extends ByakuganError {}
