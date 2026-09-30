-- Byakugan initial schema.
--
-- NUMERIC VALUES STORED AS TEXT: token_id, amount and tx_value_wei are uint256
-- and exceed Number.MAX_SAFE_INTEGER, so they are TEXT to avoid precision loss.
-- CONSEQUENCE: they sort LEXICOGRAPHICALLY, not numerically — '10' orders before
-- '9', and '100' before '2'. Milestone 1 never orders by them (ordering is always
-- block_number, log_index, batch_index). Anyone adding an ORDER BY or a range
-- comparison on these columns must zero-pad or CAST, or the results will be wrong
-- in a way that looks plausible.
--
-- TIMESTAMPS: locked_at and indexed_at are INTEGER epoch milliseconds, written
-- from the injected Clock. SQLite's own datetime()/unixepoch() are deliberately
-- not used anywhere — one clock, not two.
--
-- LOWERCASE ADDRESSES: addresses arrive here from two places — chain data
-- (logs, receipts) and, in a later milestone, user-supplied Telegram command
-- arguments. Either source can hand us mixed-case (checksummed) hex. A single
-- mixed-case row stored anywhere degrades Milestone 2's `overlap` and
-- `firstMinters` queries silently: they compare addresses as text, so a stored
-- `0xABC...` simply fails to match a queried `0xabc...` and produces a
-- plausible-looking wrong answer instead of an error. The CHECK constraints
-- below make that a loud INSERT failure instead.
--
-- A NOTE ON CHECK AND NULL, because it silently weakens constraints: SQLite
-- treats a CHECK expression evaluating to NULL as SATISFIED, not violated. So
-- `CHECK (col = lower(col))` on a nullable column permits NULL without saying
-- so. Where that is intended below it is written out explicitly
-- (`col IS NULL OR ...`) rather than left to the reader to infer.

CREATE TABLE IF NOT EXISTS collections (
  chain_id            INTEGER NOT NULL,
  contract            TEXT    NOT NULL CHECK (contract = lower(contract)),
  -- NULL until bootstrap completes. `standard IS NULL` means "claimed, not yet
  -- bootstrapped"; every read path must filter it out, or an unbootstrapped row
  -- surfaces as an indexed collection holding zero transfers.
  standard            TEXT    CHECK (standard IN ('721','1155')),
  name                TEXT,
  deploy_block        INTEGER,
  deploy_block_source TEXT    CHECK (deploy_block_source IN
                                     ('override','explorer','binary_search')),
  -- 1 when the deploy block was checked against the chain (code at the block,
  -- no code at block-1); 0 when it was accepted without validation because the
  -- provider could not serve state for that block. A block that FAILED
  -- validation never reaches a row: the explorer falls through and the other
  -- sources throw. Kept separate from deploy_block_source so source stays
  -- orthogonal to validation state.
  deploy_block_validated INTEGER NOT NULL DEFAULT 0
                           CHECK (deploy_block_validated IN (0, 1)),
  -- Which enrichment level the indexer was ASKED to produce:
  --
  --   'mints_only'  fetches NO transactions at all. mint and burn are decidable
  --                 from the log alone, so `firstMinters` is complete and exact
  --                 on this level at zero enrichment cost. Every other row is
  --                 stored 'unclassified'.
  --   'full'        fetches the transaction for EVERY row, including mints. The
  --                 mint rows do not need it for their `kind`, but 'full' has to
  --                 mean what it says, or a later feature reading mint price off
  --                 a 'full' index finds NULLs and no explanation.
  --
  -- This column is the declared INTENT, used to decide what an upgrade must
  -- fetch and to tell the owner what to re-run. It is deliberately NOT what
  -- gates a query: `requireFullEnrichment` derives that from the rows themselves
  -- (does any unclassified row exist?), because a column is a claim about the
  -- data while the rows ARE the data. A column reading 'full' beside
  -- unclassified rows would hand `overlap` an undercount — the precise failure
  -- this whole mechanism exists to prevent. Deriving it also stays exact when a
  -- collection is indexed at one level and extended at another.
  --
  -- Defaults to 'full' so a caller that never mentions enrichment gets the
  -- complete, correct index rather than a silently cheaper one.
  enrichment_level    TEXT    NOT NULL DEFAULT 'full'
                           CHECK (enrichment_level IN ('mints_only','full')),
  last_indexed_block  INTEGER,
  indexed_at          INTEGER,   -- epoch ms
  locked_by           TEXT,
  locked_at           INTEGER,   -- epoch ms
  PRIMARY KEY (chain_id, contract)
);

