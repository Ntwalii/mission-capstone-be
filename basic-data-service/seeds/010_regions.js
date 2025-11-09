exports.seed = async function (knex) {
  const rows = [
    { code: 'CEPGL',        name: 'CEPGL' },
    { code: 'COMESA',       name: 'COMESA' },
    { code: 'COMMONWEALTH', name: 'Commonwealth' },
    { code: 'ECOWAS',       name: 'ECOWAS' },
    { code: 'SADC',         name: 'SADC' },
    { code: 'EU',           name: 'European Union' },
  ];
  await knex('ref.regions')
    .insert(rows)
    .onConflict('code')
    .merge({ name: knex.raw('EXCLUDED.name') });
};
