-- 颜色变化时间链：
-- 1) seq 为批次内单调递增序号，用于同一 occurred_at 的确定性排序，保证“唯一当前色”
-- 2) 作废（误录）采用软删除，行与附件全部保留，时间链不被物理删除破坏
-- 3) 附件可标记为变化前/变化后证据

CREATE TYPE attachment_phase AS ENUM ('BEFORE', 'AFTER');

ALTER TABLE color_changes
  ADD COLUMN seq bigint,
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES users(id),
  ADD COLUMN void_reason varchar(300),
  ADD CONSTRAINT color_changes_void_chk
  CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by IS NOT NULL));

ALTER TABLE attachments ADD COLUMN phase attachment_phase;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_color_phase_chk
  CHECK (owner_type <> 'COLOR_CHANGE' OR phase IS NOT NULL);

-- 每个批次独立的 seq 序列；新批次创建时自动建序列（见触发器）
CREATE OR REPLACE FUNCTION color_changes_batch_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT nextval(%L)', '"color_changes_batch_' || NEW.batch_id::text || '"') INTO NEW.seq;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION create_color_changes_batch_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', 'color_changes_batch_' || NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER batches_create_color_seq AFTER INSERT ON batches
FOR EACH ROW EXECUTE FUNCTION create_color_changes_batch_seq();

-- 为已有批次补建序列
DO $$
DECLARE batch uuid;
BEGIN
  FOR batch IN SELECT id FROM batches LOOP
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', 'color_changes_batch_' || batch::text);
  END LOOP;
END;
$$;

-- 回填历史数据：按批次、发生时间、录入时间排序后分配 seq
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY batch_id ORDER BY occurred_at ASC, created_at ASC, id ASC) AS rn
  FROM color_changes
)
UPDATE color_changes cc SET seq = ordered.rn
FROM ordered
WHERE cc.id = ordered.id;

-- 各批次序列推进到当前最大 seq；空批次序列保持初始值
DO $$
DECLARE batch uuid; max_seq bigint;
BEGIN
  FOR batch, max_seq IN SELECT batch_id, max(seq) FROM color_changes GROUP BY batch_id LOOP
    EXECUTE format('SELECT setval(%L, %s)', '"color_changes_batch_' || batch::text || '"', max_seq);
  END LOOP;
END;
$$;

ALTER TABLE color_changes ALTER COLUMN seq SET NOT NULL;

CREATE TRIGGER color_changes_assign_seq BEFORE INSERT ON color_changes
FOR EACH ROW WHEN (NEW.seq IS NULL) EXECUTE FUNCTION color_changes_batch_seq();

-- 批次内 seq 唯一，作为时间链的稳定排序键
CREATE UNIQUE INDEX color_changes_batch_seq_uq ON color_changes(batch_id, seq);

DROP INDEX IF EXISTS color_changes_batch_idx;
CREATE INDEX color_changes_batch_idx ON color_changes(batch_id, occurred_at DESC, seq DESC);
-- 当前色重算只读取有效记录，用局部索引加速
CREATE INDEX color_changes_batch_active_idx ON color_changes(batch_id, occurred_at DESC, seq DESC) WHERE voided_at IS NULL;

-- 已归档批次的颜色时间线在数据库层只读：
-- 禁止新增；更新只允许备注类字段与“标记作废”，禁止改动颜色/时间，禁止恢复作废记录。
CREATE OR REPLACE FUNCTION enforce_archived_batch_color_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  archived boolean;
BEGIN
  SELECT status = 'ARCHIVED' INTO archived FROM batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF archived THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION '已归档批次不能新增颜色变化' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.voided_at IS NULL AND OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION '已归档批次不能恢复已作废的颜色记录' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
         OR NEW.change_type IS DISTINCT FROM OLD.change_type
         OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
         OR NEW.after_color_name IS DISTINCT FROM OLD.after_color_name
         OR NEW.after_color_hex IS DISTINCT FROM OLD.after_color_hex
         OR NEW.before_color_name IS DISTINCT FROM OLD.before_color_name
         OR NEW.before_color_hex IS DISTINCT FROM OLD.before_color_hex THEN
        RAISE EXCEPTION '已归档批次的颜色记录为只读' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER color_changes_archived_readonly
  BEFORE INSERT OR UPDATE ON color_changes
  FOR EACH ROW EXECUTE FUNCTION enforce_archived_batch_color_readonly();
