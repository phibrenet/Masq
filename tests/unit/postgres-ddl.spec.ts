import { describe, expect, it } from 'vitest'
import { splitPostgresTableDdl } from '../../src/main/adapters/postgres-ddl'

describe('Postgres schema phases', () => {
  it('defers forward/composite FKs and triggers, retaining PKs and unique indexes', () => {
    const ddl = `CREATE TABLE app.child (id int, parent_id int, tenant_id int);
ALTER TABLE ONLY app.child ADD CONSTRAINT child_pk PRIMARY KEY (id);
CREATE UNIQUE INDEX child_pair ON app.child (id, tenant_id);
ALTER TABLE ONLY app.child ADD CONSTRAINT child_parent FOREIGN KEY (parent_id, tenant_id) REFERENCES app.parent(id, tenant_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER child_updated BEFORE UPDATE ON app.child FOR EACH ROW EXECUTE FUNCTION app.touch();
ALTER TABLE app.child ENABLE ALWAYS TRIGGER child_updated;
COMMENT ON TRIGGER child_updated ON app.child IS 'kept';
COMMENT ON CONSTRAINT child_parent ON app.child IS 'composite';`
    const parts = splitPostgresTableDdl(ddl)
    expect(parts.tableDdl).toContain('PRIMARY KEY (id)')
    expect(parts.tableDdl).toContain('CREATE UNIQUE INDEX')
    expect(parts.tableDdl).not.toContain('FOREIGN KEY')
    expect(parts.tableDdl).not.toContain('CREATE TRIGGER')
    expect(parts.deferredDdl).toHaveLength(5)
    expect(parts.deferredDdl[0]).toContain('DEFERRABLE INITIALLY DEFERRED;')
    expect(parts.deferredDdl[4]).toContain("IS 'composite';")
  })

  it('does not split semicolons or DDL-like text inside literals, names, comments or function bodies', () => {
    const ddl = `/* nested /* ; FOREIGN KEY */ comment */
CREATE TABLE "odd;table" (id int, note text DEFAULT 'ALTER TABLE x ADD CONSTRAINT y FOREIGN KEY; O''Brien');
COMMENT ON TABLE "odd;table" IS E'line\\'s; FOREIGN KEY';
CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  -- preserve this function comment;
  NEW.note := 'CREATE TRIGGER;'; RETURN NEW;
END;
$body$;
-- ; comment before an actual FK
ALTER TABLE ONLY "odd;table" ADD CONSTRAINT "key;name" FOREIGN KEY (id) REFERENCES app.parent(id);`
    const parts = splitPostgresTableDdl(ddl)
    expect(parts.tableDdl).toContain("NEW.note := 'CREATE TRIGGER;'; RETURN NEW;")
    expect(parts.tableDdl).toContain('preserve this function comment;')
    expect(parts.tableDdl).toContain('"odd;table"')
    expect(parts.deferredDdl).toHaveLength(1)
    expect(parts.deferredDdl[0]).toContain('CONSTRAINT "key;name" FOREIGN KEY')
  })
})
