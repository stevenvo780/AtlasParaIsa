# Workflow templates

`ci.yml` y `preview.yml` originalmente vivían en `.github/workflows/`. Se sacaron de la historia git (filter-branch) porque el token OAuth usado en el primer push no tenía scope `workflow` y GitHub rechazó el push.

Para reintroducirlos:

1. Refresca tu token GitHub con scope workflow:

   ```bash
   gh auth refresh -s workflow
   ```

2. Mueve los archivos a su lugar y commitea:

   ```bash
   mkdir -p .github/workflows
   cp docs/_workflow-templates/ci.yml .github/workflows/
   cp docs/_workflow-templates/preview.yml .github/workflows/
   git add .github/workflows
   git commit -m "ci: reintroducir workflows tras refrescar token"
   git push
   ```

3. Opcionalmente, borra estos templates de `docs/_workflow-templates/` si no piensas iterarlos aquí.

## Por qué están aquí

- `ci.yml`: typecheck + tests + builds del monorepo.
- `preview.yml`: deploy preview a Vercel. **Nota**: el autor decidió que el backend NO va a Vercel por consumo de cómputo. El preview deploy aplica solo a `apps/web`.