-- ENRICHMENT AND `kind`, the load-bearing part of this table.
--
-- Deciding `kind` needs different amounts of data depending on the answer:
--
--   mint          from == 0x0                       decidable from the LOG ALONE
--   burn          to   == 0x0                       decidable from the LOG ALONE
--   buy           tx.value > 0 AND tx.from == to    needs the TRANSACTION
--   transfer      everything else                   needs the TRANSACTION
--
-- So `transfer` is not a neutral default — it is the answer you get by failing
-- to look. An unenriched row stored as 'transfer' is indistinguishable from a
-- genuine transfer, which means every buy in an unenriched range is silently
-- lost. `overlap` counts [mint, buy] per wallet, so a wallet that bought seven
-- of fifteen collections would score zero and the output would look like a real
-- answer. That is the same silent-downgrade failure the ClassifyError guards in
-- src/indexer/classify.ts exist to prevent, arriving through the storage layer
-- instead of the argument list.
--
-- Hence 'unclassified': a row whose transaction was never fetched carries that
-- kind and NULL tx data, and no query can read a classification out of it. The
-- two table-level CHECK constraints below make the wrong state unrepresentable
-- rather than merely discouraged:
--
--   1. tx_from and tx_value_wei are absent together or present together. Half a
--      transaction is never a state the enricher can leave behind.
--   2. With NO transaction, kind may only be one of the log-decidable answers or
--      'unclassified'. 'buy' and 'transfer' REQUIRE a transaction, so the
--      database itself rejects the downgrade described above. With a transaction
--      present, 'unclassified' is conversely forbidden — the work was done, so
--      the row must carry its result.
--
-- INVARIANT NOT EXPRESSIBLE HERE, stated so it is not lost: a 'mints_only' run
-- stores EVERY decoded transfer, marking the undecidable ones 'unclassified'.
-- It must never store just the mints. If non-mint rows were absent instead of
-- unclassified there would be nothing for the gate to detect, `overlap` would
-- undercount against an apparently clean index, and an upgrade would have to
-- re-read the chain's logs rather than the tx_hashes already on disk.
CREATE TABLE IF NOT EXISTS transfers (
  chain_id     INTEGER NOT NULL,
  contract     TEXT    NOT NULL CHECK (contract = lower(contract)),
  token_id     TEXT    NOT NULL,   -- uint256 as TEXT: sorts lexicographically
  amount       TEXT    NOT NULL DEFAULT '1',
  from_addr    TEXT    NOT NULL CHECK (from_addr = lower(from_addr)),
  to_addr      TEXT    NOT NULL CHECK (to_addr = lower(to_addr)),
  tx_hash      TEXT    NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  -- 0 for ERC-721 and TransferSingle; array position for TransferBatch. An
  -- ERC-1155 TransferBatch is ONE log carrying ids[], so without this column
  -- every token after the first collides on the primary key and is dropped.
  batch_index  INTEGER NOT NULL DEFAULT 0,
  -- NULL means "transaction not fetched", never "sender unknown". See above.
  tx_from      TEXT    CHECK (tx_from IS NULL OR tx_from = lower(tx_from)),
  tx_value_wei TEXT,              -- uint256 as TEXT: sorts lexicographically
  kind         TEXT    NOT NULL CHECK (kind IN ('mint', 'buy', 'transfer',
                                                'burn', 'unclassified')),
  PRIMARY KEY (chain_id, tx_hash, log_index, batch_index),
  -- (1) Half a transaction is never a valid resting state.
  CHECK ((tx_from IS NULL) = (tx_value_wei IS NULL)),
  -- (2) buy and transfer require a transaction; unclassified forbids one.
  CHECK (CASE WHEN tx_from IS NULL
              THEN kind IN ('mint', 'burn', 'unclassified')
              ELSE kind <> 'unclassified'
         END),
  -- Enforced only while PRAGMA foreign_keys = ON, which SQLite defaults OFF per
  -- connection — see src/db/connection.ts.
  FOREIGN KEY (chain_id, contract)
    REFERENCES collections (chain_id, contract)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS transfers_contract_kind_pos
  ON transfers (contract, kind, block_number, log_index);

CREATE INDEX IF NOT EXISTS transfers_to_addr
  ON transfers (to_addr);

-- Partial index serving the two hot enrichment-state queries: the gate that
-- refuses an under-enriched `overlap`, and the upgrade that collects the
-- tx_hashes still needing a fetch. Partial so it costs nothing on a fully
-- enriched index, where it holds no rows at all.
CREATE INDEX IF NOT EXISTS transfers_unclassified
  ON transfers (chain_id, contract)
  WHERE kind = 'unclassified';
