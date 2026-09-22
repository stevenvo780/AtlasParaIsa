#!/usr/bin/env bash
# Build y smoke del commit solicitado, fuera de los worktrees existentes.
# Uso: bash scripts/deploy-check.sh <SHA/ref> [directorio-informe-nuevo]
# El padre del informe explícito debe existir. Sin argumento se usa mktemp.
# Reutiliza node_modules; no instala dependencias, publica ni controla servicios.
# DEPLOY_CHECK_TIMEOUT_SECONDS limita cada gate (1..3600; por defecto 600).
set -euo pipefail
umask 077

fail() { echo "deploy-check.sh: $*" >&2; exit 1; }
[[ $# -ge 1 && $# -le 2 ]] || fail 'uso: <SHA/ref> [directorio-informe-nuevo]'
for command_name in git node npm timeout mktemp ps awk; do
  command -v "$command_name" >/dev/null || fail "falta el comando $command_name; no se instalará nada"
done
gate_timeout="${DEPLOY_CHECK_TIMEOUT_SECONDS:-600}"
[[ "$gate_timeout" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$gate_timeout" -le 3600 ] || fail 'DEPLOY_CHECK_TIMEOUT_SECONDS debe estar entre 1 y 3600'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# Ignorar el repo/cwd del invocador: el script pertenece a su propio repositorio.
git_clean=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -c core.hooksPath=/dev/null)
repo="$("${git_clean[@]}" -C "$script_dir" rev-parse --show-toplevel)"
git_repo=("${git_clean[@]}" -C "$repo")
revision="$("${git_repo[@]}" rev-parse --verify --end-of-options "${1}^{commit}")" || fail 'la revisión no resuelve a un commit local'
[[ -d "$repo/node_modules" ]] || fail "falta node_modules en $repo; no se instalará nada"
dependencies="$(cd -- "$repo/node_modules" && pwd -P)"

# /tmp no depende del TMPDIR del servidor. Comprobar también repositorios que
# estén alojados allí; nunca construir dentro de ningún worktree ya registrado.
sandbox="$(mktemp -d /tmp/atlas-deploy-check.XXXXXX)"
worktree="$sandbox/worktree"
report=''
phase=setup
build_exit=null
smoke_exit=null
gate_pid=''
worktree_add_attempted=false
cleanup_ok=true
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# El líder npm/timeout puede terminar dejando un nieto que ignora TERM. Mantener
# la propiedad del grupo hasta que no ejecute ningún miembro, también si su
# líder ya fue recogido por wait. Los zombis no ejecutan ni acceden al worktree.
gate_group_running() {
  ps -eo pid=,pgid=,stat= > "$sandbox/gate-processes" || return 2
  awk -v owned="$gate_pid" '($1 == owned || $2 == owned) && $3 !~ /^[ZX]/ { live=1 } END { exit !live }' "$sandbox/gate-processes"
}
wait_gate_group() {
  local tries="$1" attempt state
  for ((attempt=0; attempt<tries; attempt++)); do
    if gate_group_running; then sleep 0.1;
    else state=$?; if [[ "$state" == 1 ]]; then return 0; else return 2; fi; fi
  done
  return 1
}
stop_gate_group() {
  [[ -n "$gate_pid" ]] || return 0
  local state=0
  if gate_group_running; then
    kill -TERM -- "-$gate_pid" 2>/dev/null || true
    kill -TERM "$gate_pid" 2>/dev/null || true
    if wait_gate_group 50; then :;
    else
      state=$?
      if [[ "$state" == 1 ]]; then
        kill -KILL -- "-$gate_pid" 2>/dev/null || true
        kill -KILL "$gate_pid" 2>/dev/null || true
        if wait_gate_group 10; then state=0; else state=$?; fi
      fi
    fi
  else state=$?; if [[ "$state" == 1 ]]; then state=0; fi; fi
  if [[ "$state" != 0 ]]; then
    cleanup_ok=false
    echo "deploy-check.sh: no se confirmó el cierre del grupo propio $gate_pid; se conserva $sandbox" >&2
    return 1
  fi
  wait "$gate_pid" 2>/dev/null || true
  gate_pid=''
}

finish() {
  local code=$?
  trap - EXIT INT TERM
  stop_gate_group || true
  if [[ "$worktree_add_attempted" == true && "$cleanup_ok" == true ]]; then
    # Una señal puede llegar después de registrar el worktree y antes de que
    # `worktree add` devuelva el control. Consultar el registro real de ESTA ruta
    # exclusiva, sin podar registros ni forzar la retirada de worktrees ajenos.
    local entry registered=false
    if "${git_repo[@]}" worktree list --porcelain -z > "$sandbox/registered-worktrees" 2>> "$report/setup.log"; then
      while IFS= read -r -d '' entry; do
        if [[ "$entry" == "worktree $worktree" ]]; then registered=true; fi
      done < "$sandbox/registered-worktrees"
    else
      cleanup_ok=false
    fi
    if [[ "$registered" == true ]]; then
      if ! "${git_repo[@]}" worktree remove --force "$worktree" >> "$report/setup.log" 2>&1; then cleanup_ok=false; fi
    fi
    if [[ "$cleanup_ok" != true ]]; then
      echo "deploy-check.sh: no se pudo comprobar o retirar el worktree propio: $worktree" >&2
    fi
  fi
  if [[ "$cleanup_ok" == true ]]; then
    rm -rf -- "$sandbox" || cleanup_ok=false
  fi
  if [[ "$cleanup_ok" != true && "$code" == 0 ]]; then code=1; fi
  if [[ -n "$report" ]]; then
    if ! node - "$report/report.json" "$repo" "$revision" "$worktree" "$dependencies" "$phase" "$code" "$build_exit" "$smoke_exit" "$cleanup_ok" "$started_at" "$script_dir/deploy-check.sh" <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto');
const [file, repository, revision, worktree, dependencies, phase, code, build, smoke, cleanup, startedAt, helper] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  repository, revision, helperSha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
  dependencies, worktree, startedAt, finishedAt: new Date().toISOString(),
  status: Number(code) === 0 ? 'passed' : 'failed', phase, exitCode: Number(code),
  buildExitCode: JSON.parse(build), smokeExitCode: JSON.parse(smoke), cleanup: cleanup === 'true',
}, null, 2) + '\n', {mode: 0o600});
NODE
    then code=1; echo 'deploy-check.sh: no se pudo escribir report.json' >&2; fi
    echo "deploy-check.sh: resultado $code; informe y logs en $report"
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $# == 2 ]]; then
  report_candidate="$(node - "$2" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const target = path.resolve(process.argv[2]);
process.stdout.write(path.join(fs.realpathSync(path.dirname(target)), path.basename(target)));
NODE
  )"
