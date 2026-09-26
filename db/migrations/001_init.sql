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
  last_indexed_block  INTEGER,
  indexed_at          INTEGER,   -- epoch ms
  locked_by           TEXT,
  locked_at           INTEGER,   -- epoch ms
  PRIMARY KEY (chain_id, contract)
);

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
  tx_from      TEXT    NOT NULL CHECK (tx_from = lower(tx_from)),
  tx_value_wei TEXT    NOT NULL,   -- uint256 as TEXT: sorts lexicographically
  kind         TEXT    NOT NULL CHECK (kind IN ('mint','buy','transfer','burn')),
  PRIMARY KEY (chain_id, tx_hash, log_index, batch_index),
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
