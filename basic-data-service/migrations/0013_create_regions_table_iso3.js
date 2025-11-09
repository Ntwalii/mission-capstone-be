// migrations/0013_create_regions_table_iso3.js
// Creates ref.regions_iso3 with columns: id, iso3, country, continent (enum)
// Optionally preloads from data/ref/iso3_country_continent.csv
// CSV format (unquoted is fine; commas in country are supported):
//   ISO3,Country,Continent
//   COD,Congo, Democratic Republic of the,Africa
//   HKG,Hong Kong, China,Asia
//   USA,United States of America,North America

const fs = require('fs');
const path = require('path');

exports.up = async (knex) => {
  // Ensure schema
  await knex.raw('CREATE SCHEMA IF NOT EXISTS ref');

  // 1) continent enum
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'continent_enum') THEN
        CREATE TYPE continent_enum AS ENUM
          ('Africa','Europe','Asia','North America','South America','Oceania','Antarctica');
      END IF;
    END$$;
  `);

  // 2) table
  const exists = await knex.schema.withSchema('ref').hasTable('regions_iso3');
  if (!exists) {
    await knex.schema.withSchema('ref').createTable('regions_iso3', (t) => {
      t.increments('id').primary();
      t.string('iso3', 3).notNullable().unique();             // e.g., RWA, KEN
      t.text('country').notNullable();                        // display/official country name
      t.specificType('continent', 'continent_enum').notNullable();
    });
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_regions_iso3_iso3
      ON ref.regions_iso3 (iso3);
    `);
  }

  // 3) optional preload from CSV (robust: handles commas in country, BOM, comments)
  const csvPath = path.join(process.cwd(), 'data', 'ref', 'iso3_country_continent.csv');
  if (fs.existsSync(csvPath)) {
    const okContinents = new Set([
      'Africa', 'Europe', 'Asia', 'North America', 'South America', 'Oceania', 'Antarctica'
    ]);

    const lines = fs.readFileSync(csvPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    const rows = [];
    for (const rawLine of lines) {
      // strip UTF-8 BOM if present
      const line = rawLine.replace(/^\uFEFF/, '');
      const parts = line.split(',');
      if (parts.length < 3) continue; // malformed

      const iso3 = (parts.shift() || '').trim().toUpperCase(); // first token
      const continent = (parts.pop() || '').trim();            // last token
      const country = parts.join(',').trim();                   // everything in the middle

      if (!iso3 || !country || !continent) continue;
      if (iso3.length !== 3) continue;
      if (!okContinents.has(continent)) {
        throw new Error(`Invalid continent '${continent}' for '${iso3}, ${country}'.`);
      }

      rows.push({ iso3, country, continent });
    }

    if (rows.length) {
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        await knex('ref.regions_iso3')
          .insert(slice)
          .onConflict('iso3')
          .merge({
            country: knex.raw('EXCLUDED.country'),
            continent: knex.raw('EXCLUDED.continent')
          });
      }
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.withSchema('ref').dropTableIfExists('regions_iso3');
  await knex.raw(`DROP TYPE IF EXISTS continent_enum`);
};
