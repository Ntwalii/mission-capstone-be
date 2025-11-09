// migrations/0010_trade_marts.js
exports.up = async (knex) => {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS marts');
  await knex.raw('CREATE SCHEMA IF NOT EXISTS ref');

  // region enum
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'region_enum') THEN
        CREATE TYPE region_enum AS ENUM
          ('CEPGL','COMESA','COMMON WEALTH','ECOWAS','SADC','EU');
      END IF;
    END$$;
  `);

  // simple lookup table so your seed works
  if (!(await knex.schema.withSchema('ref').hasTable('regions'))) {
    await knex.schema.withSchema('ref').createTable('regions', (t) => {
      t.increments('id').primary();
      t.text('code').notNullable().unique();
      t.text('name').notNullable();
    });
  }

  // ---------- marts.country_trade ----------
  if (!(await knex.schema.withSchema('marts').hasTable('country_trade'))) {
    await knex.schema.withSchema('marts').createTable('country_trade', (t) => {
      t.increments('id').primary();
      t.integer('countryId').notNullable();      // keep your casing
      t.integer('year').notNullable();
      t.smallint('quarter').notNullable();

      t.decimal('export',   20, 2).notNullable().defaultTo(0);
      t.decimal('import',   20, 2).notNullable().defaultTo(0);
      t.decimal('reexport', 20, 2).notNullable().defaultTo(0);

      t.decimal('total',        20, 2).notNullable().defaultTo(0);
      t.decimal('tradeBalance', 20, 2).notNullable().defaultTo(0);

      t.unique(['countryId', 'year', 'quarter']);
      // index via Knex -> quotes "countryId" correctly
      t.index(['year', 'quarter', 'countryId'], 'idx_country_trade_yq');
    });
    await knex.raw(`
      ALTER TABLE marts.country_trade
      ADD CONSTRAINT country_trade_quarter_chk CHECK (quarter BETWEEN 1 AND 4);
    `);
  }

  // ---------- marts.region_trade ----------
  if (!(await knex.schema.withSchema('marts').hasTable('region_trade'))) {
    await knex.schema.withSchema('marts').createTable('region_trade', (t) => {
      t.increments('id').primary();
      t.specificType('region', 'region_enum').notNullable();
      t.integer('year').notNullable();
      t.smallint('quarter').notNullable();

      t.decimal('export',   20, 2).notNullable().defaultTo(0);
      t.decimal('import',   20, 2).notNullable().defaultTo(0);
      t.decimal('reexport', 20, 2).notNullable().defaultTo(0);

      t.decimal('total',        20, 2).notNullable().defaultTo(0);
      t.decimal('tradeBalance', 20, 2).notNullable().defaultTo(0);

      t.unique(['region', 'year', 'quarter']);
      t.index(['year', 'quarter', 'region'], 'idx_region_trade_yq');
    });
    await knex.raw(`
      ALTER TABLE marts.region_trade
      ADD CONSTRAINT region_trade_quarter_chk CHECK (quarter BETWEEN 1 AND 4);
    `);
  }

  // ---------- marts.deepdata ----------
  if (!(await knex.schema.withSchema('marts').hasTable('deepdata'))) {
    await knex.schema.withSchema('marts').createTable('deepdata', (t) => {
      t.increments('id').primary();
      t.integer('year').notNullable();
      t.smallint('quarter').notNullable();

      t.decimal('export',   20, 2).notNullable().defaultTo(0);
      t.decimal('import',   20, 2).notNullable().defaultTo(0);
      t.decimal('reexport', 20, 2).notNullable().defaultTo(0);

      t.decimal('totalTrade',   20, 2).notNullable().defaultTo(0);
      t.decimal('tradeBalance', 20, 2).notNullable().defaultTo(0);

      t.unique(['year', 'quarter']);
      t.index(['year', 'quarter'], 'idx_deepdata_yq');
    });
    await knex.raw(`
      ALTER TABLE marts.deepdata
      ADD CONSTRAINT deepdata_quarter_chk CHECK (quarter BETWEEN 1 AND 4);
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.withSchema('marts').dropTableIfExists('deepdata');
  await knex.schema.withSchema('marts').dropTableIfExists('region_trade');
  await knex.schema.withSchema('marts').dropTableIfExists('country_trade');
  await knex.schema.withSchema('ref').dropTableIfExists('regions');
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'region_enum') THEN
        DROP TYPE region_enum;
      END IF;
    END$$;
  `);
};
