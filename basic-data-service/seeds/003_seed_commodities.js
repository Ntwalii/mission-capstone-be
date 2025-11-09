/* eslint-disable no-console */
exports.seed = async function (knex) {
  const rows = [
    { code: '0411', name: 'Wheat and meslin, unmilled' },
    { code: '042',  name: 'Rice, unmilled' },
    { code: '044',  name: 'Maize (corn) except sweet corn, unmilled' },
    { code: '045',  name: 'Cereal grains n.e.s., unmilled' },
    { code: '046',  name: 'Flour and meal of wheat and meslin' },
    { code: '047',  name: 'Cereal meal and flour n.e.s.' },
    { code: '0541', name: 'Potatoes, fresh (excl. sweet potatoes)' },
    { code: '0542', name: 'Vegetables, frozen (excl. leguminous)' },
    { code: '0545', name: 'Leguminous vegetables, dried (peas/beans/lentils)' },
    { code: '0546', name: 'Vegetables, preserved/prepared (pickled/canned)' },
    { code: '0548', name: 'Vegetables, fresh or chilled n.e.s.' },
    { code: '0571', name: 'Oranges, mandarins, clementines, etc.' },
    { code: '0572', name: 'Apples, pears and quinces, fresh' },
    { code: '0573', name: 'Bananas and plantains, fresh or dried' },
    { code: '0574', name: 'Dates, figs, pineapples, avocados, guavas, mangoes, etc.' },
    { code: '0575', name: 'Citrus fruit peel; melons etc.' },
    { code: '0576', name: 'Grapes, fresh or dried' },
    { code: '0577', name: 'Nuts (excluding oil nuts)' },
    { code: '0579', name: 'Fruits n.e.s., fresh or dried' },
    { code: '0581', name: 'Preserved fruit (excl. juices)' },
    { code: '0582', name: 'Fruit and vegetable juices' },
    { code: '0611', name: 'Raw sugars (cane or beet)' },
    { code: '0612', name: 'Beet sugar, raw' },
    { code: '062',  name: 'Sugar confectionery (no cocoa, incl. white chocolate)' },
    { code: '0711', name: 'Coffee, not roasted' },
    { code: '0712', name: 'Coffee, roasted' },
    { code: '0741', name: 'Tea, green (unfermented)' },
    { code: '0742', name: 'Tea, black (fermented or partly)' },
    { code: '2221', name: 'Soya beans, whether or not broken' },
    { code: '2222', name: 'Ground-nuts (peanuts), not roasted' },
    { code: '2231', name: 'Palm nuts and kernels' },
    { code: '2232', name: 'Copra' },
    { code: '2233', name: 'Sunflower seeds' },
    { code: '2239', name: 'Oil seeds and oleaginous fruits n.e.s.' },
    { code: '422',  name: 'Fixed vegetable fats and oils, crude/refined/fractionated' },
    { code: '423',  name: 'Processed fats and oils, animal or vegetable n.e.s.' },
    { code: '561',  name: 'Nitrogenous fertilizers' },
    { code: '562',  name: 'Phosphatic and potassic fertilizers' },
  ].map((r) => ({
    ...r,
    classification: 'SITC',
    category: 'agriculture',
    unit: null,
  }));

  await knex.raw('CREATE SCHEMA IF NOT EXISTS core');
  // Ensure unique constraint on code (only once; safe if exists)
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'commodities_code_key'
      ) THEN
        ALTER TABLE core.commodities ADD CONSTRAINT commodities_code_key UNIQUE (code);
      END IF;
    END $$;
  `);

  await knex('core.commodities')
    .insert(rows)
    .onConflict('code')
    .merge({
      name: knex.raw('EXCLUDED.name'),
      classification: knex.raw('EXCLUDED.classification'),
      category: knex.raw('EXCLUDED.category'),
      unit: knex.raw('EXCLUDED.unit'),
    });

  console.log(`✅ Seeded/updated ${rows.length} commodities`);
};
