exports.up = async function (knex) {
  // --- commodities: add classification & chapter --------------------
  const hasClass = await knex.schema.withSchema('core').hasColumn('commodities', 'classification');
  if (!hasClass) {
    await knex.schema.withSchema('core').table('commodities', (t) => {
      t.text('classification').notNullable().defaultTo('SITC'); // or 'HS'
      t.text('chapter');                                        // optional
    });
  }

  // --- trade_partners: ensure ISO3 index -----------------------------
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='core' AND indexname='idx_trade_partners_iso3'
      ) THEN
        CREATE UNIQUE INDEX idx_trade_partners_iso3 ON core.trade_partners(iso3);
      END IF;
    END $$;
  `);

  // --- trade_data: add columns explicitly ----------------------------
  const addCol = async (name, builderFn) => {
    const exists = await knex.schema.withSchema('core').hasColumn('trade_data', name);
    if (!exists) {
      await knex.schema.withSchema('core').table('trade_data', builderFn);
    }
  };

  await addCol('reporter_id', (t) =>
    t.bigInteger('reporter_id').references('id').inTable('core.trade_partners').onDelete('SET NULL')
  );

  await addCol('trade_flow_code', (t) => t.smallint('trade_flow_code'));

  await addCol('period_year', (t) => t.integer('period_year'));

  await addCol('quantity_unit', (t) => t.text('quantity_unit'));

  await addCol('source_job_id', (t) => t.text('source_job_id'));
  await addCol('source_file',   (t) => t.text('source_file'));

  // Helpful indexes
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='core' AND indexname='idx_trade_data_year'
      ) THEN
        CREATE INDEX idx_trade_data_year ON core.trade_data(period_year);
      END IF;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='core' AND indexname='idx_trade_data_reporter'
      ) THEN
        CREATE INDEX idx_trade_data_reporter ON core.trade_data(reporter_id);
      END IF;
    END $$;
  `);

  // Backfill period_year from period_month when present
  await knex.raw(`
    UPDATE core.trade_data
       SET period_year = EXTRACT(YEAR FROM period_month)::int
     WHERE period_month IS NOT NULL
       AND period_year IS NULL;
  `);
};

exports.down = async function (knex) {
  // drop new columns (if they exist)
  const dropIfExists = async (name) => {
    const exists = await knex.schema.withSchema('core').hasColumn('trade_data', name);
    if (exists) {
      await knex.schema.withSchema('core').table('trade_data', (t) => t.dropColumn(name));
    }
  };
  await dropIfExists('reporter_id');
  await dropIfExists('trade_flow_code');
  await dropIfExists('period_year');
  await dropIfExists('quantity_unit');
  await dropIfExists('source_job_id');
  await dropIfExists('source_file');

  const hasClass = await knex.schema.withSchema('core').hasColumn('commodities', 'classification');
  if (hasClass) {
    await knex.schema.withSchema('core').table('commodities', (t) => {
      t.dropColumn('classification');
      t.dropColumn('chapter');
    });
  }

  await knex.raw(`DROP INDEX IF EXISTS core.idx_trade_data_year;`);
  await knex.raw(`DROP INDEX IF EXISTS core.idx_trade_data_reporter;`);
  // keep idx_trade_partners_iso3
};
