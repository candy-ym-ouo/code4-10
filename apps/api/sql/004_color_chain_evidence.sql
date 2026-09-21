-- 颜色时间链：先后顺序、软删除与前后证据
-- seq 是批次内颜色变化的时间链位序（按 occurred_at 归位），唯一“当前色”永远取未删除记录中 seq 最大的一条。
CREATE TYPE attachment_phase AS ENUM ('GENERAL', 'BEFORE', 'AFTER');

ALTER TABLE attachments
  ADD COLUMN phase attachment_phase NOT NULL DEFAULT 'GENERAL';
-- 历史上颜色变化记录只能在事后上传图片，统一视为变化后证据。
UPDATE attachments SET phase = 'AFTER' WHERE owner_type = 'COLOR_CHANGE';

ALTER TABLE color_changes
  ADD COLUMN seq integer,
  ADD COLUMN before_color_explicit boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz;

-- 为存量记录按发生时间补排链序，同刻按录入先后。
WITH ordered AS (
  SELECT id,
         row_number() OVER (PARTITION BY batch_id ORDER BY occurred_at, created_at, id) AS new_seq
    FROM color_changes
)
UPDATE color_changes cc
   SET seq = ordered.new_seq
  FROM ordered
 WHERE cc.id = ordered.id;

ALTER TABLE color_changes ALTER COLUMN seq SET NOT NULL;

-- 仅对未删除记录强制链序唯一；误录软删除后保留原序位，新链归位不与之冲突。
CREATE UNIQUE INDEX color_changes_batch_seq_uq ON color_changes(batch_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX color_changes_batch_live_idx
  ON color_changes(batch_id, occurred_at DESC, seq DESC)
  WHERE deleted_at IS NULL;
DROP INDEX color_changes_batch_idx;
