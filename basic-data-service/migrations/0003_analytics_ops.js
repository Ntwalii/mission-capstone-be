exports.up = async function (knex) {
  // Schemas
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');
  await knex.raw('CREATE SCHEMA IF NOT EXISTS ops');

  // Enums (idempotent)
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE analytics.model_type AS ENUM ('arima','prophet','lstm');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE analytics.anomaly_method AS ENUM ('isolation_forest','one_class_svm','z_score');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE analytics.anomaly_status AS ENUM ('new','confirmed','ignored','resolved');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE ops.notification_status AS ENUM ('queued','sent','failed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // Tables
  await knex.schema.withSchema('analytics').createTable('forecast_runs', (t) => {
    t.bigIncrements('id').primary();
    t.specificType('model', 'analytics.model_type').notNullable(); // <-- reference enum
    t.date('training_start').notNullable();
    t.date('training_end').notNullable();
    t.jsonb('params');
    t.jsonb('metrics');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.bigInteger('created_by').references('id').inTable('core.users');
  });

  await knex.schema.withSchema('analytics').createTable('forecasts', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('run_id').notNullable()
      .references('id').inTable('analytics.forecast_runs').onDelete('CASCADE');
    t.bigInteger('commodity_id').notNullable()
      .references('id').inTable('core.commodities').onDelete('RESTRICT');
    t.specificType('direction', 'core.trade_direction').notNullable(); // <-- reference enum from core
    t.date('forecast_date').notNullable();
    t.date('target_period').notNullable();
    t.decimal('yhat', 18, 4).notNullable();
    t.decimal('yhat_lower', 18, 4);
    t.decimal('yhat_upper', 18, 4);
    t.integer('horizon_months').notNullable();
    t.integer('version').defaultTo(1);
    t.unique(['run_id','commodity_id','direction','target_period']);
  });

  await knex.schema.withSchema('analytics').createTable('anomalies', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('commodity_id').notNullable()
      .references('id').inTable('core.commodities').onDelete('RESTRICT');
    t.specificType('direction', 'core.trade_direction').notNullable();
    t.date('period_month').notNullable();
    t.specificType('method', 'analytics.anomaly_method').notNullable();
    t.decimal('score', 12, 6);
    t.smallint('severity'); // optional CHECK can be added if you want 1..5
    t.specificType('status', 'analytics.anomaly_status').defaultTo('new');
    t.text('note');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.unique(['commodity_id','direction','period_month','method']);
  });

  await knex.schema.withSchema('analytics').createTable('reports', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable()
      .references('id').inTable('core.users').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.jsonb('config').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('ops').createTable('notifications', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').notNullable()
      .references('id').inTable('core.users').onDelete('CASCADE');
    t.text('channel').notNullable(); // 'email' | 'webpush' | ...
    t.jsonb('payload').notNullable();
    t.specificType('status', 'ops.notification_status').defaultTo('queued');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true });
  });
};

exports.down = async function (knex) {
  // Drop tables first
  await knex.schema.withSchema('ops').dropTableIfExists('notifications');
  await knex.schema.withSchema('analytics').dropTableIfExists('reports');
  await knex.schema.withSchema('analytics').dropTableIfExists('anomalies');
  await knex.schema.withSchema('analytics').dropTableIfExists('forecasts');
  await knex.schema.withSchema('analytics').dropTableIfExists('forecast_runs');

  // Optionally drop enums & schemas (safe in dev)
  await knex.raw("DO $$ BEGIN DROP TYPE IF EXISTS ops.notification_status; EXCEPTION WHEN undefined_object THEN NULL; END $$;");
  await knex.raw("DO $$ BEGIN DROP TYPE IF EXISTS analytics.anomaly_status; EXCEPTION WHEN undefined_object THEN NULL; END $$;");
  await knex.raw("DO $$ BEGIN DROP TYPE IF EXISTS analytics.anomaly_method; EXCEPTION WHEN undefined_object THEN NULL; END $$;");
  await knex.raw("DO $$ BEGIN DROP TYPE IF EXISTS analytics.model_type; EXCEPTION WHEN undefined_object THEN NULL; END $$;");
  await knex.raw('DROP SCHEMA IF EXISTS ops CASCADE');
  await knex.raw('DROP SCHEMA IF EXISTS analytics CASCADE');
};
