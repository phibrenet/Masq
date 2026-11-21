import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from '@shared/types'
import { getDb } from '../../src/main/config/db'
import { runMigrations } from '../../src/main/config/migrate'
import { createWorkspace } from '../../src/main/config/repositories/workspaces'
import { setTableClassification } from '../../src/main/config/repositories/table-classifications'
import { createSelectionRule } from '../../src/main/config/repositories/selection-rules'
import { createFieldStrategy } from '../../src/main/config/repositories/field-strategies'
import { createKnex } from '../../src/main/adapters/knex-factory'
import { PostgresAdapter } from '../../src/main/adapters/postgres'
import { executePipeline } from '../../src/main/extract/run'

const port = Number(process.env.MASQ_PG_SCHEMA_TEST_PORT)
describe.skipIf(!port)('Postgres phased schema restore (disposable fixture)', () => {
  let directory: string
  let admin: Client
  let target: Client
  let db: ReturnType<typeof createKnex>
  const connection: Connection = {
    id: 'fixture',
    workspaceId: 'fixture',
    label: 'Synthetic schema source',
    dialect: 'postgres',
    role: 'source',
    host: '127.0.0.1',
    port,
    username: 'postgres',
    database: 'masq_schema_fixture',
    searchPath: 'source, shadow'
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'masq-pg-schema-'))
    process.env.MASQ_TEST_USERDATA = directory
    runMigrations()
    const config = {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: 'masq-schema-fixture',
      database: 'masq_schema_fixture'
    }
    admin = new Client(config)
    await admin.connect()
    await admin.query('DROP DATABASE IF EXISTS masq_schema_restore')
    await admin.query('CREATE DATABASE masq_schema_restore')
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'masq_schema_owner') THEN
        CREATE ROLE masq_schema_owner NOSUPERUSER NOLOGIN;
      END IF;
    END $$; GRANT CREATE ON DATABASE masq_schema_restore TO masq_schema_owner;`)
    target = new Client({ ...config, database: 'masq_schema_restore' })
    await target.connect()
    await admin.query(`
      DROP SCHEMA IF EXISTS source CASCADE; DROP SCHEMA IF EXISTS shadow CASCADE; DROP SCHEMA IF EXISTS helpers CASCADE;
      CREATE SCHEMA source; CREATE SCHEMA shadow; CREATE SCHEMA helpers;
      CREATE TABLE source.child (id int PRIMARY KEY, parent_id int, tenant_id int, email text);
      CREATE TABLE source.parent (id int PRIMARY KEY, child_id int, tenant_id int, email text, UNIQUE (id, tenant_id));
      ALTER TABLE source.child ADD CONSTRAINT child_parent FOREIGN KEY (parent_id, tenant_id) REFERENCES source.parent(id, tenant_id);
      ALTER TABLE source.parent ADD CONSTRAINT parent_child FOREIGN KEY (child_id) REFERENCES source.child(id);
      CREATE FUNCTION helpers.touch() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        -- This comment and the internal semicolons must survive the export.
        NEW.email := upper(NEW.email); RETURN NEW;
      END;
      $body$;
      CREATE TRIGGER child_touch BEFORE INSERT ON source.child FOR EACH ROW EXECUTE FUNCTION helpers.touch();
      CREATE TRIGGER parent_touch BEFORE UPDATE ON source.parent FOR EACH ROW EXECUTE FUNCTION helpers.touch();
      CREATE TABLE source.excluded (id int PRIMARY KEY);
      CREATE FUNCTION helpers.excluded_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE TRIGGER excluded_touch BEFORE INSERT ON source.excluded FOR EACH ROW EXECUTE FUNCTION helpers.excluded_only();
      CREATE TABLE shadow.child (id int PRIMARY KEY);
      CREATE TRIGGER shadow_touch BEFORE INSERT ON shadow.child FOR EACH ROW EXECUTE FUNCTION helpers.excluded_only();
      CREATE TABLE source.builtin (id int PRIMARY KEY, body text, search_vector tsvector);
      CREATE TRIGGER builtin_search BEFORE INSERT OR UPDATE ON source.builtin FOR EACH ROW
        EXECUTE FUNCTION pg_catalog.tsvector_update_trigger(search_vector, 'pg_catalog.english', body);
      CREATE TRIGGER builtin_noop BEFORE UPDATE ON source.builtin FOR EACH ROW
        EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger();
      SET session_replication_role = replica;
      INSERT INTO source.child VALUES (1,2,7,'sensitive-child@fixture.test');
      INSERT INTO source.parent VALUES (2,1,7,'sensitive-parent@fixture.test');
      SET session_replication_role = origin;
    `)
    db = createKnex(connection, 'masq-schema-fixture')
  })
  afterAll(async () => {
    await db?.destroy()
    await target?.end()
    await admin?.end()
    if (directory) {
      getDb().close()
      delete process.env.MASQ_TEST_USERDATA
      rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const mode of ['combined', 'split'] as const)
    for (const dropExistingTables of [false, true]) {
      it(`${mode}, drops ${dropExistingTables}: restores cyclic/composite FKs and working trigger functions into an empty DB`, async () => {
        await target.query(
          'DROP SCHEMA IF EXISTS source CASCADE; DROP SCHEMA IF EXISTS helpers CASCADE; DROP SCHEMA IF EXISTS shadow CASCADE'
        )
        const ws = createWorkspace({
          name: `Schema ${mode} ${dropExistingTables}`,
          dumpOutputMode: mode,
          dropExistingTables
        })
        setTableClassification({ workspaceId: ws.id, tableName: 'excluded', class: 'excluded' })
        for (const table of ['child', 'parent']) {
          setTableClassification({ workspaceId: ws.id, tableName: table, class: 'transactional' })
          createSelectionRule({
            workspaceId: ws.id,
            table,
            match: 'all',
            where: [],
            take: { kind: 'all' },
            anonymize: true
          })
          createFieldStrategy({
            workspaceId: ws.id,
            tableName: table,
            columnName: 'email',
            rule: { kind: 'fake', generator: 'exampleEmail' }
          })
        }
        const adapter = new PostgresAdapter(db, {
          schemas: ['source', 'shadow'],
          host: connection.host,
          port,
          database: connection.database!,
          username: 'postgres',
          password: 'masq-schema-fixture'
        })
        const functions = await adapter.getTriggerFunctions(['builtin', 'child', 'parent'])
        expect(functions).toHaveLength(1)
        expect(functions[0].schema).toBe('helpers')
        expect(functions[0].ddl).toContain('This comment and the internal semicolons')
        const result = await executePipeline(adapter, connection, ws.id, directory, [])
        const files =
          mode === 'combined'
            ? [result.outputFiles.combined!]
            : [result.outputFiles.schema!, result.outputFiles.data!]
        const sql = files.map((file) => readFileSync(file, 'utf8'))
        expect(sql.join('\n')).not.toContain('sensitive-child@fixture.test')
        expect(sql.join('\n')).not.toContain('sensitive-parent@fixture.test')
        expect(sql.join('\n')).not.toContain('excluded_only')
        expect(sql[0]).toContain('EXECUTE FUNCTION tsvector_update_trigger')
        expect(sql[0]).not.toMatch(
          /CREATE OR REPLACE FUNCTION (?:"?pg_catalog"?\.)?(?:tsvector_update_trigger|suppress_redundant_updates_trigger)/
        )
        expect(sql[0].indexOf('CREATE TABLE source.parent')).toBeLessThan(
          sql[0].indexOf('ADD CONSTRAINT child_parent FOREIGN KEY')
        )
        expect(sql[0].indexOf('CREATE OR REPLACE FUNCTION helpers.touch')).toBeLessThan(
          sql[0].indexOf('CREATE TRIGGER child_touch')
        )
        for (const content of sql) await target.query(content)
        if (dropExistingTables) for (const content of sql) await target.query(content)
        const constraints = await target.query(
          "SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND connamespace='source'::regnamespace"
        )
        expect(constraints.rows[0].n).toBe(2)
        await expect(
          target.query("INSERT INTO source.child VALUES (9,999,7,'invalid@example.com')")
        ).rejects.toThrow(/foreign key constraint/)
        await target.query("INSERT INTO source.child VALUES (3,2,7,'lower@example.com')")
        expect(
          (await target.query('SELECT email FROM source.child WHERE id=3')).rows[0].email
        ).toBe('LOWER@EXAMPLE.COM')
      }, 30_000)
    }

  it('restores schema containing built-in triggers as a non-superuser without changing catalog functions', async () => {
    await target.query(
      'DROP SCHEMA IF EXISTS source CASCADE; DROP SCHEMA IF EXISTS helpers CASCADE; DROP SCHEMA IF EXISTS shadow CASCADE'
    )
    const ws = createWorkspace({
      name: 'Built-in trigger schema',
      dumpOutputMode: 'split',
      dropExistingTables: false
    })
    for (const tableName of ['child', 'parent', 'builtin'])
      setTableClassification({ workspaceId: ws.id, tableName, class: 'structure' })
    setTableClassification({ workspaceId: ws.id, tableName: 'excluded', class: 'excluded' })
    const adapter = new PostgresAdapter(db, {
      schemas: ['source', 'shadow'],
      host: connection.host,
      port,
      database: connection.database!,
      username: 'postgres',
      password: 'masq-schema-fixture'
    })
    expect(await adapter.getTriggerFunctions(['builtin'])).toEqual([])
    const result = await executePipeline(adapter, connection, ws.id, directory, [])
    const schema = readFileSync(result.outputFiles.schema!, 'utf8')
    const builtins = `SELECT p.oid, p.xmin::text AS version FROM pg_proc p
      WHERE p.oid IN ('pg_catalog.tsvector_update_trigger()'::regprocedure, 'pg_catalog.suppress_redundant_updates_trigger()'::regprocedure) ORDER BY p.oid`
    const before = (await target.query(builtins)).rows
    await target.query('SET ROLE masq_schema_owner')
    try {
      expect((await target.query('SELECT current_user')).rows[0].current_user).toBe(
        'masq_schema_owner'
      )
      await target.query(schema)
      await target.query("INSERT INTO source.builtin (id, body) VALUES (1, 'searchable words')")
      expect(
        (await target.query('SELECT search_vector::text AS vector FROM source.builtin')).rows[0]
          .vector
      ).toContain('searchabl')
      expect(
        (await target.query('UPDATE source.builtin SET body=body WHERE id=1 RETURNING id')).rowCount
      ).toBe(0)
      expect((await target.query(builtins)).rows).toEqual(before)
    } finally {
      await target.query('RESET ROLE')
    }
  }, 30_000)
})
