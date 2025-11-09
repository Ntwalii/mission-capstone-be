exports.up = async function(knex) {
  await knex.schema.withSchema('core').createTable('commodities', t => {
    t.bigIncrements('id').primary();
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
    t.text('category');
    t.text('unit');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('core').createTable('trade_data', t => {
    t.bigIncrements('id').primary();
    t.bigInteger('commodity_id').notNullable().references('id').inTable('core.commodities').onDelete('RESTRICT');
    t.bigInteger('partner_id').references('id').inTable('core.trade_partners').onDelete('SET NULL');
    t.specificType('direction', 'core.trade_direction').notNullable();
    t.date('period_month').notNullable();
    t.decimal('value_usd', 18, 2).notNullable();
    t.decimal('quantity', 18, 4);
    t.text('unit');
    t.text('source');
    t.integer('revision').defaultTo(1);
    t.timestamp('loaded_at', { useTz: true }).defaultTo(knex.fn.now());
    t.unique(['commodity_id', 'direction', 'period_month', 'partner_id', 'revision']);
  });

  await knex.schema.withSchema('core').createTable('items', t => {
    t.bigIncrements('id').primary();
    t.bigInteger('owner_id').notNullable().references('id').inTable('core.users').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.jsonb('tags').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_trade_data_commodity_time_dir
                  ON core.trade_data (commodity_id, period_month, direction)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_trade_data_time ON core.trade_data (period_month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_items_owner ON core.items (owner_id)`);
};

exports.down = async function(knex) {
  await knex.schema.withSchema('core').dropTableIfExists('items');
  await knex.schema.withSchema('core').dropTableIfExists('trade_data');
  await knex.schema.withSchema('core').dropTableIfExists('commodities');
};
