# AGENTS

## ORM Migration Rule

- In projects that use an ORM or schema tool, handwritten migration files are prohibited by default.
- Update the schema source first, then generate migrations with the project's official CLI or generator.
- If a handwritten migration is added by mistake, remove it and regenerate the migration from schema changes.
- Only write a migration by hand when the user explicitly asks for it and the generator cannot express the required change.
