/**
 * VAULT v33 —— 宿主持有的外部推理任务。
 *
 * 持久化行只保留有界任务元数据；源内容在领取时由领域适配器组装，
 * 不复制进这张队列表。
 */
export const VAULT_0033_EXTERNAL_INFERENCE = `
CREATE TABLE external_inference_jobs (
  id               TEXT PRIMARY KEY,
  domain_kind      TEXT NOT NULL,
  domain_ref       TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'committed', 'failed', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_at INTEGER,
  prompt_version   TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  submission_id    TEXT,
  submission_digest TEXT,
  result_count     INTEGER,
  usage_tokens     INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(domain_kind, domain_ref)
);
CREATE INDEX idx_external_inference_state
  ON external_inference_jobs(state, lease_expires_at, created_at);
`
