exports.seed = async function(knex) {
  // users (mirror from Auth; for demo we insert a placeholder user with id=1)
  await knex('core.users')
    .insert({ id: 1, email: 'demo@local', full_name: 'Demo User', provider: 'seed' })
    .onConflict('id').ignore();

  await knex('core.commodities')
    .insert([
      { code: 'CEREALS', name: 'Cereals (aggregate)', category: 'cereals', unit: 'ton' },
      { code: 'FERT',    name: 'Fertilizers (aggregate)', category: 'fertilizers', unit: 'ton' }
    ])
    .onConflict('code').ignore();

  await knex('core.trade_partners')
    .insert([
      { iso3: 'CHN', name: 'China', region: 'Asia' },
      { iso3: 'UGA', name: 'Uganda', region: 'EAC' }
    ])
    .onConflict('iso3').ignore();
};
