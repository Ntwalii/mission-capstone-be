// Adds "continent" to core.trade_partners, updates it using ref.regions_iso3.iso3

exports.up = async (knex) => {
  // Add the new column if missing
  const hasCol = await knex.schema.withSchema('core').hasColumn('trade_partners', 'continent');
  if (!hasCol) {
    await knex.schema.withSchema('core').table('trade_partners', (t) => {
      t.specificType('continent', 'continent_enum').nullable();
    });
  }

  // Backfill continent where iso3 matches
  await knex.raw(`
    UPDATE core.trade_partners tp
    SET continent = r.continent
    FROM ref.regions_iso3 r
    WHERE lower(tp.iso3) = lower(r.iso3);
  `);

  // Optional index for quick grouping
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_trade_partners_continent
    ON core.trade_partners (continent);
  `);
};

exports.down = async (knex) => {
  const hasCol = await knex.schema.withSchema('core').hasColumn('trade_partners', 'continent');
  if (hasCol) {
    await knex.schema.withSchema('core').table('trade_partners', (t) => {
      t.dropColumn('continent');
    });
  }
};