else
  report_candidate=''
fi
while IFS= read -r -d '' entry; do
  [[ "$entry" == 'worktree '* ]] || continue
  existing="${entry#worktree }"
  case "$sandbox/" in "$existing/"*) fail "el temporal está dentro de un worktree existente: $existing";; esac
  for protected in "$existing/data" "$existing/dist"; do
    case "$report_candidate/" in "$protected/"*) fail "el informe no puede escribirse en $protected";; esac
  done
done < <("${git_repo[@]}" worktree list --porcelain -z)
if [[ -n "$report_candidate" ]]; then
  mkdir -m 700 -- "$report_candidate" || fail 'el directorio del informe debe ser nuevo'
  report="$report_candidate"
else
  report="$(mktemp -d /tmp/atlas-deploy-report.XXXXXX)"
fi
echo "deploy-check.sh: commit $revision; informe $report"
worktree_add_attempted=true
"${git_repo[@]}" worktree add --detach "$worktree" "$revision" > "$report/setup.log" 2>&1
ln -s -- "$dependencies" "$worktree/node_modules"
mkdir -m 700 -- "$sandbox/tmp" "$sandbox/data" "$sandbox/npm-cache"
: > "$sandbox/npm-user.conf"
: > "$sandbox/npm-global.conf"
# Un artefacto versionado de una ejecución anterior no acredita este smoke.
rm -f -- "$worktree/artifacts/smoke.json"

run_gate() {
  local name="$1" log="$2" code
  echo "deploy-check.sh: $name"
  (
    cd -- "$worktree"
    # No heredar contraseñas, NODE_OPTIONS, configuración npm privada ni rutas
    # de datos reales. El smoke genera su propia credencial aleatoria y mundo.
    exec timeout --kill-after=5s "${gate_timeout}s" env -i \
      PATH="$PATH" TMPDIR="$sandbox/tmp" TMP="$sandbox/tmp" TEMP="$sandbox/tmp" \
      CARTA_DATA_DIR="$sandbox/data" HOST=127.0.0.1 PORT=0 CARTA_ORIGIN=http://127.0.0.1 \
      CI=1 npm_config_cache="$sandbox/npm-cache" npm_config_offline=true \
      npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false \
      npm_config_userconfig="$sandbox/npm-user.conf" npm_config_globalconfig="$sandbox/npm-global.conf" \
      npm run "$name"
  ) > "$report/$log" 2>&1 &
  gate_pid=$!
  if wait "$gate_pid"; then code=0; else code=$?; fi
  if ! stop_gate_group; then
    if [[ "$code" == 0 ]]; then code=1; fi
  fi
  if [[ "$code" != 0 ]]; then echo "deploy-check.sh: $name falló ($code); consulta $report/$log" >&2; fi
  return "$code"
}

phase=build
if run_gate build build.log; then build_exit=0; else build_exit=$?; exit "$build_exit"; fi
phase=build-evidence
[[ -f "$worktree/dist/client/index.html" && -f "$worktree/dist/server/server/main.js" ]] || fail 'build terminó sin los entrypoints esperados'
phase=smoke
if run_gate test:smoke smoke.log; then smoke_exit=0; else smoke_exit=$?; exit "$smoke_exit"; fi
phase=smoke-evidence
node - "$worktree/artifacts/smoke.json" "$report/smoke.json" <<'NODE'
const fs = require('node:fs');
const body = fs.readFileSync(process.argv[2], 'utf8'), report = JSON.parse(body);
for (const key of ['builtEntrypoint', 'credentialCli', 'privateHttp', 'autonomousAdvance', 'sigkillRestart', 'persistedSession', 'revocationCli', 'gracefulExit']) {
  if (report[key] !== true) throw new Error(`Smoke incompleto: ${key}`);
}
fs.writeFileSync(process.argv[3], body, {mode: 0o600});
NODE
phase=complete
