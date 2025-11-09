exports.up = async function (knex) {
  // Drop FK + index if they exist
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_schema = 'core'
          AND table_name = 'items'
          AND constraint_name = 'items_owner_id_foreign'
      ) THEN
        ALTER TABLE core.items DROP CONSTRAINT items_owner_id_foreign;
      END IF;
    END $$;
  `);

  // Drop owner_id column (nullable guard in case you ran this before)
  const hasOwner = await knex.schema.withSchema('core').hasColumn('items', 'owner_id');
  if (hasOwner) {
    await knex.schema.withSchema('core').table('items', (t) => {
      t.dropColumn('owner_id');
    });
  }

  // Optional: add created_by for traceability but NOT enforced
  const hasCreatedBy = await knex.schema.withSchema('core').hasColumn('items', 'created_by');
  if (!hasCreatedBy) {
    await knex.schema.withSchema('core').table('items', (t) => {
      t.bigInteger('created_by').nullable(); // no FK constraint
    });
  }
};

exports.down = async function (knex) {
  // Re-add owner_id FK if you roll back
  const hasOwner = await knex.schema.withSchema('core').hasColumn('items', 'owner_id');
  if (!hasOwner) {
    await knex.schema.withSchema('core').table('items', (t) => {
      t.bigInteger('owner_id').notNullable();
    });
    await knex.raw(`
      ALTER TABLE core.items
      ADD CONSTRAINT items_owner_id_foreign
        FOREIGN KEY (owner_id) REFERENCES core.users(id) ON DELETE CASCADE;
    `);
  }

  // Remove created_by if it was added
  const hasCreatedBy = await knex.schema.withSchema('core').hasColumn('items', 'created_by');
  if (hasCreatedBy) {
    await knex.schema.withSchema('core').table('items', (t) => t.dropColumn('created_by'));
  }
};
