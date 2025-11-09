exports.up = async function(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS core');
  await knex.raw("DO $$ BEGIN CREATE TYPE core.trade_direction AS ENUM ('import','export'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;");

  await knex.schema.withSchema('core').createTable('users', t => {
    t.bigIncrements('id').primary();
    t.text('email').notNullable().unique();
    t.text('full_name');
    t.text('provider');            // google | microsoft | password
    t.text('role').defaultTo('user');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('core').createTable('trade_partners', t => {
    t.bigIncrements('id').primary();
    t.specificType('iso3', 'char(3)').unique();
    t.text('name').notNullable();
    t.text('region');
  });
};

exports.down = async function(knex) {
  await knex.schema.withSchema('core').dropTableIfExists('trade_partners');
  await knex.schema.withSchema('core').dropTableIfExists('users');
  await knex.raw("DROP TYPE IF EXISTS core.trade_direction");
  await knex.raw("DROP SCHEMA IF EXISTS core CASCADE");
};
