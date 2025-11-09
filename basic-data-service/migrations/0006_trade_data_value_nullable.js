// migrations/0006_trade_data_value_nullable.js
exports.up = async (knex) => {
  await knex.raw(`ALTER TABLE core.trade_data ALTER COLUMN value_usd DROP NOT NULL;`);
};
exports.down = async (knex) => {
  await knex.raw(`ALTER TABLE core.trade_data ALTER COLUMN value_usd SET NOT NULL;`);
};
